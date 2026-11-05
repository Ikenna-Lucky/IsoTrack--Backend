import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serve } from "@hono/node-server";
import { SignJWT } from "jose";
import { sql } from "drizzle-orm";
import { postgresFixture } from "./helpers/postgres.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import { createShipmentCommandRouter } from "../src/routes/shipment-commands.ts";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.ts";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { activeSessionStatement } from "../src/db/queries/session-statements.ts";

const pg = postgresFixture({ prefix: "exception" });
const query = (text) => pg.query(sql.raw(text));
const store = {
  execute: async (statement) => {
    const result = await pg.query(statement);
    return result ? result.split("\n").map((line) => JSON.parse(line)) : [];
  },
};
const secret = new TextEncoder().encode(
  "shipment-command-signature-fixture-32",
);
const tokens = new Map();
let server,
  base,
  failAfterCommit = false;
before(async () => {
  await pg.start();
  await runMigrations(
    {
      execute: async (statement) =>
        JSON.parse(
          await pg.query(
            sql`select coalesce(json_agg(r),'[]') from (${statement}) r`,
          ),
        ),
      transaction: (statements) =>
        pg.query(
          sql.join(
            [sql.raw("begin"), ...statements, sql.raw("commit")],
            sql.raw(";"),
          ),
        ),
    },
    fileURLToPath(new URL("../drizzle", import.meta.url)),
  );
  await query(`insert into users(id,email,password_hash,name,role) values
    ('owner','owner@example.test','hash','Owner','business'),('other','other@example.test','hash','Other','business'),
    ('rider','rider@example.test','hash','Rider','driver'),('customer','customer@example.test','hash','Customer','customer');
    insert into businesses(id,user_id,business_name) values('biz','owner','A'),('other-biz','other','B');
    insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate) values('driver','rider','biz','bike','TEST');
    insert into auth_sessions(id,user_id,credential_version,expires_at) select 'session_'||id,id,0,now()+interval '1 day' from users;`);
  for (const [id, role] of [
    ["owner", "business"],
    ["other", "business"],
    ["rider", "driver"],
    ["customer", "customer"],
  ]) {
    tokens.set(
      id,
      await new SignJWT({ type: "access", role, sid: `session_${id}` })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(id)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(secret),
    );
  }
  const app = new Hono();
  app.onError((e, c) =>
    e instanceof HTTPException
      ? e.getResponse()
      : c.json({ error: "SERVER_FAILURE" }, 500),
  );
  app.use(
    "*",
    createAuthenticationMiddleware({
      verifyToken: (t) => verifySessionToken(t, secret, "access"),
      findUser: async (id) => {
        const result = await pg.query(
          sql`select jsonb_build_object('id',id,'role',role,'email',email,'isActive',is_active) from users where id=${id}`,
        );
        return result ? JSON.parse(result) : null;
      },
      isSessionActive: async (sid, id) =>
        Boolean(await pg.query(activeSessionStatement(sid, id))),
    }),
  );
  app.route(
    "/shipments",
    createShipmentCommandRouter({
      execute: async (statement) => {
        const result = await store.execute(statement);
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new Error("Injected lost database acknowledgement");
        }
        return result;
      },
    }),
  );
  app.route(
    "/shipments",
    createShipmentExceptionRouter({
      execute: async (statement) => {
        const result = await store.execute(statement);
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new Error("lost acknowledgement");
        }
        return result;
      },
    }),
  );
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  failAfterCommit = false;
  await query(`truncate shipments,idempotency_requests cascade;
    insert into shipments(id,tracking_id,business_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo)
    values('shipment','IST-COMMAND','biz','customer','Box',1,'{}','{}',100);`);
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await pg.stop();
});

