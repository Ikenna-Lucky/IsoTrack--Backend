import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serve } from "@hono/node-server";
import { SignJWT } from "jose";
import { sql } from "drizzle-orm";
import { postgresFixture } from "./helpers/postgres.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.ts";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { activeSessionStatement } from "../src/db/queries/session-statements.ts";
import { createShipmentDetailRouter } from "../src/routes/shipment-reads.ts";
import { shipmentEventsStatement } from "../src/db/queries/shipment-reads.ts";
import { publicTrackingStatement } from "../src/db/queries/public-tracking.ts";
import { createPublicTrackingRouter } from "../src/routes/public-tracking.ts";
import { parseShipmentEventPage } from "../src/lib/shipment-page.ts";
import { writeFile } from "node:fs/promises";
const pg = postgresFixture({ prefix: "tracking-history" });
const query = (text) => pg.query(sql.raw(text));
const secret = new TextEncoder().encode("tracking-history-fixture-key-32");
const tokens = new Map();
let server,
  base,
  unavailable = false;
before(async () => {
  await pg.start();
  await runMigrations(
    {
      execute: async (s) =>
        JSON.parse(
          await pg.query(sql`select coalesce(json_agg(r),'[]') from (${s}) r`),
        ),
      transaction: (s) =>
        pg.query(
          sql.join([sql.raw("begin"), ...s, sql.raw("commit")], sql.raw(";")),
        ),
    },
    fileURLToPath(new URL("../drizzle", import.meta.url)),
  );
  await query(`insert into users(id,email,password_hash,name,role) values
    ('owner','owner@example.test','PRIVATE-HASH','Owner','business'),('other','other@example.test','PRIVATE-HASH','Other','business'),
    ('rider','rider@example.test','PRIVATE-HASH','Rider','driver'),('customer','customer@example.test','PRIVATE-HASH','Customer','customer');
    insert into businesses(id,user_id,business_name) values('biz','owner','A'),('other-biz','other','B');
    insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate,vehicle_insurance,notification_preferences)
    values('driver','rider','biz','bike','TEST','PRIVATE-INSURANCE','{"private":"PRIVATE-PREF"}');
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
    "/shipments/*",
    createAuthenticationMiddleware({
      verifyToken: (t) => verifySessionToken(t, secret, "access"),
      findUser: async (id) => {
        const r = await pg.query(
          sql`select jsonb_build_object('id',id,'role',role,'email',email,'isActive',is_active) from users where id=${id}`,
        );
        return r ? JSON.parse(r) : null;
      },
      isSessionActive: async (sid, id) =>
        Boolean(await pg.query(activeSessionStatement(sid, id))),
    }),
  );
  app.route(
    "/shipments",
    createShipmentDetailRouter({
      execute: async (s) => {
        if (unavailable) throw new Error("private storage failure");
        const result = await pg.query(s);
        return result ? result.split("\n").map((r) => JSON.parse(r)) : [];
      },
    }),
  );
  app.route(
    "/track",
    createPublicTrackingRouter({
      execute: async (statement) => {
        if (unavailable) throw new Error("private storage failure");
        const result = await pg.query(statement);
        return result ? result.split("\n").map(JSON.parse) : [];
      },
    }),
  );
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  unavailable = false;
  // Active-state changes deliberately invalidate prior session generations.
  await query(`update auth_sessions s set credential_version=u.credential_version from users u where u.id=s.user_id;
    truncate shipments cascade;
    insert into shipments(id,tracking_id,business_id,driver_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo,created_at)
    select 's-'||lpad(i::text,3,'0'),'IST-'||i,'biz','driver','customer','Box',1,'{}','{}',100,'2026-11-01 12:00:00.123456+00' from generate_series(1,55)i;
    insert into shipments(id,tracking_id,business_id,description,weight_kg,pickup_address,delivery_address,price_kobo)
    values('foreign','IST-FOREIGN','other-biz','PRIVATE-PACKAGE',1,'{}','{}',100);
    update shipments set description='PRIVATE-PACKAGE',recipient_email='PRIVATE-RECIPIENT',
      pickup_address='{"street":"PRIVATE-STREET","phone":"PRIVATE-PHONE","lat":6.5}',
      delivery_address='{"street":"PRIVATE-DESTINATION","email":"PRIVATE-EMAIL"}',current_location='{"lat":6.5,"lng":3.4}';
    insert into shipment_events(id,shipment_id,status,message,location,created_at)
      select 'event-'||lpad(i::text,3,'0'),'s-055','assigned','PRIVATE-EVENT', '{"lat":6.5,"lng":3.4}',
      '2026-11-01 12:00:00.123456+00' from generate_series(1,55)i;
    insert into shipment_events(id,shipment_id,status,message) values('foreign-event','foreign','pending','PRIVATE-FOREIGN');`);
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((r) => server.close(r));
  await pg.stop();
});
const get = (path, actor = "owner") =>
  fetch(`${base}${path}`, {
    headers: actor ? { Authorization: `Bearer ${tokens.get(actor)}` } : {},
  });
async function data(path, actor = "owner") {
  const response = await get(path, actor);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return response.json();
}

test("anonymous tracking exposes only status/dates and a bounded standard-message history", async () => {
  const response = await get("/track/ist-55", null);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const { data: row } = await response.json();
  assert.deepEqual(Object.keys(row).sort(), [
    "actualDelivery",
    "estimatedDelivery",
    "events",
    "eventsTruncated",
    "scheduledPickup",
    "status",
    "trackingId",
  ]);
  assert.equal(row.trackingId, "IST-55");
  assert.equal(row.status, "pending");
  assert.equal(row.events.length, 20);
  assert.equal(row.eventsTruncated, true);
  for (const event of row.events) {
    assert.deepEqual(Object.keys(event).sort(), [
      "createdAt",
      "message",
      "status",
    ]);
    assert.equal(event.message, "Driver assigned");
  }
  const text = JSON.stringify(row);
  for (const privateValue of [
    "PRIVATE-",
    "s-055",
    "event-055",
    "Rider",
    "TEST",
    "6.5",
  ])
    assert.ok(!text.includes(privateValue));
  const empty = (await data("/track/IST-54", null)).data;
  assert.deepEqual(empty.events, []);
  assert.equal(empty.eventsTruncated, false);
});

test("public inputs are bounded, cannot expand fields, and unknown links are not found", async () => {
  for (const path of [
    "/track/bad%20id",
    `/track/${"A".repeat(65)}`,
    "/track/IST-55?limit=50",
    "/track/IST-55?fields=driver",
    "/track/%27or%20true--",
  ]) {
    const response = await get(path, null);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  const missing = await get("/track/IST-MISSING", null);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("Cache-Control"), "no-store");
});

test("all authorized roles page the complete detailed history without ties causing duplicates", async () => {
  for (const actor of ["owner", "rider", "customer"]) {
    let path = "/shipments/s-055/events?limit=20";
    const ids = [];
    while (path) {
      const page = await data(path, actor);
      assert.ok(page.data.length <= 20);
      assert.equal(page.pagination.total, undefined);
      assert.equal(page.pagination.limit, 20);
      for (const event of page.data) {
        assert.equal(event.shipmentId, "s-055");
        assert.equal(event.message, "PRIVATE-EVENT");
        assert.deepEqual(event.location, { lat: 6.5, lng: 3.4 });
        ids.push(event.id);
      }
      path = page.pagination.nextCursor
        ? `/shipments/s-055/events?limit=20&cursor=${page.pagination.nextCursor}`
        : null;
      assert.equal(page.pagination.hasMore, Boolean(path));
    }
    assert.equal(ids.length, 55);
    assert.equal(new Set(ids).size, 55);
    assert.equal(ids[0], "event-055");
    assert.equal(ids.at(-1), "event-001");
  }
});

test("history distinguishes authorized empty rows from missing/foreign shipments and requires a live session", async () => {
  assert.deepEqual((await data("/shipments/s-054/events")).data, []);
  assert.equal((await get("/shipments/s-055/events", null)).status, 401);
  for (const actor of ["owner", "rider", "customer"]) {
    const denied = await get("/shipments/foreign/events", actor);
    const missing = await get("/shipments/missing/events", actor);
    assert.equal(denied.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await denied.json(), await missing.json());
  }
  assert.equal((await get("/shipments/s-055/events", "other")).status, 404);
  assert.equal(
    (await data("/shipments/foreign/events", "other")).data[0].id,
    "foreign-event",
  );
  await query(
    "update auth_sessions set revoked_at=now() where user_id='owner'",
  );
  try {
    assert.equal((await get("/shipments/s-055/events")).status, 401);
  } finally {
    await query(
      "update auth_sessions set revoked_at=null where user_id='owner'",
    );
  }
});

test("history HTTP validation rejects invalid limits and cursors from other actors/shipments", async () => {
  const page = await data("/shipments/s-055/events?limit=2");
  const cursor = page.pagination.nextCursor;
  for (const path of [
    "/shipments/s-055/events?limit=51",
    "/shipments/s-055/events?limit=0",
    "/shipments/s-055/events?limit=2&limit=3",
    "/shipments/s-055/events?cursor=invalid",
    "/shipments/s-055/events?includeCompleted=true",
    "/shipments/s-055/events?page=2",
    `/shipments/s-054/events?cursor=${cursor}`,
  ])
    assert.equal((await get(path)).status, 400);
  assert.equal(
    (await get(`/shipments/s-055/events?cursor=${cursor}`, "customer")).status,
    400,
  );
  assert.equal(
    (await get(`/shipments/s-055/events?cursor=${cursor}`, "other")).status,
    400,
  );
});

test("history seeks retain microseconds and remain usable after the boundary row is deleted", async () => {
  await query(
    "update shipment_events set created_at='2026-11-01 12:00:00.123455+00' where id='event-055'",
  );
  const first = await data("/shipments/s-055/events?limit=50");
  assert.equal(first.data[0].id, "event-054");
  await query(
    "delete from shipment_events where id='event-005'; insert into shipment_events(id,shipment_id,status,message) values('new','s-055','pending','Newer')",
  );
  const next = await data(
    `/shipments/s-055/events?limit=50&cursor=${first.pagination.nextCursor}`,
  );
  assert.deepEqual(
    next.data.map((e) => e.id),
    ["event-004", "event-003", "event-002", "event-001", "event-055"],
  );
  assert.equal(next.pagination.hasMore, false);
  assert.equal(next.pagination.nextCursor, null);
});

test("history rechecks assignment, fleet, account activity and current role on subsequent reads", async () => {
  const actor = { userId: "rider", role: "driver" };
  const page = parseShipmentEventPage(new URLSearchParams(), actor, "s-055");
  await query("update shipments set driver_id=null where id='s-055'");
  assert.equal((await get("/shipments/s-055/events", "rider")).status, 404);
  assert.equal(
    await pg.query(shipmentEventsStatement(actor, "s-055", page)),
    "",
  );
  await query(
    "update shipments set driver_id=null; update drivers set business_id='other-biz' where id='driver'",
  );
  try {
    assert.equal((await get("/shipments/s-055/events", "rider")).status, 404);
  } finally {
    await query("update drivers set business_id='biz' where id='driver'");
  }
  const owner = { userId: "owner", role: "business" };
  const ownerPage = parseShipmentEventPage(
    new URLSearchParams(),
    owner,
    "s-055",
  );
  await query("update users set is_active=false where id='owner'");
  try {
    assert.equal(
      await pg.query(shipmentEventsStatement(owner, "s-055", ownerPage)),
      "",
    );
  } finally {
    await query("update users set is_active=true where id='owner'");
  }
  await query("update users set role='customer' where id='owner'");
  try {
    assert.equal(
      await pg.query(shipmentEventsStatement(owner, "s-055", ownerPage)),
      "",
    );
  } finally {
    await query("update users set role='business' where id='owner'");
  }
});

test("private future columns stay out of public and authenticated event projections", async () => {
  await query(
    "alter table shipment_events add column private_future_field text default 'PRIVATE-FUTURE'",
  );
  try {
    const publicRow = await data("/track/IST-55", null);
    const privateRow = await data("/shipments/s-055/events?limit=1");
    assert.ok(!JSON.stringify(publicRow).includes("PRIVATE-"));
    assert.ok(!JSON.stringify(privateRow).includes("PRIVATE-FUTURE"));
    assert.deepEqual(Object.keys(privateRow.data[0]).sort(), [
      "createdAt",
      "id",
      "location",
      "message",
      "shipmentId",
      "status",
    ]);
  } finally {
    await query("alter table shipment_events drop column private_future_field");
  }
});

test("storage faults stay server failures without exposing private diagnostics", async () => {
  unavailable = true;
  for (const path of ["/track/IST-55", "/shipments/s-055/events"]) {
    const response = await get(
      path,
      path.startsWith("/track") ? null : "owner",
    );
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.ok(!(await response.text()).includes("private storage"));
  }
});

test("large-history seek and public lookup plans use existing indexes with bounded event reads", async () => {
  await query(`insert into shipment_events(id,shipment_id,status,message,created_at)
    select 'bulk-'||lpad(i::text,6,'0'),'s-055','assigned','Private','2026-11-01 12:00:00.123456+00' from generate_series(1,20000)i;
    analyze shipments; analyze shipment_events;`);
  const actor = { userId: "owner", role: "business" };
  const page = parseShipmentEventPage(new URLSearchParams(), actor, "s-055");
  page.position = {
    v: 1,
    scope: page.scope,
    time: "2026-11-01T12:00:00.123456Z",
    id: "bulk-003600",
  };
  for (const [name, statement, cap] of [
    ["history", shipmentEventsStatement(actor, "s-055", page), 21],
    ["public", publicTrackingStatement("IST-55"), 21],
  ]) {
    const plan = JSON.parse(
      await pg.query(sql`explain (analyze,format json) ${statement}`),
    );
    await writeFile(
      new URL(`../reports/tracking-${name}-plan.json`, import.meta.url),
      JSON.stringify(plan, null, 2) + "\n",
    );
    assert.ok(JSON.stringify(plan).includes("shipment_events_page_idx"));
    const nodes = [];
    function walk(n) {
      nodes.push(n);
      for (const child of n.Plans ?? []) walk(child);
    }
    walk(plan[0].Plan);
    const reads = nodes.filter((n) => n["Relation Name"] === "shipment_events");
    assert.ok(reads.length > 0);
    assert.ok(
      reads.every(
        (n) =>
          n["Node Type"] !== "Seq Scan" &&
          n["Actual Rows"] + (n["Rows Removed by Filter"] ?? 0) <= cap,
      ),
    );
  }
});
