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
import { createShipmentExceptionRouter } from "../src/routes/shipment-exceptions.ts";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.ts";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { activeSessionStatement } from "../src/db/queries/session-statements.ts";

const pg = postgresFixture({ prefix: "shipment-command" });
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
  app.route("/shipments", createShipmentExceptionRouter(store));
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
const key = (label) => label.padEnd(24, "_");
function send(action, body, k = key(action), actor = "owner") {
  return fetch(
    `${base}/shipments/shipment${action === "cancel" ? "" : `/${action}`}`,
    {
      method: action === "cancel" ? "DELETE" : "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(actor ? { Authorization: `Bearer ${tokens.get(actor)}` } : {}),
        ...(k ? { "Idempotency-Key": k } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}
const assign = (v = 0, k = key("assign")) =>
  send("assign", { expectedVersion: v, driverId: "driver" }, k);
async function state() {
  return JSON.parse(
    await query(
      `select jsonb_build_object('version',version,'status',status,'events',(select count(*) from shipment_events),'outbox',(select count(*) from notification_outbox),'requests',(select count(*) from idempotency_requests)) from shipments where id='shipment'`,
    ),
  );
}

test("HTTP validation/authentication and tenant denial leave no writes", async () => {
  assert.equal(
    (await send("assign", { expectedVersion: 0, driverId: "driver" }, null))
      .status,
    400,
  );
  for (const v of [undefined, -1, 0.5, "0", 2147483647])
    assert.equal(
      (await send("assign", { expectedVersion: v, driverId: "driver" })).status,
      400,
    );
  assert.equal(
    (
      await send("assign", {
        expectedVersion: 0,
        driverId: "driver",
        unexpected: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (await send("cancel", { expectedVersion: 0 }, key("anonymous"), null))
      .status,
    401,
  );
  assert.equal(
    (await send("cancel", { expectedVersion: 0 }, key("customer"), "customer"))
      .status,
    403,
  );
  assert.equal(
    (await send("cancel", { expectedVersion: 0 }, key("tenant"), "other"))
      .status,
    404,
  );
  assert.deepEqual(await state(), {
    version: 0,
    status: "pending",
    events: 0,
    outbox: 0,
    requests: 0,
  });
});
test("assignment replay returns the original snapshot with one event and notification set", async () => {
  const first = await assign();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Idempotency-Replayed"), "false");
  const body = await first.json();
  assert.equal(body.data.version, 1);
  const second = await assign();
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(await second.json(), body);
  assert.deepEqual(await state(), {
    version: 1,
    status: "assigned",
    events: 1,
    outbox: 3,
    requests: 1,
  });
  assert.equal(
    (await send("assign", { expectedVersion: 1, driverId: "driver" })).status,
    409,
  );
});
test("same-key contention replays and distinct-key contention changes the shipment once", async () => {
  const responses = await Promise.all([assign(), assign()]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  assert.deepEqual(
    responses.map((r) => r.headers.get("Idempotency-Replayed")).sort(),
    ["false", "true"],
  );
  const competing = await Promise.all([
    send("status", { expectedVersion: 1, status: "picked_up" }, key("pickup")),
    send("cancel", { expectedVersion: 1 }, key("cancel")),
  ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
  const current = await state();
  assert.equal(current.version, 2);
  assert.equal(current.events, 2);
  assert.equal(current.requests, 2);
});
test("cycling status cannot revive a stale command and historical replay stays a snapshot", async () => {
  const original = await (await assign()).json();
  assert.equal(
    (
      await fetch(`${base}/shipments/shipment/exceptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.get("owner")}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key("fail"),
        },
        body: JSON.stringify({
          action: "fail",
          expectedVersion: 1,
          reason: "vehicle_issue",
        }),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/shipments/shipment/exceptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.get("owner")}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key("retry"),
        },
        body: JSON.stringify({ action: "retry", expectedVersion: 2 }),
      })
    ).status,
    200,
  );
  const stale = await assign(0, key("stale"));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "SHIPMENT_VERSION_CONFLICT");
  assert.deepEqual(await (await assign()).json(), original);
  assert.equal((await state()).version, 3);
  assert.equal((await assign(3, key("new-attempt"))).status, 200);
});
test("lost commit acknowledgement recovers without another write", async () => {
  failAfterCommit = true;
  assert.equal((await assign()).status, 500);
  const retry = await assign();
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(await state(), {
    version: 1,
    status: "assigned",
    events: 1,
    outbox: 3,
    requests: 1,
  });
});
test("notification failure rolls back shipment, history and saved response before retry", async () => {
  await query(`create function reject_command_notice() returns trigger language plpgsql as $$ begin raise exception 'injected notice failure'; end $$;
    create trigger reject_command_notice before insert on notification_outbox for each row execute function reject_command_notice();`);
  try {
    assert.equal((await assign()).status, 500);
    assert.deepEqual(await state(), {
      version: 0,
      status: "pending",
      events: 0,
      outbox: 0,
      requests: 0,
    });
  } finally {
    await query(
      "drop trigger reject_command_notice on notification_outbox; drop function reject_command_notice()",
    );
  }
  assert.equal((await assign()).status, 200);
});
test("assigned drivers can progress but cannot retry/cancel, and replay checks current access", async () => {
  assert.equal((await assign()).status, 200);
  assert.equal(
    (await send("cancel", { expectedVersion: 1 }, key("rider-cancel"), "rider"))
      .status,
    403,
  );
  const input = { expectedVersion: 1, status: "picked_up" };
  assert.equal(
    (await send("status", input, key("driver-pickup"), "rider")).status,
    200,
  );
  await assert.rejects(
    query("update shipments set driver_id=null where id='shipment'"),
    /Package custody must be preserved/,
  );
  for (const [index, action] of [
    "fail",
    "return_request",
    "return_receive",
  ].entries()) {
    const response = await fetch(`${base}/shipments/shipment/exceptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.get("owner")}`,
        "Idempotency-Key": key(`custody-${action}`),
      },
      body: JSON.stringify({
        action,
        expectedVersion: index + 2,
        ...(action === "fail" ? { reason: "vehicle_issue" } : {}),
      }),
    });
    assert.equal(response.status, 200, await response.text());
  }
  await query("update shipments set driver_id=null where id='shipment'");
  assert.equal(
    (await send("status", input, key("driver-pickup"), "rider")).status,
    404,
  );
  assert.equal((await state()).version, 6);
});
test("expired keys stay tombstones and unrelated GPS/payment changes preserve command version", async () => {
  assert.equal((await assign()).status, 200);
  await query(
    "update shipments set current_location='{\"lat\":6,\"lng\":3}',is_paid=true; update idempotency_requests set created_at=now()-interval '2 days',expires_at=now()-interval '1 day'",
  );
  assert.equal((await state()).version, 1);
  const expired = await assign();
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error, "IDEMPOTENCY_EXPIRED");
  assert.equal((await state()).events, 1);
});

test("delivery progression advances versions but final completion requires recipient proof", async () => {
  assert.equal(
    (
      await send(
        "status",
        { expectedVersion: 0, status: "delivered" },
        key("skip-ahead"),
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await send(
        "assign",
        { expectedVersion: 0, driverId: "missing-driver" },
        key("missing-driver"),
      )
    ).status,
    409,
  );
  assert.equal((await state()).requests, 0);
  assert.equal((await assign()).status, 200);
  assert.equal(
    (
      await send(
        "status",
        { expectedVersion: 1, status: "pending" },
        key("driver-retry"),
        "rider",
      )
    ).status,
    403,
  );
  let pickup;
  for (const [index, status] of [
    "picked_up",
    "in_transit",
    "out_for_delivery",
  ].entries()) {
    const response = await send(
      "status",
      { expectedVersion: index + 1, status },
      key(status),
      "rider",
    );
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.version, index + 2);
    assert.equal(data.status, status);
    if (index === 0) pickup = data.actualPickup;
    assert.ok(pickup);
    assert.equal(data.actualPickup, pickup);
    assert.equal(data.actualDelivery, null);
  }
  assert.equal(
    (
      await send(
        "status",
        { expectedVersion: 4, status: "delivered" },
        key("proof-required"),
      )
    ).status,
    422,
  );
  const current = await state();
  assert.equal(current.events, 4);
  assert.equal(current.requests, 4);
  assert.equal(current.version, 4);
});
