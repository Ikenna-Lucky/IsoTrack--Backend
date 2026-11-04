import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import Stripe from "stripe";
import { createStripeWebhookRouter } from "../src/routes/stripe-webhook.ts";
import { parseStripeSession } from "../src/lib/stripe-payload.ts";
import { HTTPException } from "hono/http-exception";
import { SignJWT } from "jose";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { postgresFixture } from "./helpers/postgres.mjs";
import { stripeFixture } from "./helpers/stripe.mjs";
import { createIdempotentWrites } from "../src/services/idempotent-writes.ts";
import { createPaymentLifecycle } from "../src/services/payment-lifecycle.ts";
import {
  createShipmentCreationRouter,
  createCheckoutInitializationRouter,
} from "../src/routes/idempotent-writes.ts";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.ts";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { requireSessionClaims } from "../src/lib/session-claims.ts";
import {
  openSessionStatement,
  activeSessionStatement,
} from "../src/db/queries/session-statements.ts";
import {
  createShipmentOnceStatement,
  scrubRequestsStatement,
} from "../src/db/queries/idempotency.ts";

const postgres = postgresFixture({ prefix: "idempotency" });
const dialect = new PgDialect();
const secret = new TextEncoder().encode(
  "idempotency-real-signature-fixture-key-32",
);
const tokens = new Map();
const store = {
  execute: async (statement) => {
    const result = await postgres.query(statement);
    return result ? result.split("\n").map((row) => JSON.parse(row)) : [];
  },
};
let provider;
async function reauthenticateOwner() {
  const version = Number(
    await postgres.query(
      sql`select credential_version from users where id='owner-a'`,
    ),
  );
  const sid = `sess_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await postgres.query(openSessionStatement(sid, "owner-a", version, 3600));
  tokens.set(
    "owner-a",
    await new SignJWT({ type: "access", role: "business", sid })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("owner-a")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret),
  );
}
before(async () => {
  await postgres.start();
  for (const name of [
    "0000_graceful_the_enforcers",
    "0002_private_fleets",
    "0003_driver_invitations",
    "0004_stripe_checkout",
    "0005_auth_sessions",
    "0006_notification_outbox",
    "0007_request_idempotency",
    "0008_account_actions",
    "0009_payment_lifecycle",
    "0010_operational_indexes",
    "0011_shipment_commands",
    "0012_shipment_pagination",
    "0013_delivery_confirmation",
  ]) {
    await postgres.query(
      sql.raw(
        await readFile(
          new URL(`../drizzle/${name}.sql`, import.meta.url),
          "utf8",
        ),
      ),
    );
  }
  await postgres.query(
    sql.raw(`insert into users(id,email,password_hash,name,role) values
    ('owner-a','owner-a@example.test','hash','A','business'),('owner-b','owner-b@example.test','hash','B','business'),
    ('customer-a','customer-a@example.test','hash','A','customer'),('customer-b','customer-b@example.test','hash','B','customer'),
    ('rider-a','rider-a@example.test','hash','A','driver');
    insert into businesses(id,user_id,business_name) values('biz-a','owner-a','A'),('biz-b','owner-b','B');`),
  );
  for (const [user, role] of [
    ["owner-a", "business"],
    ["owner-b", "business"],
    ["customer-a", "customer"],
    ["customer-b", "customer"],
    ["rider-a", "driver"],
  ]) {
    const sid = `sess_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await postgres.query(openSessionStatement(sid, user, 0, 3600));
    tokens.set(
      user,
      await new SignJWT({ type: "access", role, sid })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(secret),
    );
  }
  provider = await stripeFixture();
});
beforeEach(async () => {
  await postgres.query(
    sql`truncate shipments,shipment_events,payments,notifications,notification_outbox,idempotency_requests cascade`,
  );
  await postgres.query(sql`update users set email=id||'@example.test'`);
  await reauthenticateOwner();
  provider.reset();
});
after(async () => {
  await provider?.close();
  await postgres.stop();
});

