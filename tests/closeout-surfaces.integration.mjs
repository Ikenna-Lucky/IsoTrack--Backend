import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { journeyFixture } from "./helpers/journey-fixture.mjs";
const fixture = journeyFixture(),
  password = "CloseoutPassword123!";
before(async () => {
  await fixture.start();
});
beforeEach(async () => {
  await fixture.pool.query(
    "truncate users,idempotency_requests,account_action_limits cascade",
  );
  await fixture.redis.flushdb();
});
after(async () => {
  await fixture.stop();
});
async function request(path, actor, method = "GET", body) {
  return fetch(fixture.base + "/api/v1" + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + actor.token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function register(label, role = "business") {
  const response = await fetch(fixture.base + "/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: label,
      email: label + "@example.test",
      password,
      role,
      ...(role === "business" ? { businessName: label + " fleet" } : {}),
    }),
  });
  assert.equal(response.status, 201);
  const d = (await response.json()).data;
  return { id: d.user.id, token: d.accessToken };
}
async function json(response, status = 200) {
  assert.equal(response.status, status, JSON.stringify(fixture.databaseErrors));
  return response.json();
}
async function seedDrivers(owner, count) {
  const business = (
    await fixture.pool.query("select id from businesses where user_id=$1", [
      owner.id,
    ])
  ).rows[0].id;
  await fixture.pool.query(
    `insert into users(id,email,password_hash,name,role,emergency_contact)
 select 'rider-'||i,'rider-'||i||'@example.test',u.password_hash,'Rider '||i,'driver','PRIVATE-EMERGENCY' from generate_series(1,$2) i cross join users u where u.id=$1`,
    [owner.id, count],
  );
  await fixture.pool.query(
    `insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate,status,created_at)
 select 'profile-'||i,'rider-'||i,$1,'bike','PLATE-'||i,case when i%2=0 then 'available'::driver_status else 'offline'::driver_status end,'2026-11-01 00:00:00.123456+00' from generate_series(1,$2) i`,
    [business, count],
  );
}

test("fleet pages preserve tied timestamps, tenant scope, filter scope and minimal contact fields", async () => {
  const owner = await register("Owner"),
    other = await register("Other"),
    customer = await register("Customer", "customer");
  await seedDrivers(owner, 61);
  let cursor = null;
  const ids = [];
  do {
    const r = await json(
      await request(
        "/drivers?limit=17" + (cursor ? "&cursor=" + cursor : ""),
        owner,
      ),
    );
    assert(r.data.length <= 17);
    for (const d of r.data) {
      ids.push(d.id);
      assert.equal(d.user.passwordHash, undefined);
      assert.equal(d.user.credentialVersion, undefined);
      assert.equal(d.user.emergencyContact, undefined);
    }
    cursor = r.pagination.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 61);
  assert.equal(new Set(ids).size, 61);
  const first = await json(await request("/drivers?limit=5", owner));
  assert(first.pagination.hasMore);
  await json(
    await request(
      "/drivers/available?limit=5&cursor=" + first.pagination.nextCursor,
      owner,
    ),
    400,
  );
  await json(
    await request("/drivers?cursor=" + first.pagination.nextCursor, other),
    400,
  );
  assert.deepEqual((await json(await request("/drivers", other))).data, []);
  const available = await json(
    await request("/drivers/available?limit=50", owner),
  );
  assert.equal(available.data.length, 30);
  assert(available.data.every((d) => d.status === "available"));
  await json(await request("/drivers", customer), 403);
  for (const query of [
    "limit=0",
    "limit=51",
    "limit=2e2",
    "limit=1&limit=2",
    "includeCompleted=true",
  ])
    await json(await request("/drivers?" + query, owner), 400);
});

