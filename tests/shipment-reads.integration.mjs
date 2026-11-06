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
import {
  createShipmentDetailRouter,
  createBusinessAnalyticsRouter,
} from "../src/routes/shipment-reads.ts";
import {
  shipmentDetailStatement,
  businessAnalyticsStatement,
} from "../src/db/queries/shipment-reads.ts";
const pg = postgresFixture({ prefix: "shipment-reads" });
const query = (text) => pg.query(sql.raw(text));
const secret = new TextEncoder().encode(
  "shipment-page-signature-fixture-key-32",
);
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
    "*",
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
        const result = await pg.query(s, { prepared: true });
        return result ? result.split("\n").map((r) => JSON.parse(r)) : [];
      },
    }),
  );
  app.route(
    "/business",
    createBusinessAnalyticsRouter({
      execute: async (statement) => {
        if (unavailable) throw new Error("private storage failure");
        const result = await pg.query(statement, { prepared: true });
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
    values('foreign','IST-FOREIGN','other-biz','Foreign',1,'{}','{}',100);`);
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
  return (await response.json()).data;
}

test("detail authorizes the owner, assigned fleet driver and linked customer only", async () => {
  for (const actor of ["owner", "rider", "customer"]) {
    assert.equal((await data("/shipments/s-055", actor)).id, "s-055");
    assert.equal((await get("/shipments/foreign", actor)).status, 404);
    assert.equal((await get("/shipments/missing", actor)).status, 404);
  }
  assert.equal((await get("/shipments/s-055", "other")).status, 404);
  assert.equal((await get("/shipments/s-055", null)).status, 401);
  assert.equal((await data("/shipments/foreign", "other")).id, "foreign");
});

test("detail selects contacts and payment summaries without driver/account/provider secrets", async () => {
  await query(`update shipments set recipient_email='recipient@example.test' where id='s-055';
    insert into payments(id,shipment_id,amount_kobo,provider_reference,stripe_session_id,reconcile_token,review_reason)
    values('pay','s-055',100,'PRIVATE-REFERENCE','PRIVATE-SESSION','PRIVATE-LEASE','PRIVATE-REVIEW');`);
  for (const actor of ["owner", "rider", "customer"]) {
    const row = await data("/shipments/s-055", actor);
    assert.deepEqual(Object.keys(row.driver).sort(), [
      "id",
      "user",
      "vehiclePlate",
      "vehicleType",
    ]);
    assert.deepEqual(Object.keys(row.customer).sort(), [
      "avatar",
      "email",
      "id",
      "name",
      "phone",
    ]);
    assert.equal(row.driver.user.name, "Rider");
    assert.equal(
      row.recipientEmail,
      actor === "owner" ? "recipient@example.test" : undefined,
    );
    if (actor === "rider") assert.equal(row.payment, null);
    else {
      assert.equal(row.payment.amountKobo, 100);
      assert.deepEqual(Object.keys(row.payment).sort(), [
        "amountKobo",
        "channel",
        "createdAt",
        "id",
        "paidAt",
        "status",
      ]);
    }
    assert.ok(!JSON.stringify(row).includes("PRIVATE-"));
  }
});

test("detail bounds event history with deterministic ties and an explicit truncation flag", async () => {
  await query(`insert into shipment_events(id,shipment_id,status,message,created_at)
    select 'e-'||lpad(i::text,3,'0'),'s-055','pending','Notice','2026-11-01' from generate_series(1,51)i`);
  const row = await data("/shipments/s-055");
  assert.equal(row.events.length, 50);
  assert.equal(row.events[0].id, "e-051");
  assert.equal(row.events.at(-1).id, "e-002");
  assert.equal(row.eventsTruncated, true);
  assert.equal((await data("/shipments/s-054")).eventsTruncated, false);
});

test("latest payment attempt is deterministic and absent relations are null", async () => {
  await query(`insert into payments(id,shipment_id,amount_kobo,created_at) values
    ('p-a','s-055',100,'2026-11-01'),('p-z','s-055',200,'2026-11-01')`);
  assert.equal((await data("/shipments/s-055")).payment.id, "p-z");
  const row = await data("/shipments/foreign", "other");
  assert.equal(row.driver, null);
  assert.equal(row.customer, null);
  assert.equal(row.payment, null);
});

test("SQL rechecks current actor role, active state and assignment after authentication", async () => {
  const actor = { userId: "rider", role: "driver" };
  await query("update shipments set driver_id=null where id='s-055'");
  assert.equal(await pg.query(shipmentDetailStatement(actor, "s-055")), "");
  await query("update users set is_active=false where id='owner'");
  try {
    assert.equal(
      await pg.query(
        shipmentDetailStatement({ userId: "owner", role: "business" }, "s-055"),
      ),
      "",
    );
    assert.equal(
      await pg.query(
        businessAnalyticsStatement({ userId: "owner", role: "business" }),
      ),
      "",
    );
  } finally {
    await query("update users set is_active=true where id='owner'");
  }
  await query("update users set role='customer' where id='owner'");
  try {
    assert.equal(
      await pg.query(
        shipmentDetailStatement({ userId: "owner", role: "business" }, "s-055"),
      ),
      "",
    );
    assert.equal(
      await pg.query(
        businessAnalyticsStatement({ userId: "owner", role: "business" }),
      ),
      "",
    );
  } finally {
    await query("update users set role='business' where id='owner'");
  }
});

test("analytics aggregates only owned shipments and returns at most ten safe recent rows", async () => {
  const row = await data("/business/analytics");
  assert.equal(row.totalShipments, 55);
  assert.equal(row.totalRevenueKobo, 5500);
  assert.deepEqual(row.statusBreakdown, { pending: 55 });
  assert.equal(row.recentShipments.length, 10);
  assert.equal(row.recentShipments[0].id, "s-055");
  assert.equal(row.recentShipments.at(-1).id, "s-046");
  assert.ok(!JSON.stringify(row).includes("PRIVATE-"));
  assert.equal(row.recentShipments[0].driver.vehiclePlate, "TEST");
  const other = await data("/business/analytics", "other");
  assert.equal(other.totalShipments, 1);
  assert.equal(other.totalRevenueKobo, 100);
});

test("analytics rejects other roles, ignores caller tenant overrides, and does not create profiles", async () => {
  for (const actor of ["rider", "customer"])
    assert.equal((await get("/business/analytics", actor)).status, 403);
  assert.equal((await get("/business/analytics", null)).status, 401);
  assert.equal(
    (await data("/business/analytics?businessId=other-biz")).totalShipments,
    55,
  );
  await query(
    "delete from shipments where business_id='other-biz'; delete from businesses where id='other-biz'",
  );
  try {
    assert.deepEqual(await data("/business/analytics", "other"), {
      statusBreakdown: {},
      totalShipments: 0,
      totalRevenueKobo: 0,
      recentShipments: [],
    });
    assert.equal(
      await query("select count(*) from businesses where user_id='other'"),
      "0",
    );
  } finally {
    await query(
      "insert into businesses(id,user_id,business_name) values('other-biz','other','B')",
    );
  }
});

test("storage failures remain server errors and never echo private diagnostics", async () => {
  unavailable = true;
  for (const path of ["/shipments/s-055", "/business/analytics"]) {
    const response = await get(path);
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes("private storage"));
  }
});

test("new private database columns do not appear in detail or analytics responses", async () => {
  await query(
    "alter table shipments add column private_future_field text default 'PRIVATE-FUTURE'",
  );
  try {
    for (const path of ["/shipments/s-055", "/business/analytics"]) {
      assert.ok(!JSON.stringify(await data(path)).includes("PRIVATE-FUTURE"));
    }
  } finally {
    await query("alter table shipments drop column private_future_field");
  }
});