function app(options = {}) {
  const writes = createIdempotentWrites({
    store,
    frontendUrl: "https://app.example.test",
    providerContext: "test-provider",
    liveMode: false,
    createCheckout: provider.create,
    ...options,
  });
  const router = new Hono();
  router.onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : c.json({ error: "SERVER_FAILURE" }, 500),
  );
  router.use(
    "*",
    createAuthenticationMiddleware({
      verifyToken: async (token) => {
        const payload = await verifySessionToken(token, secret, "access");
        requireSessionClaims(payload, false);
        return payload;
      },
      findUser: async (id) => {
        const row = await postgres.query(
          sql`select jsonb_build_object('id',id,'role',role,'email',email,'isActive',is_active) from users where id=${id}`,
        );
        return row ? JSON.parse(row) : null;
      },
      isSessionActive: async (sid, id) =>
        Boolean(await postgres.query(activeSessionStatement(sid, id))),
    }),
  );
  const authorize = async (_c, next) => {
    await next();
  };
  router.route(
    "/shipments",
    createShipmentCreationRouter({ authorize, writes }),
  );
  router.route(
    "/payments",
    createCheckoutInitializationRouter({ authorize, writes }),
  );
  return router;
}
const key = (label) => label.padEnd(24, "_");
const body = (overrides = {}) => ({
  description: "Box",
  weightKg: 1,
  pickupAddress: { street: "A", city: "Lagos" },
  deliveryAddress: { street: "B", city: "Lagos" },
  customerId: "customer-a",
  priceKobo: 100,
  ...overrides,
});
function post(router, path, input, requestKey, user = "owner-a") {
  return router.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(user ? { Authorization: `Bearer ${tokens.get(user)}` } : {}),
      ...(requestKey ? { "Idempotency-Key": requestKey } : {}),
    },
    body: JSON.stringify(input),
  });
}
async function shipment(router, label = "checkout") {
  const response = await post(
    router,
    "/shipments",
    body(),
    key(`shipment-${label}`),
  );
  assert.equal(response.status, 201);
  return (await response.json()).data.id;
}
async function until(check) {
  const end = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Provider request did not arrive");
    await delay(20);
  }
}
const sqlText = (statement) => dialect.sqlToQuery(statement).sql;

test("HTTP authentication, keys, request bounds and roles are enforced before writes", async () => {
  const router = app();
  assert.equal(
    (await post(router, "/shipments", body(), key("auth"), null)).status,
    401,
  );
  assert.equal(
    (await post(router, "/shipments", body(), undefined)).status,
    400,
  );
  assert.equal((await post(router, "/shipments", body(), "short")).status, 400);
  assert.equal(
    (await post(router, "/shipments", body({ unknown: true }), key("invalid")))
      .status,
    400,
  );
  assert.equal(
    (await post(router, "/shipments", body(), key("wrong-role"), "customer-a"))
      .status,
    403,
  );
  assert.equal(
    (
      await post(
        router,
        "/shipments",
        body({ description: "x".repeat(17000) }),
        key("oversized"),
      )
    ).status,
    413,
  );
  assert.equal(
    await postgres.query(sql`select count(*) from idempotency_requests`),
    "0",
  );
});

test("shipment retries return the original status and body without repeating history or outbox", async () => {
  const router = app();
  const requestKey = key("shipment-replay");
  const first = await post(router, "/shipments", body(), requestKey);
  const original = await first.json();
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("idempotency-replayed"), "false");
  await postgres.query(
    sql`update shipments set description='changed later' where id=${original.data.id}`,
  );
  const second = await post(router, "/shipments", body(), requestKey);
  assert.equal(second.status, 201);
  assert.deepEqual(await second.json(), original);
  assert.equal(second.headers.get("idempotency-replayed"), "true");
  assert.equal(second.headers.get("cache-control"), "no-store");
  assert.equal(await postgres.query(sql`select count(*) from shipments`), "1");
  assert.equal(
    await postgres.query(sql`select count(*) from shipment_events`),
    "1",
  );
  assert.equal(
    await postgres.query(sql`select count(*) from notification_outbox`),
    "2",
  );
  assert.equal(
    (
      await post(
        router,
        "/shipments",
        body({ description: "different" }),
        requestKey,
      )
    ).status,
    409,
  );
});

test("concurrent shipment attempts return retryable conflicts and different data cannot hijack the key", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let blocked = false;
  const gated = {
    execute: async (statement) => {
      if (!blocked && sqlText(statement).includes("insert into shipments(")) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      return store.execute(statement);
    },
  };
  const router = app({ store: gated });
  const requestKey = key("shipment-race");
  const first = post(router, "/shipments", body(), requestKey);
  t.after(async () => {
    release.resolve();
    await first;
  });
  await entered.promise;
  const second = await post(router, "/shipments", body(), requestKey);
  assert.equal(second.status, 409);
  assert.equal(second.headers.get("retry-after"), "1");
  assert.equal((await second.json()).error, "IDEMPOTENCY_IN_PROGRESS");
  const mismatch = await post(
    router,
    "/shipments",
    body({ priceKobo: 200 }),
    requestKey,
  );
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error, "IDEMPOTENCY_KEY_CONFLICT");
  release.resolve();
  assert.equal((await first).status, 201);
  assert.equal(
    (await post(router, "/shipments", body(), requestKey)).status,
    201,
  );
  assert.equal(await postgres.query(sql`select count(*) from shipments`), "1");
});

