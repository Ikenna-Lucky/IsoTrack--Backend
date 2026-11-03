import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { sql } from "drizzle-orm";
import { compare, hash } from "bcryptjs";
import { SignJWT } from "jose";
import nodemailer from "nodemailer";
import { postgresFixture } from "./helpers/postgres.mjs";
import { smtpFixture } from "./helpers/smtp.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import { createAccountActionRouter } from "../src/routes/account-actions.ts";
import { createAccountEmailProcessor } from "../src/workers/account-email.ts";
import {
  actionToken,
  actionHash,
  actionPeerHash,
} from "../src/lib/account-action-token.ts";
import {
  claimAccountEmails,
  finishAccountEmail,
  purgeAccountActions,
} from "../src/db/queries/account-actions.ts";
import {
  openSessionStatement,
  activeSessionStatement,
} from "../src/db/queries/session-statements.ts";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.ts";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { requireSessionClaims } from "../src/lib/session-claims.ts";

const postgres = postgresFixture({ prefix: "identity" });
const key = randomBytes(32).toString("hex");
const jwtKey = new TextEncoder().encode(
  "account-action-signature-fixture-key-32",
);
const store = {
  execute: async (statement) => {
    const rows = await postgres.query(statement);
    return rows ? rows.split("\n").map((row) => JSON.parse(row)) : [];
  },
};
const raw = (text) => postgres.query(sql.raw(text));
let server, base, smtp, transport, originalHash;
let sent = [];
let errors = 0;
const send = async (email) => {
  await transport.sendMail({ from: "test@example.test", ...email });
  sent.push(email);
};
let processEmails;
const request = (path, body, headers = {}) =>
  fetch(`${base}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
async function action(
  purpose = "reset_password",
  email = "member@example.test",
) {
  const response = await request(
    purpose === "reset_password" ? "/forgot-password" : "/verification/request",
    { email },
  );
  assert.equal(response.status, 202);
  const row = (
    await store.execute(
      sql`select json_build_object('id',id,'hash',token_hash) as result from account_actions where purpose=${purpose} order by created_at desc limit 1`,
    )
  )[0];
  assert.ok(row);
  return {
    id: row.id,
    token: actionToken(row.id, purpose, key),
    hash: row.hash,
  };
}
async function session() {
  const id = "abcdefghijklmnopqrstu";
  await postgres.query(openSessionStatement(id, "member", 0, 3600));
  const token = await new SignJWT({ type: "access", role: "customer", sid: id })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("member")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(jwtKey);
  return { id, token };
}
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
  originalHash = await hash("OriginalPassword1", 4);
  smtp = await smtpFixture();
  transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: smtp.port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 2000,
    socketTimeout: 2000,
  });
  processEmails = createAccountEmailProcessor(
    store,
    key,
    "https://app.example.test",
    send,
  );
  const app = new Hono();
  app.route(
    "/auth",
    createAccountActionRouter({
      store,
      key,
      peer: (c) => getConnInfo(c).remote.address,
      reportError: () => errors++,
    }),
  );
  const authenticate = createAuthenticationMiddleware({
    verifyToken: async (token) => {
      const payload = await verifySessionToken(token, jwtKey, "access");
      requireSessionClaims(payload, false);
      return payload;
    },
    findUser: async (id) =>
      (
        await store.execute(
          sql`select json_build_object('id',id,'role',role,'isActive',is_active) as result from users where id=${id}`,
        )
      )[0] ?? null,
    isSessionActive: async (sid, userId) =>
      Boolean(await postgres.query(activeSessionStatement(sid, userId))),
  });
  app.get("/protected", authenticate, (c) => c.json({ ok: true }));
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (transport) transport.close();
  if (smtp) await smtp.close();
  await postgres.stop();
});
beforeEach(async () => {
  await raw(
    "truncate account_actions,account_action_limits,auth_sessions,users cascade",
  );
  await postgres.query(sql`insert into users(id,email,password_hash,name,role,is_active,is_email_verified) values
    ('member','member@example.test',${originalHash},'Member','customer',true,false),
    ('inactive','inactive@example.test',${originalHash},'Inactive','customer',false,false),
    ('verified','verified@example.test',${originalHash},'Verified','business',true,true)`);
  sent = [];
  smtp.accepted.length = 0;
  smtp.reject(false);
  errors = 0;
});

test("request responses conceal account existence, state and resend suppression", async () => {
  const responses = [];
  for (const email of [
    "member@example.test",
    "absent@example.test",
    "inactive@example.test",
    "member@example.test",
  ]) {
    const response = await request("/forgot-password", { email });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("cache-control"), "no-store");
    responses.push(await response.text());
  }
  assert.equal(new Set(responses).size, 1);
  assert.equal(await raw("select count(*) from account_actions"), "1");
  const response = await request("/verification/request", {
    email: "verified@example.test",
  });
  assert.equal(response.status, 202);
  assert.equal(await raw("select count(*) from account_actions"), "1");
  assert.equal(sent.length, 0);
});

test("durable SMTP delivery carries a trusted fragment link and no plaintext token is stored", async () => {
  await request(
    "/forgot-password",
    { email: " MEMBER@example.test " },
    { host: "evil.example.test", "x-forwarded-host": "evil.example.test" },
  );
  await processEmails();
  assert.equal(smtp.accepted.length, 1);
  assert.equal(sent.length, 1);
  const url = new URL(sent[0].text.match(/https:\/\/\S+/)[0]);
  assert.equal(url.origin, "https://app.example.test");
  assert.equal(url.pathname, "/reset-password");
  assert.equal(url.search, "");
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  assert.equal(token.length, 87);
  const stored = await raw("select row_to_json(a) from account_actions a");
  assert.ok(!stored.includes(token));
  assert.equal(JSON.parse(stored).token_hash, actionHash(token));
  assert.equal(JSON.parse(stored).delivery_state, "sent");
  await processEmails();
  assert.equal(smtp.accepted.length, 1);
});

test("HTTP password reset hashes the new password, consumes once, revokes JWT sessions and queues a notice", async () => {
  const credentials = await session();
  assert.equal(
    (
      await fetch(`${base}/protected`, {
        headers: { authorization: `Bearer ${credentials.token}` },
      })
    ).status,
    200,
  );
  const reset = await action();
  const response = await request("/reset-password", {
    token: reset.token,
    newPassword: "ChangedPassword2",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  assert.ok(!(await response.text()).includes("accessToken"));
  const stored = await raw("select password_hash from users where id='member'");
  assert.ok(await compare("ChangedPassword2", stored));
  assert.ok(!(await compare("OriginalPassword1", stored)));
  assert.equal(
    (
      await fetch(`${base}/protected`, {
        headers: { authorization: `Bearer ${credentials.token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    await postgres.query(activeSessionStatement(credentials.id, "member")),
    "",
  );
  assert.equal(
    (
      await request("/reset-password", {
        token: reset.token,
        newPassword: "AnotherPassword3",
      })
    ).status,
    400,
  );
  assert.equal(
    await raw(
      "select count(*) from account_actions where purpose='password_changed'",
    ),
    "1",
  );
  await processEmails();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /password was changed/);
  assert.ok(!sent[0].text.includes("ChangedPassword2"));
});

