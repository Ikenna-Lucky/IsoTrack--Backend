import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
async function request(
  path,
  { actor, method = "GET", body, key, cookie } = {},
) {
  return fetch(fixture.base + "/api/v1" + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key.padEnd(24, "_") } : {}),
      ...(cookie
        ? { Cookie: cookie, Origin: "https://preview.journey.invalid" }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function result(response, status = 200) {
  assert.equal(response.status, status, JSON.stringify(fixture.databaseErrors));
  return (await response.json()).data;
}
async function register(name, role = "customer") {
  const response = await request("/auth/register", {
    method: "POST",
    body: {
      name,
      email: name + "@example.test",
      password,
      role,
      ...(role === "business" ? { businessName: name + " fleet" } : {}),
    },
  });
  const cookie = response.headers.get("set-cookie")?.split(";")[0],
    data = await result(response, 201);
  return {
    id: data.user.id,
    token: data.accessToken,
    cookie,
    email: name + "@example.test",
  };
}
async function shipment(owner, customer) {
  return result(
    await request("/shipments", {
      actor: owner,
      method: "POST",
      key: "new-" + customer.id,
      body: {
        description: "Closeout fixture",
        weightKg: 1,
        customerId: customer.id,
        pickupAddress: { street: "A", city: "Lagos", state: "Lagos" },
        deliveryAddress: { street: "B", city: "Lagos", state: "Lagos" },
        priceKobo: 100,
      },
    }),
    201,
  );
}
const deactivate = (actor, currentPassword = password) =>
  request("/auth/deactivate", {
    actor,
    method: "POST",
    body: { currentPassword },
  });

test("pending invitations cannot enroll a new driver after the owner deactivates", async () => {
  const owner = await register("closing-owner", "business");
  const invitation = await result(
    await request("/driver-invitations", {
      actor: owner,
      method: "POST",
      body: { email: "pending-rider@example.test" },
    }),
    201,
  );
  await result(await deactivate(owner));
  const response = await request("/driver-invitations/accept", {
    method: "POST",
    body: {
      token: invitation.token,
      email: "pending-rider@example.test",
      name: "Pending Rider",
      password,
      vehicleType: "bike",
      vehiclePlate: "TEST-456",
    },
  });
  assert.equal(response.status, 404);
  const { rows } = await fixture.pool.query(
    "select (select count(*)::int from users where email=$1) as accounts, accepted_at from driver_invitations where id=$2",
    ["pending-rider@example.test", invitation.id],
  );
  assert.equal(rows[0].accounts, 0);
  assert.equal(rows[0].accepted_at, null);
});
async function account(actor) {
  return (
    await fixture.pool.query(
      "select is_active,credential_version,password_hash from users where id=$1",
      [actor.id],
    )
  ).rows[0];
}
async function driver(owner) {
  const invitation = await result(
    await request("/driver-invitations", {
      actor: owner,
      method: "POST",
      body: { email: "rider@example.test" },
    }),
    201,
  );
  const enrolled = await result(
    await request("/driver-invitations/accept", {
      method: "POST",
      body: {
        token: invitation.token,
        email: "rider@example.test",
        name: "Rider",
        password,
        vehicleType: "bike",
        vehiclePlate: "TEST-123",
      },
    }),
    201,
  );
  const login = await result(
    await request("/auth/login", {
      method: "POST",
      body: { email: "rider@example.test", password },
    }),
  );
  return {
    id: enrolled.userId,
    driverId: enrolled.driverId,
    token: login.accessToken,
  };
}

test("deactivation requires password, preserves the account and invalidates access, refresh and future login", async () => {
  const customer = await register("Customer"),
    before = await account(customer);
  assert.equal(
    (await request("/auth/me", { actor: customer, method: "DELETE" })).status,
    409,
  );
  assert.equal(
    (await deactivate(customer, "IncorrectPassword123!")).status,
    401,
  );
  assert.deepEqual(await account(customer), before);
  for (const body of [
    {},
    { currentPassword: password, userId: "foreign" },
    { currentPassword: "é".repeat(40) },
  ])
    assert.equal(
      (
        await request("/auth/deactivate", {
          actor: customer,
          method: "POST",
          body,
        })
      ).status,
      400,
    );
  const closed = await result(await deactivate(customer));
  assert.equal(closed.isActive, false);
  const after = await account(customer);
  assert.equal(after.is_active, false);
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.credential_version, before.credential_version + 1);
  assert.equal((await request("/shipments", { actor: customer })).status, 401);
  assert.equal(
    (
      await request("/auth/refresh", {
        method: "POST",
        cookie: customer.cookie,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/auth/login", {
        method: "POST",
        body: { email: customer.email, password },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/auth/deactivate", {
        method: "POST",
        body: { currentPassword: password },
      })
    ).status,
    401,
  );
});