test("keys are scoped independently to user and operation", async () => {
  const router = app();
  const requestKey = key("scoped-key");
  const a = await post(router, "/shipments", body(), requestKey);
  const shipmentId = (await a.json()).data.id;
  assert.equal(
    (await post(router, "/shipments", body(), requestKey, "owner-b")).status,
    201,
  );
  assert.equal(
    (await post(router, "/payments/initialize", { shipmentId }, requestKey))
      .status,
    200,
  );
  assert.equal(
    await postgres.query(sql`select count(*) from idempotency_requests`),
    "3",
  );
  assert.equal(await postgres.query(sql`select count(*) from shipments`), "2");
});

test("outbox failure rolls back shipment, history and saved result, then the same key can recover", async () => {
  const router = app();
  const requestKey = key("atomic-retry");
  await postgres.query(
    sql`alter table notification_outbox add constraint reject_idempotent_capture check(payload->>'status'<>'pending')`,
  );
  try {
    assert.equal(
      (await post(router, "/shipments", body(), requestKey)).status,
      500,
    );
  } finally {
    await postgres.query(
      sql`alter table notification_outbox drop constraint reject_idempotent_capture`,
    );
  }
  assert.equal(await postgres.query(sql`select count(*) from shipments`), "0");
  assert.equal(
    await postgres.query(sql`select count(*) from shipment_events`),
    "0",
  );
  assert.equal(
    await postgres.query(
      sql`select count(*) from idempotency_requests where state='pending' and lease_token is null`,
    ),
    "1",
  );
  assert.equal(
    (await post(router, "/shipments", body(), requestKey)).status,
    201,
  );
  assert.equal(
    await postgres.query(sql`select count(*) from notification_outbox`),
    "2",
  );
});

test("lost claim acknowledgement recovers after lease expiry and fences the former owner", async () => {
  let lost = false;
  const fault = {
    execute: async (statement) => {
      const rows = await store.execute(statement);
      if (
        !lost &&
        sqlText(statement).startsWith(
          "update idempotency_requests set lease_token=",
        )
      ) {
        lost = true;
        throw new Error("Lost claim acknowledgement");
      }
      return rows;
    },
  };
  const requestKey = key("claim-crash");
  assert.equal(
    (await post(app({ store: fault }), "/shipments", body(), requestKey))
      .status,
    500,
  );
  const previous = JSON.parse(
    await postgres.query(
      sql`select jsonb_build_object('id',id,'token',lease_token,'trackingId',parameters->>'trackingId') from idempotency_requests`,
    ),
  );
  const router = app();
  assert.equal(
    (await post(router, "/shipments", body(), requestKey)).status,
    409,
  );
  await postgres.query(
    sql`update idempotency_requests set lease_until=now()-interval '1 second'`,
  );
  const response = await post(router, "/shipments", body(), requestKey);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.trackingId, previous.trackingId);
  assert.equal(
    (
      await store.execute(
        createShipmentOnceStatement(
          previous.id,
          {
            userId: "owner-a",
            role: "business",
            email: "owner-a@example.test",
          },
          previous.token,
        ),
      )
    ).length,
    0,
  );
  assert.equal(await postgres.query(sql`select count(*) from shipments`), "1");
});

test("a committed shipment survives loss of its database response without another creation", async () => {
  let lost = false;
  const fault = {
    execute: async (statement) => {
      const rows = await store.execute(statement);
      if (!lost && sqlText(statement).includes("insert into shipments(")) {
        lost = true;
        throw new Error("Response lost after commit");
      }
      return rows;
    },
  };
  const requestKey = key("commit-loss");
  assert.equal(
    (await post(app({ store: fault }), "/shipments", body(), requestKey))
      .status,
    500,
  );
  const replay = await post(app(), "/shipments", body(), requestKey);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal(
    await postgres.query(sql`select count(*) from shipment_events`),
    "1",
  );
});

