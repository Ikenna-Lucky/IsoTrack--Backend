import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { SignJWT } from "jose";
import Stripe from "stripe";
import { sql } from "drizzle-orm";
import { postgresFixture } from "./helpers/postgres.mjs";
import { redisFixture } from "./helpers/redis.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import { createRedisBudget } from "../src/lib/api-budget.ts";
import {
  createApiProtection,
  apiBodyBoundary,
} from "../src/middleware/api-protection.ts";
import { createPeerResolver } from "../src/lib/request-peer.ts";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.ts";
import { activeSessionStatement } from "../src/db/queries/session-statements.ts";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { createShipmentCommandRouter } from "../src/routes/shipment-commands.ts";
import { createStripeWebhookRouter } from "../src/routes/stripe-webhook.ts";

const pg = postgresFixture({ prefix: "api-protection" });
const redisFixtureInstance = redisFixture();
const query = (text) => pg.query(sql.raw(text));
const secret = "api-budget-fixture-key-32-characters";
const jwtKey = new TextEncoder().encode(secret);
const tokens = new Map();
const servers = [],
  bases = [],
  clients = [],
  records = [];
const calls = { tracking: 0, read: 0, payments: 0 };
let failures = 0;
before(async () => {
  await pg.start();
  await runMigrations(
    {
      execute: async (s) =>
        JSON.parse(
          await pg.query(sql`select coalesce(json_agg(r),'[]') from (${s})r`),
        ),
      transaction: (s) =>
        pg.query(
          sql.join([sql.raw("begin"), ...s, sql.raw("commit")], sql.raw(";")),
        ),
    },
    fileURLToPath(new URL("../drizzle", import.meta.url)),
  );
  await query(`insert into users(id,email,password_hash,name,role) values('owner','owner@example.test','private','Owner','business'),('other','other@example.test','private','Other','business');
    insert into businesses(id,user_id,business_name) values('biz','owner','A'),('foreign-biz','other','B');
    insert into auth_sessions(id,user_id,credential_version,expires_at) select 'session_'||id,id,0,now()+interval '1 day' from users`);
  for (const id of ["owner", "other"])
    tokens.set(
      id,
      await new SignJWT({
        type: "access",
        role: "business",
        sid: `session_${id}`,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(id)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(jwtKey),
    );
  const url = await redisFixtureInstance.start();
  for (let i = 0; i < 2; i++) {
    const redis = await redisFixtureInstance.connect(url);
    clients.push(redis);
    const budget = createRedisBudget(redis);
    const protect = createApiProtection({
      secret,
      peer: createPeerResolver((c) => getConnInfo(c).remote.address, new Set()),
      budget: {
        consume: async (key, limit, window) => {
          records.push({ key, limit });
          return budget.consume(key, limit, window);
        },
      },
      reportFailure: () => failures++,
    });
    const authenticate = createAuthenticationMiddleware({
      verifyToken: (t) => verifySessionToken(t, jwtKey, "access"),
      isSessionActive: async (sid, id) =>
        Boolean(await pg.query(activeSessionStatement(sid, id))),
      findUser: async (id) => {
        const row = await pg.query(
          sql`select jsonb_build_object('id',id,'role',role,'email',email,'isActive',is_active) from users where id=${id}`,
        );
        return row ? JSON.parse(row) : null;
      },
    });
    const app = new Hono();
    app.onError((e, c) =>
      e instanceof HTTPException
        ? e.getResponse()
        : c.json({ error: "SERVER_FAILURE" }, 500),
    );
    app.use("*", apiBodyBoundary());
    // Same ordering as production: signed webhook precedes client request budgets.
    app.route(
      "/api/v1/payments",
      createStripeWebhookRouter({
        secret: "whsec_api_fixture",
        expectedLiveMode: false,
        parseSession: () => null,
        confirm: async () => false,
      }),
    );
    app.use("/api/v1/track/*", protect("tracking", "peer"));
    app.get("/api/v1/track/:id", (c) => {
      calls.tracking++;
      return c.json({ ok: true });
    });
    app.use(
      "/api/v1/shipments/*",
      protect("shipments", "peer"),
      authenticate,
      protect("shipments", "account"),
    );
    app.get("/api/v1/shipments/:id", (c) => {
      calls.read++;
      return c.json({ ok: true });
    });
    app.route(
      "/api/v1/shipments",
      createShipmentCommandRouter({
        execute: async (s) => {
          const row = await pg.query(s);
          return row ? row.split("\n").map(JSON.parse) : [];
        },
      }),
    );
    app.use(
      "/api/v1/payments/*",
      protect("payments", "peer"),
      authenticate,
      protect("payments", "account"),
    );
    app.post("/api/v1/payments/initialize", (c) => {
      calls.payments++;
      return c.json({ ok: true });
    });
    app.get("/api/v1/payments/verify/:id", (c) => {
      calls.payments++;
      return c.json({ ok: true });
    });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    bases.push(`http://127.0.0.1:${server.address().port}/api/v1`);
  }
});
beforeEach(async () => {
  await clients[0].flushdb();
  records.length = 0;
  failures = 0;
  calls.tracking = 0;
  calls.read = 0;
  calls.payments = 0;
  await query(`truncate shipments cascade;
    insert into shipments(id,tracking_id,business_id,description,weight_kg,pickup_address,delivery_address,price_kobo) values
    ('s-1','IST-ONE','biz','Box',1,'{}','{}',100),('s-2','IST-TWO','biz','Box',1,'{}','{}',100)`);
});
after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await redisFixtureInstance.stop();
  await pg.stop();
});
const get = (path, instance = 0, actor = "owner", extra = {}) =>
  fetch(`${bases[instance]}${path}`, {
    headers: {
      ...(actor ? { Authorization: `Bearer ${tokens.get(actor)}` } : {}),
      ...extra,
    },
  });