test("active shipments block closure; closed history remains linked after deactivation", async () => {
  const owner = await register("Owner", "business"),
    customer = await register("Customer"),
    s = await shipment(owner, customer);
  const blocked = await deactivate(customer);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "ACTIVE_SHIPMENTS");
  assert.equal((await account(customer)).is_active, true);
  await result(
    await request("/shipments/" + s.id, {
      actor: owner,
      method: "DELETE",
      key: "cancel",
      body: { expectedVersion: s.version },
    }),
  );
  await result(await deactivate(customer));
  assert.equal(
    (
      await fixture.pool.query(
        "select customer_id from shipments where id=$1",
        [s.id],
      )
    ).rows[0].customer_id,
    customer.id,
  );
  await assert.rejects(
    fixture.pool.query(
      `insert into shipments(id,tracking_id,business_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo) select 'late','IST-LATE',business_id,$1,'late',1,'{}','{}',100 from shipments where id=$2`,
      [customer.id, s.id],
    ),
    (error) => error.code === "23514",
  );
});

test("fleet membership and failed-return custody block closure; eligible drivers become offline without erasing membership", async () => {
  const owner = await register("Owner", "business"),
    customer = await register("Customer"),
    rider = await driver(owner),
    s = await shipment(owner, customer);
  let response = await deactivate(owner);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "FLEET_OFFBOARDING_REQUIRED");
  await fixture.pool.query(
    "update shipments set driver_id=$1,status='failed',failure_reason='recipient_unavailable',failed_at=now(),actual_pickup=now(),return_state='requested' where id=$2",
    [rider.driverId, s.id],
  );
  response = await deactivate(rider);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "ACTIVE_SHIPMENTS");
  await fixture.pool.query(
    "update shipments set return_state='received',returned_at=now() where id=$1",
    [s.id],
  );
  await result(await deactivate(rider));
  const profile = (
    await fixture.pool.query(
      "select status,current_location,business_id from drivers where id=$1",
      [rider.driverId],
    )
  ).rows[0];
  assert.equal(profile.status, "offline");
  assert.equal(profile.current_location, null);
  assert(profile.business_id);
  assert.equal((await request("/drivers/me", { actor: rider })).status, 401);
});

test("received payment reviews block closure until resolved, preserving financial audit", async () => {
  const owner = await register("Owner", "business"),
    customer = await register("Customer"),
    s = await shipment(owner, customer);
  await result(
    await request("/shipments/" + s.id, {
      actor: owner,
      method: "DELETE",
      key: "cancel",
      body: { expectedVersion: s.version },
    }),
  );
  await fixture.pool.query(
    "insert into payments(id,shipment_id,provider_reference,amount_kobo,status,checkout_state,received_at,review_reason) values('review',$1,'REVIEW',100,'pending','review',now(),'shipment_not_payable')",
    [s.id],
  );
  const blocked = await deactivate(customer);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "UNRESOLVED_PAYMENTS");
  await fixture.pool.query(
    "update payments set status='refunded',refund_id='re_fixture',refund_recorded_by='fixture',refund_recorded_at=now() where id='review'",
  );
  await result(await deactivate(customer));
  const row = (
    await fixture.pool.query(
      "select status,refund_id,refund_recorded_by from payments where id='review'",
    )
  ).rows[0];
  assert.equal(row.status, "refunded");
  assert.equal(row.refund_id, "re_fixture");
  assert.equal(row.refund_recorded_by, "fixture");
});