test("expired keys remain tombstones after bounded sensitive-payload cleanup", async () => {
  const router = app();
  const requestKey = key("expired");
  assert.equal(
    (await post(router, "/shipments", body(), requestKey)).status,
    201,
  );
  await postgres.query(
    sql`update idempotency_requests set created_at=now()-interval '31 days',expires_at=now()-interval '30 days'`,
  );
  assert.equal(
    (await post(router, "/shipments", body(), requestKey)).status,
    410,
  );
  assert.equal((await store.execute(scrubRequestsStatement())).length, 1);
  assert.equal(
    await postgres.query(
      sql`select parameters is null and response is null and scrubbed_at is not null from idempotency_requests`,
    ),
    "t",
  );
  assert.equal(
    (await post(router, "/shipments", body(), requestKey)).status,
    410,
  );
  assert.equal(await postgres.query(sql`select count(*) from shipments`), "1");
});

test("checkout replay reuses one pending payment and never calls Stripe again", async () => {
  const router = app();
  const shipmentId = await shipment(router);
  const requestKey = key("checkout-replay");
  const first = await post(
    router,
    "/payments/initialize",
    { shipmentId },
    requestKey,
  );
  assert.equal(first.status, 200);
  const result = await first.json();
  const replay = await post(
    router,
    "/payments/initialize",
    { shipmentId },
    requestKey,
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), result);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.sessions.size, 1);
  assert.equal(await postgres.query(sql`select count(*) from payments`), "1");
  assert.match(provider.requests[0].key, /^isotrack_/);
  assert.equal(provider.requests[0].version, "2026-10-28.endive");
});

test("concurrent checkout requests cannot start a second provider call", async (t) => {
  const router = app();
  const shipmentId = await shipment(router);
  const requestKey = key("checkout-race");
  const release = provider.hold();
  t.after(release);
  const first = post(
    router,
    "/payments/initialize",
    { shipmentId },
    requestKey,
  );
  await until(() => provider.requests.length === 1);
  const second = await post(
    router,
    "/payments/initialize",
    { shipmentId },
    requestKey,
  );
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, "IDEMPOTENCY_IN_PROGRESS");
  release();
  assert.equal((await first).status, 200);
  assert.equal(provider.requests.length, 1);
});

test("provider accepted response loss retries identical parameters across a new service instance", async () => {
  const router = app();
  const shipmentId = await shipment(router);
  const requestKey = key("provider-loss");
  provider.dropNextResponse();
  const first = await post(
    router,
    "/payments/initialize",
    { shipmentId },
    requestKey,
  );
  assert.equal(first.status, 502);
  const reference = (await first.json()).details.reference;
  await postgres.query(
    sql`update users set email='new-address@example.test' where id='owner-a'`,
  );
  // Email changes invalidate old sessions on the complete schema. Model a
  // fresh login before checking immutable provider parameters across retries.
  await reauthenticateOwner();
  const retry = await post(
    app({ frontendUrl: "https://new-domain.example.test" }),
    "/payments/initialize",
    { shipmentId },
    requestKey,
  );
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).data.reference, reference);
  assert.equal(provider.requests.length, 3);
  assert.equal(provider.sessions.size, 1);
  assert.ok(
    provider.requests.every(
      (request) => request.key === provider.requests[0].key,
    ),
  );
  assert.ok(
    provider.requests.every(
      (request) => request.body === provider.requests[0].body,
    ),
  );
  assert.equal(await postgres.query(sql`select count(*) from payments`), "1");
});

test("lost checkout database responses recover before or after atomic attachment", async () => {
  for (const afterCommit of [false, true]) {
    const normal = app();
    const shipmentId = await shipment(normal, `attachment-${afterCommit}`);
    const requestKey = key(`attach-${afterCommit}`);
    let failed = false;
    const fault = {
      execute: async (statement) => {
        const finish = sqlText(statement).includes(
          "update payments p set stripe_session_id=",
        );
        if (finish && !failed && !afterCommit) {
          failed = true;
          throw new Error("Storage unavailable before attachment");
        }
        const rows = await store.execute(statement);
        if (finish && !failed && afterCommit) {
          failed = true;
          throw new Error("Storage response lost after attachment");
        }
        return rows;
      },
    };
    const before = provider.requests.length;
    assert.equal(
      (
        await post(
          app({ store: fault }),
          "/payments/initialize",
          { shipmentId },
          requestKey,
        )
      ).status,
      500,
    );
    assert.equal(
      (await post(normal, "/payments/initialize", { shipmentId }, requestKey))
        .status,
      200,
    );
    assert.equal(provider.requests.length - before, afterCommit ? 1 : 2);
  }
  assert.equal(await postgres.query(sql`select count(*) from payments`), "2");
  assert.equal(provider.sessions.size, 2);
});

