import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { SignJWT, jwtVerify } from "jose";
import { hash, compare } from "bcryptjs";
import { sql } from "drizzle-orm";
import { postgresFixture } from "./helpers/postgres.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import { createPublicAuthRouter } from "../src/routes/public-auth.ts";
import { registerAccountStatement } from "../src/db/queries/register-account.ts";
import { reserveAuthBudget } from "../src/db/queries/auth-budget.ts";
import {
  openSessionStatement,
  activeSessionStatement,
} from "../src/db/queries/session-statements.ts";
import {
  createPeerResolver,
  trustedProxyAddresses,
} from "../src/lib/request-peer.ts";
import { authPairKey, authPeerKey } from "../src/lib/auth-budget.ts";
import {
  createTelemetry,
  requestTelemetry,
  createEventLogger,
} from "../src/observability/telemetry.ts";
const requestRecords = [];

const postgres = postgresFixture({ prefix: "auth" });
const secret = "public-auth-production-fixture-key-32";
const jwtKey = new TextEncoder().encode(secret);
const store = {
  execute: async (statement) => {
    const output = await postgres.query(statement);
    return output ? output.split("\n").map((row) => JSON.parse(row)) : [];
  },
};
const raw = (text) => postgres.query(sql.raw(text));
const servers = [],
  bases = [],
  events = [];
let passwordHash,
  beforeSession = async () => {},
  storageFailure = false;
async function findUser(email) {
  const rows =
    await store.execute(sql`select json_build_object('id',id,'email',email,'passwordHash',password_hash,'credentialVersion',credential_version,
    'name',name,'role',role,'phone',phone,'avatar',avatar,'isEmailVerified',is_email_verified,'isActive',is_active) as result from users where email=${email}`);
  return rows[0] ?? null;
}
async function openSession(user) {
  await beforeSession();
  const id = randomUUID().replaceAll("-", "").slice(0, 21);
  if (
    !(await postgres.query(
      openSessionStatement(id, user.id, user.credentialVersion, 3600),
    ))
  )
    return null;
  const accessToken = await new SignJWT({
    type: "access",
    role: user.role,
    sid: id,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(jwtKey);
  const refreshToken = await new SignJWT({
    type: "refresh",
    sid: id,
    generation: 0,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(jwtKey);
  return { accessToken, refreshToken, maxAge: 3600 };
}
const login = (
  base,
  email = "member@example.test",
  password = "OriginalPassword1",
  headers = {},
) =>
  fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email, password }),
  });
const registration = (base, email = "new@example.test", role = "business") =>
  fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: "NewPassword2",
      name: "New Member",
      role,
      businessName: "New Business",
    }),
  });
before(async () => {
  await postgres.start();
  await runMigrations(
    {
      execute: async (statement) =>
        JSON.parse(
          await postgres.query(
            sql`select coalesce(json_agg(r),'[]') from (${statement}) r`,
          ),
        ),
      transaction: async (statements) => {
        await postgres.query(
          sql.join(
            [sql.raw("begin"), ...statements, sql.raw("commit")],
            sql.raw(";\n"),
          ),
        );
      },
    },
    fileURLToPath(new URL("../drizzle", import.meta.url)),
  );
  passwordHash = await hash("OriginalPassword1", 12);
  for (const proxies of ["", "", "127.0.0.1"]) {
    const app = new Hono();
    app.use(
      "*",
      requestTelemetry(
        createTelemetry(),
        createEventLogger((line) => requestRecords.push(JSON.parse(line))),
      ),
    );
    app.route(
      "/auth",
      createPublicAuthRouter({
        store: {
          execute: (statement) => {
            if (storageFailure) throw new Error("private storage credentials");
            return store.execute(statement);
          },
        },
        secret,
        peer: createPeerResolver(
          (c) => getConnInfo(c).remote.address,
          trustedProxyAddresses(proxies),
        ),
        findUser,
        register: async (input, hash) => {
          const id = randomUUID();
          const rows = await store.execute(
            registerAccountStatement(id, randomUUID(), input, hash),
          );
          return rows.length ? findUser(input.email) : null;
        },
        openSession,
        secureCookies: true,
        record: (event) => events.push(event),
      }),
    );
    app.get("/auth/unrelated", (c) => c.json({ ok: true }));
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    servers.push(server);
    await once(server, "listening");
    bases.push(`http://127.0.0.1:${server.address().port}`);
  }
});
after(async () => {
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await postgres.stop();
});
beforeEach(async () => {
  storageFailure = false;
  beforeSession = async () => {};
  events.length = 0;
  requestRecords.length = 0;
  await raw(
    "truncate users,auth_sessions,account_actions,account_action_limits cascade",
  );
  await postgres.query(sql`insert into users(id,email,password_hash,name,role,is_active) values
    ('member','member@example.test',${passwordHash},'Member','customer',true),('inactive','inactive@example.test',${passwordHash},'Inactive','business',false)`);
});