import { createShipmentExceptionRouter } from "../src/routes/shipment-exceptions.ts";
import { createOutboxProcessor } from "../src/workers/outbox-processor.ts";
import { createShipmentListRouter } from "../src/routes/shipment-list.ts";
import { recordSocketLocationStatement } from "../src/db/queries/socket-access.ts";
import { backlogStatement } from "../src/observability/backlog.ts";
const key = (x) => x.padEnd(24, "_");
function action(name, v, label = name, actor = "owner", extra = {}) {
  return fetch(`${base}/shipments/shipment/exceptions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(actor ? { Authorization: `Bearer ${tokens.get(actor)}` } : {}),
      "Idempotency-Key": key(label),
    },
    body: JSON.stringify({ action: name, expectedVersion: v, ...extra }),
  });
}
async function command(name, v, label = name, actor = "owner", extra = {}) {
  const r = await action(name, v, label, actor, extra);
  assert.equal(r.status, 200);
  return (await r.json()).data;
}
async function setup(custody = true) {
  await query(
    `update shipments set status='${custody ? "out_for_delivery" : "assigned"}',driver_id='driver',actual_pickup=${custody ? "now()" : "null"} where id='shipment'`,
  );
  return Number(await query("select version from shipments"));
}
const fail = (v, label = "fail", actor = "rider") =>
  command("fail", v, label, actor, {
    reason: "recipient_unavailable",
    note: "Private operational note",
  });
const current = async () =>
  JSON.parse(
    await query(
      "select row_to_json(s)::text from shipments s where id='shipment'",
    ),
  );
test("structured failures require current versions, roles and reasons without denied writes", async () => {
  const v = await setup();
  assert.equal((await action("fail", v)).status, 400);
  assert.equal(
    (await action("fail", v, "bad", "rider", { reason: "other" })).status,
    400,
  );
  assert.equal(
    (
      await action("fail", v, "foreign", "other", {
        reason: "recipient_refused",
      })
    ).status,
    404,
  );
  assert.equal((await action("retry", v, "customer", "customer")).status, 403);
  assert.equal(
    (await action("fail", v, "anon", null, { reason: "recipient_refused" }))
      .status,
    401,
  );
  assert.equal(await query("select count(*) from shipment_exceptions"), "0");
  const result = await fail(v);
  assert.equal(result.failureReason, "recipient_unavailable");
  assert.equal(result.status, "failed");
  const audit = JSON.parse(
    await query("select row_to_json(e)::text from shipment_exceptions e"),
  );
  assert.equal(audit.actor_id, "rider");
  assert.equal(audit.note, "Private operational note");
  assert.ok(
    !(
      await query("select json_agg(message)::text from shipment_events")
    ).includes("Private operational note"),
  );
});
test("pre-pickup retries clear assignment, advance bounded attempts and can be cancelled", async () => {
  let s = await fail(await setup(false));
  s = await command("retry", s.version);
  assert.equal(s.status, "pending");
  assert.equal(s.driverId, null);
  assert.equal(s.attemptNumber, 2);
  // A new assignment is a separate versioned action.
  await query("update shipments set status='assigned',driver_id='driver'");
  s = await fail(
    Number(await query("select version from shipments")),
    "second",
  );
  s = await command("retry", s.version, "retry-second");
  assert.equal(s.attemptNumber, 3);
  await query("update shipments set status='assigned',driver_id='driver'");
  s = await fail(Number(await query("select version from shipments")), "third");
  assert.equal((await action("retry", s.version, "retry-third")).status, 422);
  s = await command("cancel_failed", s.version);
  assert.equal(s.status, "cancelled");
});
test("custody retries retain driver and pickup while revoking every old recipient code", async () => {
  const v = await setup();
  const gps = {
    lat: 6,
    lng: 3,
    timestamp: Date.now(),
    receivedAt: Date.now() - 2000,
  };
  await pg.query(
    sql`update shipments set current_location=${JSON.stringify(gps)}::jsonb`,
  );
  await pg.query(sql`insert into delivery_confirmations(id,shipment_id,driver_id,shipment_version,email,code_hash,expires_at)
 values('old','shipment','driver',${v},'guest@example.test',repeat('a',64),now()+interval '1 hour')`);
  const before = (await current()).actual_pickup;
  let s = await fail(v);
  assert.ok(
    await query("select revoked_at from delivery_confirmations where id='old'"),
  );
  s = await command("retry", s.version);
  assert.equal(s.status, "picked_up");
  assert.equal(s.driverId, "driver");
  assert.equal(s.actualPickup, before);
  assert.equal(s.attemptNumber, 2);
  assert.deepEqual(s.currentLocation, gps);
  assert.equal(
    (await action("retry", s.version, "driver-retry", "rider")).status,
    403,
  );
});
test("returns require business receipt and never change money or permit reopening", async () => {
  await query(
    "update shipments set is_paid=true; insert into payments(id,shipment_id,provider_reference,amount_kobo,status) values('payment','shipment','RETURN-PAYMENT',100,'success')",
  );
  let s = await fail(await setup());
  s = await command("return_request", s.version);
  assert.equal(s.returnState, "requested");
  assert.equal(
    (await action("return_receive", s.version, "driver-receipt", "rider"))
      .status,
    403,
  );
  s = await command("return_start", s.version, "start", "rider");
  assert.equal(s.returnState, "in_transit");
  s = await command("return_receive", s.version);
  assert.equal(s.returnState, "received");
  assert.ok(s.returnedAt);
  assert.equal(s.status, "failed");
  assert.equal(s.isPaid, true);
  assert.equal(
    await query("select status from payments where id='payment'"),
    "success",
  );
  assert.equal((await action("retry", s.version, "after-return")).status, 422);
  await assert.rejects(
    query(
      "update shipments set status='pending',return_state='none',returned_at=null",
    ),
    /Returned shipment cannot be reopened/,
  );
  const payloads = JSON.parse(
    await query("select json_agg(payload) from notification_outbox"),
  );
  assert.ok(payloads.some((x) => x.status === "return_received"));
  const notice = await query(
    "select id from notification_outbox where payload->>'status'='return_received' and channel='email'",
  );
  let sent;
  await createOutboxProcessor(store, async (email) => {
    sent = email;
  })(notice);
  assert.equal(sent.title, "Business received returned package");
  assert.ok(!sent.message.includes("Private operational note"));
});
test("same-key replay and distinct-key races yield one audited action", async () => {
  const v = await setup();
  const responses = await Promise.all([
    action("fail", v, "same", "rider", { reason: "recipient_refused" }),
    action("fail", v, "same", "rider", { reason: "recipient_refused" }),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  assert.deepEqual(
    responses.map((r) => r.headers.get("Idempotency-Replayed")).sort(),
    ["false", "true"],
  );
  const version = (await current()).version;
  const race = await Promise.all([
    action("retry", version, "race-retry"),
    action("return_request", version, "race-return"),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await query("select count(*) from shipment_exceptions"), "2");
});
test("commit loss recovers and history/outbox failure rolls back audit, custody and codes", async () => {
  const v = await setup();
  failAfterCommit = true;
  assert.equal(
    (await action("fail", v, "lost", "rider", { reason: "recipient_refused" }))
      .status,
    500,
  );
  const replay = await action("fail", v, "lost", "rider", {
    reason: "recipient_refused",
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  const s = (await replay.json()).data;
  await query(
    "create function reject_return_notice() returns trigger language plpgsql as $$begin raise exception 'fixture';end$$;create trigger reject_return_notice before insert on notification_outbox for each row execute function reject_return_notice()",
  );
  try {
    assert.equal((await action("return_request", s.version)).status, 500);
    assert.equal((await current()).return_state, "none");
    assert.equal(await query("select count(*) from shipment_exceptions"), "1");
  } finally {
    await query(
      "drop trigger reject_return_notice on notification_outbox;drop function reject_return_notice()",
    );
  }
  assert.equal((await action("return_request", s.version)).status, 200);
});
test("driver worklist retains held packages; return movement GPS stops after business receipt", async () => {
  let s = await fail(await setup());
  s = await command("return_request", s.version);
  const list = new Hono();
  list.use("*", async (c, next) => {
    c.set("userId", "rider");
    c.set("userRole", "driver");
    await next();
  });
  list.route("/", createShipmentListRouter(store));
  assert.equal((await (await list.request("/")).json()).data.length, 1);
  s = await command("return_start", s.version, "driver-start", "rider");
  await query("update shipments set failed_at=now()-interval '25 hours'");
  const identity = {
    userId: "rider",
    sessionId: "session_rider",
    expiresAt: Date.now() / 1000 + 3600,
  };
  const location = {
    trackingId: "IST-COMMAND",
    lat: 6,
    lng: 3,
    timestamp: Date.now(),
  };
  assert.equal(
    await pg.query(recordSocketLocationStatement(identity, location)),
    "shipment",
  );
  const held = (await store.execute(backlogStatement())).find(
    (row) => row.queue === "held_packages",
  );
  assert.equal(held.present, true);
  assert.ok(Number(held.age) > 86400);
  await command("return_receive", s.version);
  assert.equal((await (await list.request("/")).json()).data.length, 0);
  assert.equal(
    (await store.execute(backlogStatement())).find(
      (row) => row.queue === "held_packages",
    ).present,
    false,
  );
  assert.equal(
    await pg.query(
      recordSocketLocationStatement(identity, {
        ...location,
        timestamp: Date.now(),
      }),
    ),
    "",
  );
});
test("private audit history seeks by version and rechecks tenant access", async () => {
  let s = await fail(await setup());
  s = await command("return_request", s.version);
  await command("return_receive", s.version);
  const get = (q = "", actor = "owner") =>
    fetch(`${base}/shipments/shipment/exceptions${q}`, {
      headers: { Authorization: `Bearer ${tokens.get(actor)}` },
    });
  const first = await (await get("?limit=2")).json();
  assert.equal(first.data.length, 2);
  assert.equal(first.pagination.hasMore, true);
  const last = await (
    await get(`?limit=2&beforeVersion=${first.pagination.nextBeforeVersion}`)
  ).json();
  assert.equal(last.data.length, 1);
  assert.equal(last.pagination.hasMore, false);
  assert.equal((await get("", "other")).status, 404);
  assert.equal((await get("", "customer")).status, 403);
  assert.equal((await get("?limit=0")).status, 400);
  assert.equal((await get("?limit=1&limit=2")).status, 400);
});
test("direct retries cannot discard custody or skip the attempt budget; generic fail/retry paths are closed", async () => {
  const s = await fail(await setup());
  await assert.rejects(
    query(
      "update shipments set status='pending',driver_id=null,actual_pickup=null",
    ),
    /custody/,
  );
  await assert.rejects(
    query("update shipments set status='picked_up'"),
    /bounded attempt/,
  );
  const r = await fetch(`${base}/shipments/shipment/status`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${tokens.get("owner")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key("legacy-retry"),
    },
    body: JSON.stringify({ expectedVersion: s.version, status: "pending" }),
  });
  assert.equal(r.status, 422);
});
test("changed payloads conflict and expired exception keys stay non-reusable", async () => {
  const v = await setup();
  await fail(v, "original");
  const changed = await action("fail", v, "original", "rider", {
    reason: "recipient_refused",
    note: "Private operational note",
  });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error, "IDEMPOTENCY_KEY_CONFLICT");
  await query(
    "update idempotency_requests set created_at=now()-interval '2 days',expires_at=now()-interval '1 day'",
  );
  const expired = await action("fail", v, "original", "rider", {
    reason: "recipient_unavailable",
    note: "Private operational note",
  });
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error, "IDEMPOTENCY_EXPIRED");
  assert.equal(await query("select count(*) from shipment_exceptions"), "1");
});