test("unsafe-age pending retries and provider credential changes require reconciliation", async () => {
  const router = app();
  const shipmentId = await shipment(router);
  const requestKey = key("cutoff");
  provider.dropNextResponse();
  assert.equal(
    (await post(router, "/payments/initialize", { shipmentId }, requestKey))
      .status,
    502,
  );
  const changed = await post(
    app({ providerContext: "rotated-credential" }),
    "/payments/initialize",
    { shipmentId },
    requestKey,
  );
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error, "RECONCILIATION_REQUIRED");
  await postgres.query(
    sql`update idempotency_requests set created_at=now()-interval '23 hours 30 minutes',expires_at=now()+interval '30 minutes' where operation='payments.initialize'`,
  );
  const expired = await post(
    router,
    "/payments/initialize",
    { shipmentId },
    requestKey,
  );
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).error, "RECONCILIATION_REQUIRED");
  assert.equal(provider.requests.length, 2);
});

test("ownership and current price are rechecked before cached or retried checkout access", async () => {
  const router = app();
  const shipmentId = await shipment(router);
  const requestKey = key("ownership");
  assert.equal(
    (
      await post(
        router,
        "/payments/initialize",
        { shipmentId },
        requestKey,
        "customer-a",
      )
    ).status,
    200,
  );
  await postgres.query(
    sql`update shipments set customer_id='customer-b' where id=${shipmentId}`,
  );
  assert.equal(
    (
      await post(
        router,
        "/payments/initialize",
        { shipmentId },
        requestKey,
        "customer-a",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await post(
        router,
        "/payments/initialize",
        { shipmentId },
        key("foreign"),
        "owner-b",
      )
    ).status,
    404,
  );
  provider.dropNextResponse();
  const priceKey = key("price-change");
  await lifecycle().reconcile(
    [...provider.sessions.values()][0].session.client_reference_id,
    true,
  );
  assert.equal(
    (await post(router, "/payments/initialize", { shipmentId }, priceKey))
      .status,
    502,
  );
  await postgres.query(
    sql`update shipments set price_kobo=200 where id=${shipmentId}`,
  );
  assert.equal(
    (await post(router, "/payments/initialize", { shipmentId }, priceKey))
      .status,
    409,
  );
  assert.equal(provider.requests.length, 3);
});

test("provider amount, currency, mode, metadata and redirect mismatches cannot be cached", async () => {
  const router = app();
  const changes = [
    (s) => ({ ...s, amount_total: 200 }),
    (s) => ({ ...s, currency: "usd" }),
    (s) => ({ ...s, livemode: true }),
    (s) => ({ ...s, metadata: { ...s.metadata, shipmentId: "other" } }),
    (s) => ({ ...s, url: "javascript:alert(1)" }),
  ];
  for (const [index, change] of changes.entries()) {
    const shipmentId = await shipment(router, `bad-provider-${index}`);
    provider.transform(change);
    const response = await post(
      router,
      "/payments/initialize",
      { shipmentId },
      key(`bad-provider-${index}`),
    );
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, "INVALID_CHECKOUT_RESPONSE");
  }
  assert.equal(
    await postgres.query(
      sql`select count(*) from idempotency_requests where operation='payments.initialize' and state='completed'`,
    ),
    "0",
  );
  assert.equal(
    await postgres.query(
      sql`select count(*) from payments where stripe_session_id is not null`,
    ),
    "0",
  );
});

function lifecycle(options = {}) {
  return createPaymentLifecycle({
    store,
    client: provider.client,
    providerContext: "test-provider",
    liveMode: false,
    ...options,
  });
}

test("signed expiry webhook releases only its bound checkout and replays safely", async () => {
  const first = await checkout();
  first.session.status = "expired";
  const secret = "whsec_payment_lifecycle_fixture";
  const router = createStripeWebhookRouter({
    secret,
    expectedLiveMode: false,
    parseSession: (session, time) =>
      parseStripeSession(session, undefined, time),
    confirm: async () => {
      throw new Error("Legacy path");
    },
    observe: lifecycle().observe,
  });
  const body = JSON.stringify({
    id: "evt_expired",
    object: "event",
    type: "checkout.session.expired",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: first.session },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
  });
  const send = (value = body) =>
    router.request("/webhook", {
      method: "POST",
      body: value,
      headers: { "stripe-signature": signature },
    });
  assert.equal((await send(body + " ")).status, 400);
  assert.equal(
    await postgres.query(sql`select count(*) from payment_checkout_guards`),
    "1",
  );
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal(
    await postgres.query(sql`select count(*) from payment_checkout_guards`),
    "0",
  );
});
async function checkout(label = "lifecycle") {
  const router = app();
  const shipmentId = await shipment(router, label);
  const response = await post(
    router,
    "/payments/initialize",
    { shipmentId },
    key(label),
  );
  assert.equal(response.status, 200);
  return {
    router,
    shipmentId,
    ...(await response.json()).data,
    session: [...provider.sessions.values()].at(-1).session,
  };
}