test("verification requires POST confirmation and binds purpose, recipient and current credentials", async () => {
  const verify = await action("verify_email");
  assert.equal((await fetch(`${base}/auth/verification/confirm`)).status, 404);
  assert.equal(
    await raw("select is_email_verified from users where id='member'"),
    "f",
  );
  assert.equal(
    (
      await request("/reset-password", {
        token: verify.token,
        newPassword: "ChangedPassword2",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/verification/confirm", { token: verify.token })).status,
    200,
  );
  assert.equal(
    await raw("select is_email_verified from users where id='member'"),
    "t",
  );
  assert.equal(
    await raw("select is_email_verified from users where id='inactive'"),
    "f",
  );
  assert.equal(
    (await request("/verification/confirm", { token: verify.token })).status,
    400,
  );
  await processEmails();
  assert.equal(sent.length, 0);
});

test("expired and modified links cannot change credentials or verification", async () => {
  const reset = await action();
  const verify = await action("verify_email");
  await raw(
    "update account_actions set created_at=now()-interval '2 days',expires_at=now()-interval '1 second'",
  );
  for (const token of [reset.token, `${reset.token.slice(0, -2)}AA`]) {
    assert.equal(
      (
        await request("/reset-password", {
          token,
          newPassword: "ChangedPassword2",
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (await request("/verification/confirm", { token: verify.token })).status,
    400,
  );
  assert.equal(
    await raw("select password_hash from users where id='member'"),
    originalHash,
  );
  await processEmails();
  assert.equal(sent.length, 0);
});

test("competing resets consume one token once and persist one security notice", async () => {
  const reset = await action();
  const responses = await Promise.all([
    request("/reset-password", {
      token: reset.token,
      newPassword: "FirstPassword2",
    }),
    request("/reset-password", {
      token: reset.token,
      newPassword: "SecondPassword3",
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
  assert.equal(
    await raw("select credential_version from users where id='member'"),
    "1",
  );
  assert.equal(
    await raw(
      "select count(*) from account_actions where purpose='password_changed'",
    ),
    "1",
  );
});

test("different reset links and repeated verification confirmations serialize correctly", async () => {
  const first = await action();
  await raw(
    "update account_action_limits set next_at=now()-interval '1 minute'",
  );
  const second = await action();
  const resetResponses = await Promise.all([
    request("/reset-password", {
      token: first.token,
      newPassword: "FirstPassword2",
    }),
    request("/reset-password", {
      token: second.token,
      newPassword: "SecondPassword3",
    }),
  ]);
  assert.deepEqual(
    resetResponses.map((response) => response.status).sort(),
    [200, 400],
  );
  assert.equal(
    await raw("select credential_version from users where id='member'"),
    "1",
  );
  const verification = await action("verify_email");
  const verificationResponses = await Promise.all([
    request("/verification/confirm", { token: verification.token }),
    request("/verification/confirm", { token: verification.token }),
  ]);
  assert.deepEqual(
    verificationResponses.map((response) => response.status).sort(),
    [200, 400],
  );
  assert.equal(
    await raw("select is_email_verified from users where id='member'"),
    "t",
  );
});

test("reset invalidates other reset and verification links and earlier account states stay invalid", async () => {
  const first = await action();
  const verification = await action("verify_email");
  await raw(
    "update account_action_limits set next_at=now()-interval '1 minute'",
  );
  const second = await action();
  assert.equal(
    (
      await request("/reset-password", {
        token: second.token,
        newPassword: "NewPassword2",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/reset-password", {
        token: first.token,
        newPassword: "OtherPassword3",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/verification/confirm", { token: verification.token }))
      .status,
    400,
  );
  await raw(
    "update account_action_limits set next_at=now()-interval '1 minute'",
  );
  const later = await action();
  await raw(
    "update users set is_active=false where id='member'; update users set is_active=true where id='member'",
  );
  assert.equal(
    (
      await request("/reset-password", {
        token: later.token,
        newPassword: "OtherPassword3",
      })
    ).status,
    400,
  );
});

test("email changes clear verification and invalidate sessions and links for the old address", async () => {
  const credentials = await session();
  const reset = await action();
  await raw(
    "update users set is_email_verified=true where id='member'; update users set email='new@example.test' where id='member'",
  );
  assert.equal(
    await raw("select is_email_verified from users where id='member'"),
    "f",
  );
  assert.equal(
    await postgres.query(activeSessionStatement(credentials.id, "member")),
    "",
  );
  assert.equal(
    (
      await request("/reset-password", {
        token: reset.token,
        newPassword: "OtherPassword3",
      })
    ).status,
    400,
  );
  await processEmails();
  assert.equal(sent.length, 0);
});

test("concurrent requests and resend budgets are enforced in PostgreSQL", async () => {
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      request("/forgot-password", { email: "member@example.test" }),
    ),
  );
  assert.ok(responses.every((r) => r.status === 202));
  assert.equal(await raw("select count(*) from account_actions"), "1");
  for (let i = 0; i < 5; i++) {
    await raw(
      "update account_action_limits set next_at=now()-interval '1 minute'",
    );
    assert.equal(
      (await request("/forgot-password", { email: "member@example.test" }))
        .status,
      202,
    );
  }
  assert.equal(await raw("select count(*) from account_actions"), "5");
  await raw(
    "update account_action_limits set window_start=statement_timestamp()+interval '2 hours',next_at=statement_timestamp()-interval '1 minute',count=1 where key like 'account:%'",
  );
  assert.equal(
    (await request("/forgot-password", { email: "member@example.test" }))
      .status,
    202,
  );
  assert.equal(await raw("select count(*) from account_actions"), "5");
});

test("peer budgets apply before password hashing and spoofed forwarding headers cannot bypass them", async () => {
  await request("/forgot-password", { email: "absent@example.test" });
  const peer = `peer:${actionPeerHash("127.0.0.1", key)}`;
  await postgres.query(
    sql`update account_action_limits set count=30 where key=${peer}`,
  );
  const response = await request(
    "/reset-password",
    { token: "invalid", newPassword: "ChangedPassword2" },
    { "x-forwarded-for": "8.8.8.8" },
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "600");
  assert.equal(await raw("select count(*) from account_actions"), "0");
  // Simulate a delayed query reaching a budget whose window already advanced.
  // Older statement timestamps must never rewind the counter and reset its limit.
  await postgres.query(
    sql`update account_action_limits set window_start=statement_timestamp()+interval '1 hour',count=1 where key=${peer}`,
  );
  assert.equal(
    (await request("/forgot-password", { email: "member@example.test" }))
      .status,
    429,
  );
  assert.equal(
    await postgres.query(
      sql`select count from account_action_limits where key=${peer}`,
    ),
    "1",
  );
});

test("failure creating the durable security notice rolls back the reset, token and session invalidation", async () => {
  const credentials = await session();
  const reset = await action();
  await raw(
    "create function reject_identity_notice() returns trigger language plpgsql as $$ begin if NEW.purpose='password_changed' then raise exception 'injected notice failure'; end if; return NEW; end $$; create trigger reject_identity_notice before insert on account_actions for each row execute function reject_identity_notice()",
  );
  try {
    const response = await request("/reset-password", {
      token: reset.token,
      newPassword: "ChangedPassword2",
    });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("injected notice failure"));
    assert.equal(
      await raw("select password_hash from users where id='member'"),
      originalHash,
    );
    assert.equal(
      await raw(
        "select count(*) from account_actions where consumed_at is not null",
      ),
      "0",
    );
    assert.ok(
      await postgres.query(activeSessionStatement(credentials.id, "member")),
    );
  } finally {
    await raw(
      "drop trigger reject_identity_notice on account_actions; drop function reject_identity_notice()",
    );
  }
  assert.equal(
    (
      await request("/reset-password", {
        token: reset.token,
        newPassword: "ChangedPassword2",
      })
    ).status,
    200,
  );
});

test("SMTP failure retries durably up to five attempts and stale accounts never receive links", async () => {
  await action();
  smtp.reject(true);
  for (let i = 0; i < 5; i++) {
    await processEmails();
    await raw(
      "update account_actions set available_at=now()-interval '1 minute'",
    );
  }
  assert.equal(
    await raw("select delivery_state || ':' || attempts from account_actions"),
    "dead:5",
  );
  assert.equal(smtp.accepted.length, 0);
  smtp.reject(false);
  await raw(
    "update account_action_limits set next_at=now()-interval '1 minute'",
  );
  await action("verify_email");
  await raw("update users set is_active=false where id='member'");
  await processEmails();
  assert.equal(sent.length, 0);
  assert.equal(
    await raw(
      "select delivery_state from account_actions where purpose='verify_email'",
    ),
    "skipped",
  );
});

test("expired leases are reclaimed, old workers are fenced and ambiguous SMTP delivery can duplicate", async () => {
  const reset = await action();
  assert.equal(
    (await store.execute(claimAccountEmails("old-worker"))).length,
    1,
  );
  await raw("update account_actions set lease_until=now()-interval '1 second'");
  assert.equal(
    (await store.execute(claimAccountEmails("new-worker"))).length,
    1,
  );
  assert.equal(
    (await store.execute(finishAccountEmail(reset.id, "old-worker", "sent")))
      .length,
    0,
  );
  await store.execute(finishAccountEmail(reset.id, "new-worker", "failed"));
  await raw(
    "update account_actions set available_at=now()-interval '1 minute'",
  );
  let loseNext = false;
  const faulty = {
    execute: async (statement) => {
      if (loseNext) {
        loseNext = false;
        throw new Error("injected lost completion");
      }
      return store.execute(statement);
    },
  };
  const processor = createAccountEmailProcessor(
    faulty,
    key,
    "https://app.example.test",
    async (email) => {
      await send(email);
      loseNext = true;
    },
  );
  await processor();
  await raw(
    "update account_actions set available_at=now()-interval '1 minute'",
  );
  await processEmails();
  assert.equal(smtp.accepted.length, 2);
  assert.equal(sent[0].messageId, sent[1].messageId);
  assert.equal(await raw("select delivery_state from account_actions"), "sent");
});

test("cleanup removes only old expired work and old hashed budgets", async () => {
  const reset = await action();
  await action("verify_email");
  await postgres.query(
    sql`update account_actions set created_at=now()-interval '10 days',expires_at=now()-interval '9 days' where id=${reset.id}`,
  );
  await raw(
    "update account_action_limits set window_start=now()-interval '3 days'",
  );
  const result = (await store.execute(purgeAccountActions()))[0];
  assert.equal(Number(result.actions), 1);
  assert.ok(Number(result.limits) > 0);
  assert.equal(await raw("select count(*) from account_actions"), "1");
  assert.equal(
    await raw("select purpose from account_actions"),
    "verify_email",
  );
});