async function waitForLock(pid) {
  for (let n = 0; n < 50; n++) {
    if (
      (
        await fixture.pool.query(
          "select wait_event_type from pg_stat_activity where pid=$1",
          [pid],
        )
      ).rows[0]?.wait_event_type === "Lock"
    )
      return;
    await delay(20);
  }
  assert.fail("Expected lock wait was not observed");
}

test("closure waits for admitted new work and observes its committed shipment before deciding", async () => {
  const owner = await register("Owner", "business"),
    customer = await register("Customer");
  const business = (
    await fixture.pool.query("select id from businesses where user_id=$1", [
      owner.id,
    ])
  ).rows[0].id;
  const writer = await fixture.pool.connect(),
    closer = await fixture.pool.connect();
  try {
    const pid = (await closer.query("select pg_backend_pid() pid")).rows[0].pid;
    await writer.query("begin");
    await writer.query("select lock_active_accounts(array[$1]::text[])", [
      customer.id,
    ]);
    const closing = closer.query("select deactivate_account($1,$2) result", [
      customer.id,
      (await account(customer)).password_hash,
    ]);
    await waitForLock(pid);
    await writer.query(
      "insert into shipments(id,tracking_id,business_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo) values('raced','IST-RACED',$1,$2,'Race',1,'{}','{}',100)",
      [business, customer.id],
    );
    await writer.query("commit");
    assert.equal((await closing).rows[0].result.error, "ACTIVE_SHIPMENTS");
    assert.equal((await account(customer)).is_active, true);
  } finally {
    await writer.query("rollback");
    writer.release();
    closer.release();
  }
});

test("new work waiting behind committed deactivation is rejected with no partial insert", async () => {
  const owner = await register("Owner", "business"),
    customer = await register("Customer");
  const business = (
    await fixture.pool.query("select id from businesses where user_id=$1", [
      owner.id,
    ])
  ).rows[0].id;
  const closer = await fixture.pool.connect(),
    writer = await fixture.pool.connect();
  try {
    const pid = (await writer.query("select pg_backend_pid() pid")).rows[0].pid;
    await closer.query("begin");
    assert.equal(
      (
        await closer.query("select deactivate_account($1,$2) result", [
          customer.id,
          (await account(customer)).password_hash,
        ])
      ).rows[0].result.deactivated,
      true,
    );
    const writing = writer
      .query(
        "insert into shipments(id,tracking_id,business_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo) values('late','IST-LATE',$1,$2,'Race',1,'{}','{}',100)",
        [business, customer.id],
      )
      .then(
        () => ({ inserted: true }),
        (error) => ({ code: error.code }),
      );
    await waitForLock(pid);
    await closer.query("commit");
    assert.equal((await writing).code, "23514");
    assert.equal(
      (
        await fixture.pool.query(
          "select count(*)::int n from shipments where id='late'",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await closer.query("rollback");
    closer.release();
    writer.release();
  }
});

test("credential races and downstream update failures do not partially deactivate accounts", async () => {
  const owner = await register("Owner", "business"),
    rider = await driver(owner),
    before = await account(rider);
  assert.equal(
    (
      await fixture.pool.query("select deactivate_account($1,'stale') result", [
        rider.id,
      ])
    ).rows[0].result.error,
    "CREDENTIALS_CHANGED",
  );
  await fixture.pool.query(
    "create function fail_closeout() returns trigger language plpgsql as $$begin raise exception 'fixture rollback';end$$;create trigger fail_closeout before update on drivers for each row execute function fail_closeout()",
  );
  try {
    assert.equal((await deactivate(rider)).status, 500);
    assert.deepEqual(await account(rider), before);
    await result(await request("/drivers/me", { actor: rider }));
  } finally {
    await fixture.pool.query(
      "drop trigger fail_closeout on drivers;drop function fail_closeout()",
    );
  }
});
