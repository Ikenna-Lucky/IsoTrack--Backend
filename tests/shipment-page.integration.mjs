import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serve } from "@hono/node-server";
import { SignJWT } from "jose";
import { sql } from "drizzle-orm";
import { postgresFixture } from "./helpers/postgres.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import { createShipmentListRouter } from "../src/routes/shipment-list.ts";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.ts";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { activeSessionStatement } from "../src/db/queries/session-statements.ts";
import { parseShipmentPage } from "../src/lib/shipment-page.ts";
import { shipmentPageStatement } from "../src/db/queries/shipment-page.ts";
const pg = postgresFixture({ prefix: "shipment-page" });
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
    createShipmentListRouter({
      execute: async (s) => {
        if (unavailable) throw new Error("private storage failure");
        const result = await pg.query(s);
        return result ? result.split("\n").map((r) => JSON.parse(r)) : [];
      },
    }),
  );
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  unavailable = false;
  await query(`truncate shipments cascade;
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
const get = (q = "", actor = "owner") =>
  fetch(`${base}/shipments${q ? `?${q}` : ""}`, {
    headers: actor ? { Authorization: `Bearer ${tokens.get(actor)}` } : {},
  });
async function page(q = "", actor = "owner") {
  const response = await get(q, actor);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return response.json();
}
test("every role has bounded pages with stable ties, no duplicates and no totals", async () => {
  for (const actor of ["owner", "rider", "customer"]) {
    let q = "limit=20",
      ids = [];
    do {
      const r = await page(q, actor);
      assert.ok(r.data.length <= 20);
      assert.equal(r.pagination.total, undefined);
      ids.push(...r.data.map((x) => x.id));
      q = r.pagination.nextCursor
        ? `limit=20&cursor=${r.pagination.nextCursor}`
        : null;
    } while (q);
    assert.equal(ids.length, 55);
    assert.equal(new Set(ids).size, 55);
    assert.equal(ids[0], "s-055");
    assert.equal(ids.at(-1), "s-001");
  }
});
test("strict HTTP inputs/authentication and cursor scope cannot widen tenant access", async () => {
  assert.equal((await get("", null)).status, 401);
  for (const q of [
    "limit=51",
    "limit=-1",
    "limit=1&limit=2",
    "page=9",
    "cursor=invalid",
    "includeCompleted=yes",
  ])
    assert.equal((await get(q)).status, 400);
  const r = await page("limit=2");
  assert.equal(
    (await get(`cursor=${r.pagination.nextCursor}`, "other")).status,
    400,
  );
  assert.deepEqual(
    (await page("", "other")).data.map((s) => s.id),
    ["foreign"],
  );
});
test("insertions above the cursor and mutable updates do not duplicate older rows; deletion of boundary is safe", async () => {
  const first = await page("limit=2");
  await query(`delete from shipments where id='s-054';
    update shipments set updated_at=now(),status='in_transit' where id='s-055';
    insert into shipments(id,tracking_id,business_id,description,weight_kg,pickup_address,delivery_address,price_kobo)
    values('new','IST-NEW','biz','New',1,'{}','{}',100)`);
  const next = await page(`limit=2&cursor=${first.pagination.nextCursor}`);
  assert.deepEqual(
    next.data.map((s) => s.id),
    ["s-053", "s-052"],
  );
});
test("cursor preserves sub-millisecond ordering instead of truncating timestamps", async () => {
  await query(
    "update shipments set created_at='2026-11-01 12:00:00.123455+00' where id='s-055'",
  );
  const first = await page("limit=50");
  const second = await page(`limit=50&cursor=${first.pagination.nextCursor}`);
  assert.equal(
    new Set([...first.data, ...second.data].map((s) => s.id)).size,
    55,
  );
  assert.equal(second.data.at(-1).id, "s-055");
});
test("driver filters and fleet changes are rechecked and relation fields stay private", async () => {
  await query("update shipments set status='delivered' where id='s-055'");
  assert.equal((await page("limit=1", "rider")).data[0].id, "s-054");
  const all = await page("limit=1&includeCompleted=true", "rider");
  assert.equal(all.data[0].id, "s-055");
  assert.equal(
    (await get(`cursor=${all.pagination.nextCursor}`, "rider")).status,
    400,
  );
  const text = JSON.stringify(await page("limit=1", "customer"));
  for (const secret of [
    "PRIVATE-HASH",
    "PRIVATE-INSURANCE",
    "PRIVATE-PREF",
    "credentialVersion",
    "passwordHash",
  ])
    assert.ok(!text.includes(secret));
  await query("update shipments set driver_id=null");
  assert.equal((await page("", "rider")).data.length, 0);
});
test("related event histories are bounded and storage errors remain server errors", async () => {
  await query(
    `insert into shipment_events(id,shipment_id,status,message) select 'event-'||i,'s-055','pending','Notice' from generate_series(1,8)i`,
  );
  assert.equal((await page("limit=1", "customer")).data[0].events.length, 3);
  assert.equal((await page("limit=1", "rider")).data[0].events.length, 1);
  unavailable = true;
  const response = await get();
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes("private storage failure"));
});
test("representative deep-page plans use the scope/order indexes without offset or full counts", async () => {
  await query(`insert into shipments(id,tracking_id,business_id,driver_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo,created_at)
    select 'bulk-'||lpad(i::text,6,'0'),'BULK-'||i,'biz','driver','customer','Box',1,'{}','{}',100,'2026-01-01 01:00:00+00'::timestamptz from generate_series(1,10000)i; analyze shipments`);
  for (const [role, userId, filter, index] of [
    ["business", "owner", false, "shipments_business_page_idx"],
    ["customer", "customer", false, "shipments_customer_page_idx"],
    ["driver", "rider", false, "shipments_driver_active_page_idx"],
    ["driver", "rider", true, "shipments_driver_page_idx"],
  ]) {
    const actor = { role, userId };
    const p = parseShipmentPage(
      new URLSearchParams(
        role === "driver" ? { includeCompleted: String(filter) } : {},
      ),
      actor,
    );
    p.position = {
      v: 1,
      scope: p.scope,
      time: "2026-01-01T01:00:00.000000Z",
      id: "bulk-003600",
    };
    const plan = JSON.parse(
      await pg.query(
        sql`explain (analyze,format json) ${shipmentPageStatement(actor, p)}`,
      ),
    );
    const text = JSON.stringify(plan);
    await writeFile(
      new URL(
        `../reports/shipment-page-plan-${role}-${filter}.json`,
        import.meta.url,
      ),
      JSON.stringify(plan, null, 2) + "\n",
    );
    assert.ok(text.includes(index), `${role}: expected ${index}`);
    const nodes = [];
    function walk(n) {
      nodes.push(n);
      for (const child of n.Plans ?? []) walk(child);
    }
    walk(plan[0].Plan);
    assert.ok(
      !nodes.some(
        (n) =>
          n["Relation Name"] === "shipments" && n["Node Type"] === "Seq Scan",
      ),
    );
    assert.ok(
      nodes
        .filter((n) => n["Relation Name"] === "shipments")
        .every(
          (n) => n["Actual Rows"] + (n["Rows Removed by Filter"] ?? 0) <= 21,
        ),
    );
  }
});