const cancel = (id, instance = 0) =>
  fetch(`${bases[instance]}/shipments/${id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${tokens.get("owner")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "cancel-request-key-12345",
    },
    body: JSON.stringify({ expectedVersion: 0 }),
  });

test("two HTTP instances share one atomic public budget under concurrent requests", async () => {
  const responses = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      get(`/track/IST-${i}`, i % 2, null, {
        "X-Real-IP": `203.0.113.${i}`,
        "X-Forwarded-For": `203.0.113.${i}`,
      }),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 200).length, 60);
  assert.equal(responses.filter((r) => r.status === 429).length, 40);
  assert.equal(calls.tracking, 60);
  for (const response of responses.filter((r) => r.status === 429)) {
    assert.ok(Number(response.headers.get("Retry-After")) >= 1);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json()).error, "RATE_LIMITED");
  }
  const keys = await clients[0].keys("isotrack:api-budget:*");
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^isotrack:api-budget:v1:[a-f0-9]{64}$/);
  assert.ok(!keys[0].includes("127.0.0.1"));
});

test("account budgets isolate businesses while read/write budgets remain independent", async () => {
  assert.equal((await get("/shipments/s-1")).status, 200);
  const key = records.find((r) => r.limit === 120).key;
  await clients[0].set(key, 120, "PX", 60000);
  assert.equal((await get("/shipments/s-1", 1)).status, 429);
  assert.equal((await get("/shipments/s-1", 1, "other")).status, 200);
  assert.equal((await cancel("s-1", 1)).status, 200);
  assert.equal(
    await query("select status from shipments where id='s-1'"),
    "cancelled",
  );
});

test("a rejected write never changes shipments, events or durable idempotency rows", async () => {
  assert.equal((await cancel("s-1")).status, 200);
  const key = records.find((r) => r.limit === 60).key;
  await clients[0].set(key, 60, "PX", 60000);
  const before = await query("select count(*) from idempotency_requests");
  assert.equal((await cancel("s-2", 1)).status, 429);
  assert.equal(
    await query("select status from shipments where id='s-2'"),
    "pending",
  );
  assert.equal(
    await query("select count(*) from shipment_events where shipment_id='s-2'"),
    "0",
  );
  assert.equal(
    await query("select count(*) from idempotency_requests"),
    before,
  );
});

test("payment client budgets prevent repeated provider work across instances", async () => {
  const responses = [];
  for (let i = 0; i < 12; i++)
    responses.push(await get(`/payments/verify/reference-${i}`, i % 2));
  assert.equal(responses.filter((r) => r.status === 200).length, 10);
  assert.equal(responses.filter((r) => r.status === 429).length, 2);
  assert.equal(calls.payments, 10);
});

test("Redis counters expire and denied attempts do not extend their lifetime", async () => {
  const budget = createRedisBudget(clients[0]);
  assert.equal((await budget.consume("expiry-fixture", 1, 500)).allowed, true);
  const before = await clients[0].pttl("expiry-fixture");
  assert.equal((await budget.consume("expiry-fixture", 1, 500)).allowed, false);
  assert.ok((await clients[0].pttl("expiry-fixture")) <= before);
  await delay(600);
  assert.equal((await budget.consume("expiry-fixture", 1, 500)).allowed, true);
});

test("Redis failure rejects protected traffic without a local fallback and signed webhooks still work", async () => {
  clients[0].disconnect();
  try {
    const started = Date.now();
    const response = await get("/track/IST-ONE", 0, null);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "5");
    assert.ok(Date.now() - started < 2000);
    assert.equal(calls.tracking, 0);
    assert.ok(failures > 0);
    assert.equal((await get("/track/IST-ONE", 1, null)).status, 200);
    const body = JSON.stringify({
      type: "customer.created",
      livemode: false,
      data: { object: { metadata: { padding: "x".repeat(20000) } } },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: "whsec_api_fixture",
    });
    const webhook = await fetch(`${bases[0]}/payments/webhook`, {
      method: "POST",
      headers: { "stripe-signature": signature },
      body,
    });
    assert.equal(webhook.status, 200);
  } finally {
    await clients[0].connect();
  }
  assert.equal((await get("/track/IST-ONE", 0, null)).status, 200);
});

test("oversized fixed/chunked bodies are rejected before budgets and persistence; webhook ceiling is separate", async () => {
  for (const streamed of [false, true]) {
    const body = streamed
      ? new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("x".repeat(17000)));
            c.close();
          },
        })
      : "x".repeat(17000);
    const response = await fetch(`${bases[0]}/shipments/s-1`, {
      method: "DELETE",
      body,
      duplex: "half",
      headers: { Authorization: `Bearer ${tokens.get("owner")}` },
    });
    assert.equal(response.status, 413);
  }
  assert.equal(records.length, 0);
  assert.equal(
    await query("select status from shipments where id='s-1'"),
    "pending",
  );
  assert.equal(
    (
      await fetch(`${bases[0]}/payments/webhook`, {
        method: "POST",
        body: "x".repeat(262145),
      })
    ).status,
    413,
  );
});
