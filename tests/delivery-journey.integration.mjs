import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { once } from "node:events";
import { io } from "socket.io-client";

import { journeyFixture } from "./helpers/journey-fixture.mjs";
import { graphFixture, createGraphTestTransport } from "./helpers/graph.mjs";
import { createDeliveryEmailProcessor } from "../src/workers/delivery-email.ts";

const fixture = journeyFixture();
const password = "JourneyPassword123!";
const origin = "https://preview.journey.invalid";
const sockets = new Set();
let mail;

before(async () => {
  await fixture.start();
  mail = await graphFixture();
});
beforeEach(async () => {
  // Each scenario enrolls its own actors through the real application API.
  await fixture.pool.query(
    "truncate users, idempotency_requests, account_action_limits cascade",
  );
  await fixture.redis.flushdb();
  fixture.databaseErrors.length = 0;
  mail.accepted.length = 0;
});
after(async () => {
  for (const socket of sockets) socket.disconnect();
  await mail?.close();
  await fixture.stop();
});

async function request(path, { actor, method = "GET", body, key } = {}) {
  return fetch(`${fixture.base}/api/v1${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...(key ? { "Idempotency-Key": key.padEnd(24, "_") } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function result(response, status) {
  assert.equal(
    response.status,
    status,
    `Unexpected HTTP status; database codes: ${JSON.stringify(fixture.databaseErrors)}`,
  );
  return (await response.json()).data;
}
async function register(label, role = "business") {
  const data = await result(
    await request("/auth/register", {
      method: "POST",
      body: {
        name: `Journey ${label}`,
        email: `${label}@example.test`,
        password,
        role,
        ...(role === "business" ? { businessName: `Fleet ${label}` } : {}),
      },
    }),
    201,
  );
  assert.ok(data.accessToken);
  return { token: data.accessToken, id: data.user.id };
}
async function invite(owner, email) {
  return result(
    await request("/driver-invitations", {
      actor: owner,
      method: "POST",
      body: { email },
    }),
    201,
  );
}
async function enrollDriver(owner) {
  const invitation = await invite(owner, "rider@example.test");
  const acceptance = {
    token: invitation.token,
    email: "rider@example.test",
    name: "Journey Rider",
    password,
    vehicleType: "bike",
    vehiclePlate: "JRN-123",
  };
  const membership = await result(
    await request("/driver-invitations/accept", {
      method: "POST",
      body: acceptance,
    }),
    201,
  );
  const login = await result(
    await request("/auth/login", {
      method: "POST",
      body: { email: acceptance.email, password },
    }),
    200,
  );
  const actor = {
    token: login.accessToken,
    id: login.user.id,
    driverId: membership.driverId,
  };
  return { actor, invitation, acceptance, membership };
}
async function snapshot(shipmentId) {
  const { rows } = await fixture.pool.query(
    `select s.status,s.version,s.driver_id,s.current_location,s.actual_delivery,
    (select count(*)::int from shipment_events where shipment_id=s.id) as events,
    (select count(*)::int from notification_outbox where shipment_id=s.id) as notices,
    (select count(*)::int from delivery_confirmations where shipment_id=s.id and consumed_at is not null) as consumed
    from shipments s where s.id=$1`,
    [shipmentId],
  );
  return rows[0];
}
async function connect(actor) {
  const socket = io(fixture.base, {
    autoConnect: false,
    reconnection: false,
    transports: ["websocket"],
    auth: { token: actor.token },
    extraHeaders: { Origin: origin },
  });
  sockets.add(socket);
  const connected = once(socket, "connect", {
    signal: AbortSignal.timeout(10000),
  });
  socket.connect();
  await connected;
  return socket;
}
const emit = (socket, event, payload) =>
  socket.timeout(10000).emitWithAck(event, payload);

test("private fleet enrollment uses real registration, invitations and sessions without allowing a second membership", async () => {
  const owner = await register("owner"),
    other = await register("other");
  assert.equal(
    (
      await request("/auth/register", {
        method: "POST",
        body: {
          name: "Uninvited Rider",
          email: "uninvited@example.test",
          password,
          role: "driver",
        },
      })
    ).status,
    403,
  );
  const { actor, invitation, acceptance, membership } =
    await enrollDriver(owner);
  assert.equal(
    (
      await request("/driver-invitations/accept", {
        method: "POST",
        body: acceptance,
      })
    ).status,
    404,
  );
  const ownerDrivers = await result(
    await request("/drivers", { actor: owner }),
    200,
  );
  assert.equal(ownerDrivers.length, 1);
  assert.equal(ownerDrivers[0].id, membership.driverId);
  assert.deepEqual(
    await result(await request("/drivers", { actor: other }), 200),
    [],
  );
  const second = await invite(other, "rider@example.test");
  assert.equal(
    (
      await request("/driver-invitations/accept-existing", {
        actor,
        method: "POST",
        body: { token: second.token },
      })
    ).status,
    409,
  );
  const { rows } = await fixture.pool.query(
    "select business_id from drivers where user_id=$1",
    [actor.id],
  );
  assert.deepEqual(
    rows.map((row) => row.business_id),
    [membership.businessId],
  );
  const { rows: invitations } = await fixture.pool.query(
    "select accepted_at from driver_invitations where id=$1",
    [invitation.id],
  );
  assert.ok(invitations[0].accepted_at);
  assert.deepEqual(fixture.databaseErrors, []);
});

for (const lostAcknowledgement of [false, true]) {
  test(`full delivery journey preserves tenant boundaries and retry safety${lostAcknowledgement ? " after a lost commit acknowledgement" : ""}`, async () => {
    const owner = await register("owner"),
      other = await register("other"),
      customer = await register("customer", "customer");
    const { actor: driver } = await enrollDriver(owner);
    await result(
      await request("/drivers/me/status", {
        actor: driver,
        method: "PATCH",
        body: { status: "available" },
      }),
      200,
    );
    const input = {
      description: "Journey parcel",
      weightKg: 1,
      customerId: customer.id,
      pickupAddress: {
        street: "PRIVATE-PICKUP",
        city: "Lagos",
        state: "Lagos",
      },
      deliveryAddress: {
        street: "PRIVATE-DELIVERY",
        city: "Lagos",
        state: "Lagos",
      },
      recipientEmail: "recipient@example.test",
      priceKobo: 250000,
    };
    const created = await result(
      await request("/shipments", {
        actor: owner,
        method: "POST",
        body: input,
        key: "create",
      }),
      201,
    );
    const replay = await request("/shipments", {
      actor: owner,
      method: "POST",
      body: input,
      key: "create",
    });
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    assert.equal((await result(replay, 201)).id, created.id);
    assert.equal(
      (
        await request("/shipments", {
          actor: owner,
          method: "POST",
          body: { ...input, priceKobo: 1 },
          key: "create",
        })
      ).status,
      409,
    );
    assert.equal(
      (await fixture.pool.query("select count(*)::int n from shipments"))
        .rows[0].n,
      1,
    );
    const path = `/shipments/${created.id}`;
    const unchanged = await snapshot(created.id);
    assert.equal((await request(path, { actor: other })).status, 404);
    assert.equal(
      (
        await request(`${path}/assign`, {
          actor: other,
          method: "PATCH",
          body: { expectedVersion: created.version, driverId: driver.driverId },
          key: "foreign-assign",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(`${path}/status`, {
          actor: customer,
          method: "PATCH",
          body: { expectedVersion: created.version, status: "picked_up" },
          key: "customer-write",
        })
      ).status,
      403,
    );
    assert.deepEqual(await snapshot(created.id), unchanged);
    const assign = {
      expectedVersion: created.version,
      driverId: driver.driverId,
    };
    const assignments = await Promise.all(
      [1, 2].map(() =>
        request(`${path}/assign`, {
          actor: owner,
          method: "PATCH",
          body: assign,
          key: "assign",
        }),
      ),
    );
    let current;
    for (const response of assignments) {
      const assigned = await result(response, 200);
      assert.equal(assigned.status, "assigned");
      if (current) assert.deepEqual(assigned, current);
      current = assigned;
    }
    assert.equal((await snapshot(created.id)).events, unchanged.events + 1);
    assert.equal(
      (
        await request(`${path}/status`, {
          actor: driver,
          method: "PATCH",
          body: { expectedVersion: created.version, status: "picked_up" },
          key: "stale-pickup",
        })
      ).status,
      409,
    );
    for (const status of ["picked_up", "in_transit", "out_for_delivery"]) {
      current = await result(
        await request(`${path}/status`, {
          actor: driver,
          method: "PATCH",
          body: { expectedVersion: current.version, status },
          key: status,
        }),
        200,
      );
    }

    const ownerSocket = await connect(owner),
      driverSocket = await connect(driver),
      otherSocket = await connect(other);
    assert.deepEqual(
      await emit(ownerSocket, "shipment:join", created.trackingId),
      { ok: true },
    );
    assert.deepEqual(
      await emit(otherSocket, "shipment:join", created.trackingId),
      { ok: false, code: "FORBIDDEN" },
    );
    const location = {
      trackingId: created.trackingId,
      lat: 6.52,
      lng: 3.37,
      timestamp: Date.now(),
    };
    assert.deepEqual(await emit(otherSocket, "driver:location", location), {
      ok: false,
      code: "FORBIDDEN",
    });
    assert.equal((await snapshot(created.id)).current_location, null);
    const deliveredLocation = once(ownerSocket, "driver:location", {
      signal: AbortSignal.timeout(10000),
    });
    assert.deepEqual(await emit(driverSocket, "driver:location", location), {
      ok: true,
    });
    assert.equal((await deliveredLocation)[0].lat, location.lat);
    assert.equal(
      (await snapshot(created.id)).current_location.timestamp,
      location.timestamp,
    );
    for (const socket of sockets) socket.disconnect();
    sockets.clear();

    const publicData = await result(
      await request(`/track/${created.trackingId}`),
      200,
    );
    assert.ok(!JSON.stringify(publicData).includes("PRIVATE-"));
    assert.equal(publicData.driver, undefined);
    const issueBody = {
      expectedVersion: current.version,
      recipientEmail: input.recipientEmail,
    };
    const challenge = await result(
      await request(`${path}/delivery-code`, {
        actor: owner,
        method: "POST",
        body: issueBody,
        key: "issue-code",
      }),
      200,
    );
    const repeatedIssue = await request(`${path}/delivery-code`, {
      actor: owner,
      method: "POST",
      body: issueBody,
      key: "issue-code",
    });
    assert.equal(repeatedIssue.headers.get("Idempotency-Replayed"), "true");
    assert.equal(
      (await result(repeatedIssue, 200)).challengeId,
      challenge.challengeId,
    );
    const transport = createGraphTestTransport({ port: mail.port });
    try {
      const dispatch = createDeliveryEmailProcessor(
        fixture.store,
        fixture.deliverySecret,
        async (email) => {
          await transport.send({ from: "journey@example.test", ...email });
        },
      );
      await dispatch();
      await dispatch();
    } finally {
      transport.close();
    }
    assert.equal(mail.accepted.length, 1);
    assert.match(mail.accepted[0], /recipient@example.test/);
    const code = /\bis (\d{8})\./.exec(mail.accepted[0])?.[1];
    assert.ok(code, "Local Graph HTTP capture must contain the delivery code");
    const driverChallenge = await result(
      await request(`${path}/delivery-code`, { actor: driver }),
      200,
    );
    assert.ok(!JSON.stringify(driverChallenge).includes(code));
    const beforeConfirmation = await snapshot(created.id);
    const confirmation = {
      expectedVersion: challenge.version,
      challengeId: challenge.challengeId,
      code,
    };
    assert.equal(
      (
        await request(`${path}/confirm-delivery`, {
          actor: other,
          method: "POST",
          body: confirmation,
          key: "foreign-proof",
        })
      ).status,
      403,
    );
    const wrong = await request(`${path}/confirm-delivery`, {
      actor: driver,
      method: "POST",
      body: {
        ...confirmation,
        code: code === "00000000" ? "11111111" : "00000000",
      },
      key: "wrong-proof",
    });
    assert.equal(wrong.status, 422);
    assert.deepEqual(await snapshot(created.id), beforeConfirmation);
    if (lostAcknowledgement) {
      const droppedBefore = fixture.droppedResponses;
      fixture.dropNextDatabaseResponseContaining("delivery_command(");
      assert.equal(
        (
          await request(`${path}/confirm-delivery`, {
            actor: driver,
            method: "POST",
            body: confirmation,
            key: "confirm-proof",
          })
        ).status,
        500,
      );
      assert.equal(fixture.droppedResponses, droppedBefore + 1);
      const committedWithoutAcknowledgement = await snapshot(created.id);
      assert.equal(committedWithoutAcknowledgement.status, "delivered");
      assert.equal(
        committedWithoutAcknowledgement.events,
        beforeConfirmation.events + 1,
      );
      assert.equal(committedWithoutAcknowledgement.consumed, 1);
      assert.ok(
        fixture.logs.some(
          (event) => event.event === "request_failed" && event.status === 500,
        ),
      );
    }
    const confirmed = await result(
      await request(`${path}/confirm-delivery`, {
        actor: driver,
        method: "POST",
        body: confirmation,
        key: "confirm-proof",
      }),
      200,
    );
    assert.equal(confirmed.status, "delivered");
    const completed = await snapshot(created.id);
    assert.equal(completed.consumed, 1);
    assert.equal(completed.events, beforeConfirmation.events + 1);
    assert.ok(completed.actual_delivery);
    const duplicate = await request(`${path}/confirm-delivery`, {
      actor: driver,
      method: "POST",
      body: confirmation,
      key: "confirm-proof",
    });
    assert.equal(duplicate.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(await result(duplicate, 200), confirmed);
    assert.deepEqual(await snapshot(created.id), completed);
    for (const actor of [owner, driver, customer]) {
      const detail = await result(await request(path, { actor }), 200);
      assert.equal(detail.status, "delivered");
      const history = await result(
        await request(`${path}/events?limit=50`, { actor }),
        200,
      );
      assert.equal(
        history.filter((event) => event.status === "delivered").length,
        1,
      );
    }
    assert.equal(
      (await request(`${path}/events`, { actor: other })).status,
      404,
    );
    assert.deepEqual(fixture.databaseErrors, []);
    assert.ok(
      (await fixture.redis.keys("*")).length > 0,
      "API requests must exercise real Redis budgets",
    );
    const { rows: records } = await fixture.pool.query(
      "select parameters,response from idempotency_requests",
    );
    assert.ok(
      !JSON.stringify(records).includes(code),
      "Saved retries must not retain the plaintext recipient code",
    );
    const output = JSON.stringify(fixture.logs);
    for (const secret of [
      password,
      code,
      owner.token,
      driver.token,
      customer.token,
    ])
      assert.ok(
        !output.includes(secret),
        "Application events must not expose credentials or delivery proof",
      );
  });
}