test("login verifies bcrypt, opens a durable signed session and returns only public user fields", async () => {
  const response = await login(bases[0], " MEMBER@example.test ");
  assert.equal(response.status, 200);
  assert.equal(events.at(-1).requestId, response.headers.get("X-Request-Id"));
  assert.equal(
    requestRecords.at(-1).requestId,
    response.headers.get("X-Request-Id"),
  );
  assert.equal(requestRecords.at(-1).route, "/auth/login");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /Secure/);
  const body = await response.json();
  assert.ok(
    !("passwordHash" in body.data.user) &&
      !("credentialVersion" in body.data.user),
  );
  const { payload } = await jwtVerify(body.data.accessToken, jwtKey);
  assert.equal(payload.sub, "member");
  assert.equal(payload.role, "customer");
  assert.ok(
    await postgres.query(activeSessionStatement(payload.sid, payload.sub)),
  );
});

test("unknown, wrong-password and inactive accounts have the same credential response without sessions", async () => {
  const bodies = [];
  for (const [email, password] of [
    ["missing@example.test", "OriginalPassword1"],
    ["member@example.test", "WrongPassword2"],
    ["inactive@example.test", "OriginalPassword1"],
  ]) {
    const response = await login(bases[0], email, password);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
    bodies.push(await response.text());
  }
  assert.equal(new Set(bodies).size, 1);
  assert.equal(await raw("select count(*) from auth_sessions"), "0");
  const logs = JSON.stringify(events);
  assert.ok(
    !logs.includes("OriginalPassword1") &&
      !logs.includes("member@example.test") &&
      !logs.includes("127.0.0.1"),
  );
});

test("peer/email limits are shared across router instances and competing requests cannot exceed the last slot", async () => {
  const key = authPairKey(secret, "127.0.0.1", "member@example.test");
  await store.execute(reserveAuthBudget(key, 10, 600));
  await postgres.query(
    sql`update account_action_limits set count=9 where key=${key}`,
  );
  const responses = await Promise.all([login(bases[0]), login(bases[1])]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429]);
  assert.equal(await raw("select count(*) from auth_sessions"), "1");
  const response = await login(bases[0]);
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  const stored = await raw(
    "select string_agg(key,',') from account_action_limits",
  );
  assert.ok(
    !stored.includes("member@example.test") && !stored.includes("127.0.0.1"),
  );
  assert.equal(
    (
      await login(bases[2], "member@example.test", "OriginalPassword1", {
        "X-Real-IP": "203.0.113.11",
      })
    ).status,
    200,
  );
});

test("peer limits cover changing identities and spoofed forwarding headers cannot create a new budget", async () => {
  const key = authPeerKey(secret, "login", "127.0.0.1");
  await store.execute(reserveAuthBudget(key, 30, 600));
  await postgres.query(
    sql`update account_action_limits set count=29 where key=${key}`,
  );
  const responses = await Promise.all([
    login(bases[0], "missing-a@example.test"),
    login(bases[1], "missing-b@example.test", "OriginalPassword1", {
      "X-Forwarded-For": "8.8.8.8",
      "X-Real-IP": "8.8.8.8",
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [401, 429]);
  assert.equal(
    await postgres.query(
      sql`select count from account_action_limits where key=${key}`,
    ),
    "30",
  );
});

test("temporary denials do not extend the window or deactivate an account and an expired budget recovers", async () => {
  const key = authPairKey(secret, "127.0.0.1", "member@example.test");
  await store.execute(reserveAuthBudget(key, 10, 600));
  await postgres.query(
    sql`update account_action_limits set count=10 where key=${key}`,
  );
  const deadline = await postgres.query(
    sql`select next_at::text from account_action_limits where key=${key}`,
  );
  assert.equal((await login(bases[0])).status, 429);
  assert.equal(
    await postgres.query(
      sql`select next_at::text from account_action_limits where key=${key}`,
    ),
    deadline,
  );
  assert.equal(await raw("select is_active from users where id='member'"), "t");
  await postgres.query(
    sql`update account_action_limits set window_start=window_start-interval '10 minutes',next_at=next_at-interval '10 minutes' where key=${key}`,
  );
  assert.equal((await login(bases[1])).status, 200);
  assert.equal(
    await postgres.query(
      sql`select count from account_action_limits where key=${key}`,
    ),
    "1",
  );
});

test("PostgreSQL budget reservations are bounded under contention and reject older statement windows", async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      store.execute(reserveAuthBudget("auth:race", 5, 600)),
    ),
  );
  assert.equal(results.filter((rows) => rows[0].allowed).length, 5);
  await raw(
    "update account_action_limits set window_start=statement_timestamp()+interval '1 hour',count=1 where key='auth:race'",
  );
  assert.equal(
    (await store.execute(reserveAuthBudget("auth:race", 5, 600)))[0].allowed,
    false,
  );
  assert.equal(
    await raw("select count from account_action_limits where key='auth:race'"),
    "1",
  );
});