test("notification cursors and atomic mutations never expose or change foreign notifications", async () => {
  const owner = await register("Owner"),
    other = await register("Other");
  await fixture.pool.query(
    "insert into notifications(id,user_id,type,title,message,created_at) select 'n-'||i,$1,'push','Title','Message','2026-11-01 00:00:00.123456+00' from generate_series(1,51) i;",
    [owner.id],
  );
  await fixture.pool.query(
    "insert into notifications(id,user_id,type,title,message) values('foreign',$1,'push','Other','Other')",
    [other.id],
  );
  const first = await json(await request("/notifications?limit=50", owner));
  assert.equal(first.data.length, 50);
  assert(first.pagination.hasMore);
  const second = await json(
    await request(
      "/notifications?cursor=" + first.pagination.nextCursor,
      owner,
    ),
  );
  assert.equal(second.data.length, 1);
  assert(!first.data.some((n) => n.id === second.data[0].id));
  await json(
    await request(
      "/notifications?cursor=" + first.pagination.nextCursor,
      other,
    ),
    400,
  );
  for (const method of ["PATCH", "DELETE"]) {
    const path =
      method === "PATCH"
        ? "/notifications/foreign/read"
        : "/notifications/foreign";
    await json(await request(path, owner, method), 404);
  }
  const row = (
    await fixture.pool.query(
      "select is_read from notifications where id='foreign'",
    )
  ).rows[0];
  assert.equal(row.is_read, false);
  await json(
    await request(
      "/notifications/" + first.data[0].id + "/read",
      owner,
      "PATCH",
    ),
  );
  await json(
    await request("/notifications/" + first.data[0].id, owner, "DELETE"),
  );
});

test("mark-all-read is a bounded repeatable batch with truthful continuation", async () => {
  const owner = await register("Owner"),
    other = await register("Other");
  await fixture.pool.query(
    "insert into notifications(id,user_id,type,title,message) select 'n-'||i,$1,'push','Title','Message' from generate_series(1,605) i",
    [owner.id],
  );
  await fixture.pool.query(
    "insert into notifications(id,user_id,type,title,message) values('foreign',$1,'push','Other','Other')",
    [other.id],
  );
  const first = await json(
    await request("/notifications/read-all", owner, "PATCH"),
  );
  assert.deepEqual(first.data, { updated: 500, hasMore: true });
  const second = await json(
    await request("/notifications/read-all", owner, "PATCH"),
  );
  assert.deepEqual(second.data, { updated: 105, hasMore: false });
  assert.deepEqual(
    (await json(await request("/notifications/read-all", owner, "PATCH"))).data,
    { updated: 0, hasMore: false },
  );
  assert.equal(
    (
      await fixture.pool.query(
        "select is_read from notifications where id='foreign'",
      )
    ).rows[0].is_read,
    false,
  );
});

test("business settings merge concurrent patches and GET never creates missing profiles", async () => {
  const owner = await register("Owner");
  const responses = await Promise.all([
    request("/business/preferences", owner, "PATCH", { compactView: true }),
    request("/business/preferences", owner, "PATCH", { autoRefresh: false }),
  ]);
  for (const r of responses) await json(r);
  const prefs = (await json(await request("/business/preferences", owner)))
    .data;
  assert.equal(prefs.compactView, true);
  assert.equal(prefs.autoRefresh, false);
  const patches = await Promise.all([
    request("/business/notifications", owner, "PATCH", {
      delivered: { email: false, sms: false },
    }),
    request("/business/notifications", owner, "PATCH", {
      weeklyReport: { email: false, sms: false },
    }),
  ]);
  for (const r of patches) await json(r);
  const notifications = (
    await json(await request("/business/notifications", owner))
  ).data;
  assert.equal(notifications.delivered.email, false);
  assert.equal(notifications.weeklyReport.email, false);
  await fixture.pool.query("delete from businesses where user_id=$1", [
    owner.id,
  ]);
  await json(await request("/business/profile", owner), 409);
  assert.equal(
    (
      await fixture.pool.query(
        "select count(*)::int n from businesses where user_id=$1",
        [owner.id],
      )
    ).rows[0].n,
    0,
  );
});

test("driver profile GPS rejects out-of-range and extra fields without modifying location", async () => {
  const owner = await register("Owner");
  await seedDrivers(owner, 1);
  const login = await fetch(fixture.base + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "rider-1@example.test", password }),
  });
  const actor = { token: (await login.json()).data.accessToken };
  for (const body of [
    { lat: 91, lng: 3 },
    { lat: 6, lng: 181 },
    { lat: 6, lng: 3, shipmentId: "foreign" },
  ])
    await json(
      await request("/drivers/me/location", actor, "PATCH", body),
      400,
    );
  assert.equal(
    (
      await fixture.pool.query(
        "select current_location from drivers where id='profile-1'",
      )
    ).rows[0].current_location,
    null,
  );
  await json(
    await request("/drivers/me/location", actor, "PATCH", { lat: 6, lng: 3 }),
  );
  assert.deepEqual(
    (
      await fixture.pool.query(
        "select current_location from drivers where id='profile-1'",
      )
    ).rows[0].current_location,
    { lat: 6, lng: 3 },
  );
});