test("different keys and payers race for one shipment checkout", async () => {
  const router = app();
  const shipmentId = await shipment(router);
  const results = await Promise.all([
    post(
      router,
      "/payments/initialize",
      { shipmentId },
      key("payer-a"),
      "owner-a",
    ),
    post(
      router,
      "/payments/initialize",
      { shipmentId },
      key("payer-b"),
      "customer-a",
    ),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const denied = results.find((r) => r.status === 409);
  assert.equal((await denied.json()).error, "CHECKOUT_ALREADY_ACTIVE");
  assert.equal(provider.sessions.size, 1);
  assert.equal(
    await postgres.query(sql`select count(*) from payment_checkout_guards`),
    "1",
  );
});

test("provider-confirmed cancellation closes the old key and permits a new checkout", async () => {
  const first = await checkout();
  await lifecycle().reconcile(first.reference, true);
  assert.equal(
    await postgres.query(sql`select status||':'||checkout_state from payments`),
    "failed:expired",
  );
  assert.equal(
    (
      await post(
        first.router,
        "/payments/initialize",
        { shipmentId: first.shipmentId },
        key("lifecycle"),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await post(
        first.router,
        "/payments/initialize",
        { shipmentId: first.shipmentId },
        key("replacement"),
      )
    ).status,
    200,
  );
  assert.equal(provider.sessions.size, 2);
});

test("complete but unpaid checkout holds the guard after cancel and sweep", async () => {
  const first = await checkout();
  first.session.status = "complete";
  await lifecycle().reconcile(first.reference, true);
  await lifecycle().sweep();
  assert.equal(
    await postgres.query(sql`select checkout_state from payments`),
    "processing",
  );
  assert.equal(
    (
      await post(
        first.router,
        "/payments/initialize",
        { shipmentId: first.shipmentId },
        key("second"),
      )
    ).status,
    409,
  );
});

test("missed paid webhook is recovered by the database-backed sweep exactly once", async () => {
  const first = await checkout();
  first.session.status = "complete";
  first.session.payment_status = "paid";
  assert.deepEqual(await lifecycle().sweep(), { attempted: 1, failed: 0 });
  await lifecycle().observe(first.session);
  assert.equal(
    await postgres.query(sql`select count(*) from shipment_payment_receipts`),
    "1",
  );
  assert.equal(
    await postgres.query(
      sql`select count(*) from notification_outbox where kind='payment_confirmed'`,
    ),
    "3",
  );
  assert.equal(
    await postgres.query(
      sql`select is_paid from shipments where id=${first.shipmentId}`,
    ),
    "t",
  );
});

test("lost create response is recovered with the original provider key and body", async () => {
  const router = app();
  const shipmentId = await shipment(router);
  provider.dropNextResponse();
  assert.equal(
    (await post(router, "/payments/initialize", { shipmentId }, key("lost")))
      .status,
    502,
  );
  assert.deepEqual(await lifecycle().sweep(), { attempted: 1, failed: 0 });
  assert.equal(provider.sessions.size, 1);
  assert.equal(
    await postgres.query(
      sql`select stripe_session_id is not null from payments`,
    ),
    "t",
  );
  assert.ok(
    provider.requests.every(
      (r) =>
        r.body === provider.requests[0].body &&
        r.key === provider.requests[0].key,
    ),
  );
});

test("expired provider retry window holds the shipment without another create", async () => {
  const router = app();
  const shipmentId = await shipment(router);
  provider.dropNextResponse();
  assert.equal(
    (
      await post(
        router,
        "/payments/initialize",
        { shipmentId },
        key("lost-old"),
      )
    ).status,
    502,
  );
  await postgres.query(
    sql`update idempotency_requests set created_at=now()-interval '24 hours' where operation='payments.initialize'`,
  );
  assert.deepEqual(await lifecycle().sweep(), { attempted: 1, failed: 1 });
  assert.equal(provider.requests.length, 2);
  assert.equal(
    (
      await post(
        router,
        "/payments/initialize",
        { shipmentId },
        key("unsafe-new"),
      )
    ).status,
    409,
  );
  const recovered = [...provider.sessions.values()][0].session;
  recovered.status = "complete";
  recovered.payment_status = "paid";
  await lifecycle().attach(recovered.client_reference_id, recovered.id);
  assert.equal(provider.requests.length, 2);
  assert.equal(
    await postgres.query(sql`select count(*) from shipment_payment_receipts`),
    "1",
  );
});

test("a late payment after replacement is recorded for review without duplicate fulfillment", async () => {
  const first = await checkout();
  await lifecycle().reconcile(first.reference, true);
  const next = await post(
    first.router,
    "/payments/initialize",
    { shipmentId: first.shipmentId },
    key("replacement"),
  );
  assert.equal(next.status, 200);
  const second = [...provider.sessions.values()].at(-1).session;
  second.status = "complete";
  second.payment_status = "paid";
  await lifecycle().observe(second);
  first.session.status = "complete";
  first.session.payment_status = "paid";
  await lifecycle().observe(first.session);
  await lifecycle().observe(first.session);
  assert.equal(
    await postgres.query(sql`select count(*) from shipment_payment_receipts`),
    "1",
  );
  assert.equal(
    await postgres.query(
      sql`select checkout_state||':'||review_reason from payments where provider_reference=${first.reference}`,
    ),
    "review:additional_payment",
  );
  assert.equal(
    await postgres.query(
      sql`select count(*) from notification_outbox where kind='payment_confirmed'`,
    ),
    "3",
  );
});

test("paid checkout on a cancelled shipment requires review and leaves shipment unpaid", async () => {
  const first = await checkout();
  await postgres.query(
    sql`update shipments set status='cancelled' where id=${first.shipmentId}`,
  );
  first.session.status = "complete";
  first.session.payment_status = "paid";
  await lifecycle().observe(first.session);
  assert.equal(
    await postgres.query(
      sql`select checkout_state||':'||review_reason from payments`,
    ),
    "review:shipment_not_payable",
  );
  assert.equal(
    await postgres.query(
      sql`select is_paid from shipments where id=${first.shipmentId}`,
    ),
    "f",
  );
  assert.equal(
    await postgres.query(sql`select count(*) from shipment_payment_receipts`),
    "0",
  );
});

test("wrong provider mode or shipment cannot release a guard", async () => {
  const first = await checkout();
  await assert.rejects(
    lifecycle().observe({
      ...first.session,
      status: "expired",
      livemode: true,
    }),
  );
  await assert.rejects(
    lifecycle().observe({
      ...first.session,
      status: "expired",
      metadata: { ...first.session.metadata, shipmentId: "foreign" },
    }),
  );
  assert.equal(
    await postgres.query(sql`select count(*) from payment_checkout_guards`),
    "1",
  );
});

test("expired Checkout with a processing PaymentIntent cannot release the shipment", async () => {
  const first = await checkout();
  first.session.status = "expired";
  first.session.payment_intent = "pi_processing";
  provider.intents.set("pi_processing", {
    id: "pi_processing",
    object: "payment_intent",
    status: "processing",
    amount: 100,
    amount_received: 0,
    currency: "ngn",
    livemode: false,
  });
  await lifecycle().reconcile(first.reference);
  assert.equal(
    await postgres.query(sql`select count(*) from payment_checkout_guards`),
    "1",
  );
  provider.intents.get("pi_processing").status = "canceled";
  first.session.status = "complete";
  await lifecycle().reconcile(first.reference);
  assert.equal(
    await postgres.query(sql`select count(*) from payment_checkout_guards`),
    "0",
  );
});

test("reconciliation leases survive provider errors and are reclaimed after expiry", async () => {
  const first = await checkout();
  await postgres.query(
    sql`update payments set reconcile_token='dead-worker',reconcile_until=now()+interval '1 hour'`,
  );
  assert.deepEqual(await lifecycle().sweep(), { attempted: 0, failed: 0 });
  await postgres.query(
    sql`update payments set reconcile_until=now()-interval '1 second'`,
  );
  provider.transform((s) => ({ ...s, amount_total: 999 }));
  assert.deepEqual(await lifecycle().sweep(), { attempted: 1, failed: 1 });
  assert.equal(
    await postgres.query(
      sql`select reconcile_token is null and reconcile_until is null from payments`,
    ),
    "t",
  );
  assert.equal(
    await postgres.query(sql`select count(*) from payment_checkout_guards`),
    "1",
  );
  provider.transform((s) => s);
  first.session.status = "expired";
  await postgres.query(sql`update payments set reconcile_after=now()`);
  assert.deepEqual(await lifecycle().sweep(), { attempted: 1, failed: 0 });
  assert.equal(
    await postgres.query(sql`select count(*) from payment_checkout_guards`),
    "0",
  );
});

test("review resolution requires a successful full Stripe refund of the matching intent", async () => {
  const first = await checkout();
  first.session.payment_intent = "pi_review";
  await postgres.query(
    sql`update shipments set status='cancelled' where id=${first.shipmentId}`,
  );
  first.session.status = "complete";
  first.session.payment_status = "paid";
  await lifecycle().observe(first.session);
  assert.equal(
    await postgres.query(sql`select count(*) from payment_checkout_guards`),
    "1",
  );
  const refund = {
    id: "re_review",
    object: "refund",
    amount: 100,
    currency: "ngn",
    status: "pending",
    payment_intent: "pi_review",
  };
  provider.refunds.set(refund.id, refund);
  await assert.rejects(
    lifecycle().recordRefund(first.reference, refund.id, "portfolio-operator"),
  );
  refund.status = "succeeded";
  refund.amount = 99;
  await assert.rejects(
    lifecycle().recordRefund(first.reference, refund.id, "portfolio-operator"),
  );
  refund.amount = 100;
  refund.payment_intent = "pi_foreign";
  await assert.rejects(
    lifecycle().recordRefund(first.reference, refund.id, "portfolio-operator"),
  );
  refund.payment_intent = "pi_review";
  await postgres.query(
    sql.raw(`create function reject_review_release() returns trigger language plpgsql as $$
    begin raise exception 'forced guard release failure'; end $$;
    create trigger reject_review_release before delete on payment_checkout_guards for each row execute function reject_review_release();`),
  );
  await assert.rejects(
    lifecycle().recordRefund(first.reference, refund.id, "portfolio-operator"),
  );
  assert.equal(
    await postgres.query(
      sql`select status='pending' and refund_id is null from payments`,
    ),
    "t",
  );
  await postgres.query(
    sql.raw(
      "drop trigger reject_review_release on payment_checkout_guards; drop function reject_review_release()",
    ),
  );
  await lifecycle().recordRefund(
    first.reference,
    refund.id,
    "portfolio-operator",
  );
  assert.equal(
    await postgres.query(sql`select count(*) from payment_checkout_guards`),
    "0",
  );
  await assert.rejects(
    lifecycle().recordRefund(first.reference, refund.id, "another-operator"),
  );
  assert.equal(
    await postgres.query(
      sql`select status||':'||refund_id||':'||refund_recorded_by from payments`,
    ),
    "refunded:re_review:portfolio-operator",
  );
  await lifecycle().observe(first.session);
  assert.equal(
    await postgres.query(sql`select status from payments`),
    "refunded",
  );
  assert.equal(
    await postgres.query(sql`select count(*) from shipment_payment_receipts`),
    "0",
  );
});

test("concurrent successful receipts apply one payment and preserve the other for review", async () => {
  const first = await checkout();
  // Represents an older/external attempt that existed before the guard rollout.
  await postgres.query(
    sql`insert into payments(id,shipment_id,provider_reference,amount_kobo) values('historic-attempt',${first.shipmentId},'HISTORIC-REFERENCE',100)`,
  );
  const other = {
    ...first.session,
    id: "cs_historic",
    client_reference_id: "HISTORIC-REFERENCE",
    metadata: { reference: "HISTORIC-REFERENCE", shipmentId: first.shipmentId },
    status: "complete",
    payment_status: "paid",
  };
  first.session.status = "complete";
  first.session.payment_status = "paid";
  await Promise.all([
    lifecycle().observe(first.session),
    lifecycle().observe(other),
  ]);
  assert.equal(
    await postgres.query(sql`select count(*) from shipment_payment_receipts`),
    "1",
  );
  assert.equal(
    await postgres.query(
      sql`select count(*) from payments where checkout_state='review' and review_reason='additional_payment' and received_at is not null`,
    ),
    "1",
  );
  assert.equal(
    await postgres.query(
      sql`select count(*) from notification_outbox where kind='payment_confirmed'`,
    ),
    "3",
  );
});