test("business and customer signup create complete profiles with real password hashes", async () => {
  const response = await registration(bases[0], " OWNER@example.test ");
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.user.email, "owner@example.test");
  assert.ok(!JSON.stringify(body).includes("passwordHash"));
  assert.ok(
    await compare(
      "NewPassword2",
      await raw(
        "select password_hash from users where email='owner@example.test'",
      ),
    ),
  );
  assert.equal(
    await raw(
      "select count(*) from businesses b join users u on u.id=b.user_id where u.email='owner@example.test'",
    ),
    "1",
  );
  assert.equal(
    (await registration(bases[1], "customer-new@example.test", "customer"))
      .status,
    201,
  );
  assert.equal(
    await raw(
      "select count(*) from businesses b join users u on u.id=b.user_id where u.email='customer-new@example.test'",
    ),
    "0",
  );
});

test("duplicate concurrent registrations create one user, business and session", async () => {
  const responses = await Promise.all([
    registration(bases[0]),
    registration(bases[1]),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    await raw("select count(*) from users where email='new@example.test'"),
    "1",
  );
  assert.equal(await raw("select count(*) from businesses"), "1");
  assert.equal(await raw("select count(*) from auth_sessions"), "1");
});

test("profile creation failure rolls back the account and session and returns a redacted failure", async () => {
  await raw(
    "create function reject_signup_profile() returns trigger language plpgsql as $$ begin raise exception 'private profile failure'; end $$; create trigger reject_signup_profile before insert on businesses for each row execute function reject_signup_profile()",
  );
  try {
    const response = await registration(bases[0]);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("private profile"));
    assert.equal(
      await raw("select count(*) from users where email='new@example.test'"),
      "0",
    );
    assert.equal(await raw("select count(*) from auth_sessions"), "0");
  } finally {
    await raw(
      "drop trigger reject_signup_profile on businesses; drop function reject_signup_profile()",
    );
  }
  assert.equal((await registration(bases[0])).status, 201);
});

test("a session failure after signup leaves a complete account that can recover through login", async () => {
  beforeSession = async () => {
    throw new Error("private signing failure");
  };
  const response = await registration(bases[0]);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private signing"));
  assert.equal(
    await raw("select count(*) from users where email='new@example.test'"),
    "1",
  );
  assert.equal(await raw("select count(*) from businesses"), "1");
  beforeSession = async () => {};
  assert.equal(
    (await login(bases[1], "new@example.test", "NewPassword2")).status,
    200,
  );
  assert.equal((await registration(bases[1])).status, 409);
  assert.equal(await raw("select count(*) from businesses"), "1");
});

test("registration limits include denied driver signups and recover for a different trusted peer", async () => {
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await registration(bases[0], `driver${i}@example.test`, "driver"))
        .status,
      403,
    );
  assert.equal((await registration(bases[1])).status, 429);
  assert.equal(await raw("select count(*) from drivers"), "0");
  const response = await fetch(`${bases[2]}/auth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Real-IP": "203.0.113.10",
    },
    body: JSON.stringify({
      email: "other@example.test",
      password: "NewPassword2",
      name: "Other",
      role: "customer",
    }),
  });
  assert.equal(response.status, 201);
});

test("a credential change before session issuance cannot leave a live stale session", async () => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  beforeSession = async () => {
    entered();
    await gate;
  };
  const response = login(bases[0]);
  await started;
  await raw("update users set is_active=false where id='member'");
  release();
  assert.equal((await response).status, 401);
  assert.equal(await raw("select count(*) from auth_sessions"), "0");
});

test("storage outages fail closed and trusted proxy errors cannot bypass limits or affect unrelated routes", async () => {
  for (const [path, size] of [
    ["login", 5000],
    ["register", 9000],
  ]) {
    const oversized = await fetch(`${bases[0]}/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ private: "x".repeat(size) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get("cache-control"), "no-store");
  }
  assert.equal(await raw("select count(*) from account_action_limits"), "0");
  storageFailure = true;
  const response = await login(bases[0]);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private"));
  storageFailure = false;
  for (const headers of [
    {},
    { "X-Real-IP": "203.0.113.10,8.8.8.8" },
    { "X-Forwarded-For": "203.0.113.10" },
  ])
    assert.equal(
      (
        await login(
          bases[2],
          "member@example.test",
          "OriginalPassword1",
          headers,
        )
      ).status,
      503,
    );
  assert.equal(await raw("select count(*) from account_action_limits"), "0");
  assert.equal((await fetch(`${bases[2]}/auth/unrelated`)).status, 200);
  assert.equal(
    (
      await login(bases[2], "member@example.test", "OriginalPassword1", {
        "X-Real-IP": "203.0.113.10",
      })
    ).status,
    200,
  );
});
