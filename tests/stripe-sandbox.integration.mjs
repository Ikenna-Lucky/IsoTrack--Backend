import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import Stripe from "stripe";
import { journeyFixture } from "./helpers/journey-fixture.mjs";

// Vendor HTTP is synthetic; routing, official SDK, signatures and persistence
// are real. Actual Stripe sandbox evidence must be recorded separately.
const sessions = new Map(),
  calls = [];
let unavailableCreates = 0;
const fixture = journeyFixture({
  stripe: async (request) => {
    calls.push(request);
    assert.equal(
      request.headers.authorization,
      "Bearer sk_test_journey_fixture",
    );
    assert.equal(request.headers["stripe-version"], "2026-10-28.endive");
    if (request.method === "POST" && request.path === "/v1/checkout/sessions") {
      const input = new URLSearchParams(request.body);
      const key = request.headers["idempotency-key"];
      assert.ok(key.startsWith("isotrack_"));
      let session = [...sessions.values()].find((value) => value.key === key);
      if (!session) {
        const id = `cs_test_journey_${sessions.size + 1}`;
        session = {
          key,
          id,
          object: "checkout.session",
          mode: "payment",
          livemode: false,
          client_reference_id: input.get("client_reference_id"),
          metadata: {
            reference: input.get("metadata[reference]"),
            shipmentId: input.get("metadata[shipmentId]"),
          },
          amount_total: Number(
            input.get("line_items[0][price_data][unit_amount]"),
          ),
          currency: input.get("line_items[0][price_data][currency]"),
          status: "open",
          payment_status: "unpaid",
          url: `https://checkout.stripe.com/c/pay/${id}`,
        };
        sessions.set(id, session);
      }
      if (unavailableCreates-- > 0)
        return {
          status: 503,
          body: {
            error: {
              type: "api_error",
              message: "Injected provider failure after session creation",
            },
          },
        };
      return { body: session };
    }
    const session = sessions.get(request.path.split("/").at(-1));
    if (request.method === "GET" && session) return { body: session };
    throw new Error("Unexpected Stripe fixture request");
  },
});
const password = "SandboxJourney123!";
let owner, other, customer, shipment;

async function request(path, { actor, method = "GET", body, key } = {}) {
  return fetch(`${fixture.base}/api/v1${path}`, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key.padEnd(24, "_") } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function data(response, status) {
  assert.equal(
    response.status,
    status,
    `Database errors: ${JSON.stringify(fixture.databaseErrors)}`,
  );
  return (await response.json()).data;
}
async function register(name, role) {
  const value = await data(
    await request("/auth/register", {
      method: "POST",
      body: {
        name: `Sandbox ${name}`,
        email: `${name}@example.test`,
        password,
        role,
      },
    }),
    201,
  );
  return { token: value.accessToken, id: value.user.id };
}
const initialize = (key = "checkout") =>
  request("/payments/initialize", {
    actor: owner,
    method: "POST",
    body: { shipmentId: shipment.id },
    key,
  });
async function paymentState() {
  const { rows } = await fixture.pool.query(
    `select s.is_paid,
    (select count(*)::int from payments where shipment_id=s.id) payments,
    (select count(*)::int from shipment_payment_receipts where shipment_id=s.id) receipts,
    (select count(*)::int from payment_checkout_guards where shipment_id=s.id) guards,
    (select count(*)::int from notification_outbox where shipment_id=s.id) notices,
    (select count(*)::int from payments where shipment_id=s.id and status='success') settled
    from shipments s where s.id=$1`,
    [shipment.id],
  );
  return rows[0];
}
function webhook(session, type = "checkout.session.completed", change = {}) {
  const body = JSON.stringify({
    id: "evt_journey",
    object: "event",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: { object: session },
    ...change,
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: "whsec_journey_fixture",
  });
  return fetch(`${fixture.base}/api/v1/payments/webhook`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": signature,
    },
  });
}
before(async () => {
  await fixture.start();
});
beforeEach(async () => {
  await fixture.pool.query(
    "truncate users,idempotency_requests,account_action_limits cascade",
  );
  await fixture.redis.flushdb();
  sessions.clear();
  calls.length = 0;
  unavailableCreates = 0;
  fixture.databaseErrors.length = 0;
  owner = await register("owner", "business");
  other = await register("other", "business");
  customer = await register("customer", "customer");
  shipment = await data(
    await request("/shipments", {
      actor: owner,
      method: "POST",
      key: "shipment",
      body: {
        description: "Sandbox payment parcel",
        weightKg: 1,
        customerId: customer.id,
        priceKobo: 250000,
        pickupAddress: { street: "Pickup", city: "Lagos" },
        deliveryAddress: { street: "Destination", city: "Lagos" },
      },
    }),
    201,
  );
});
after(async () => {
  await fixture.stop();
});

test("sandbox checkout and public signed webhooks settle once without trusting redirects or foreign accounts", async () => {
  const checkout = await data(await initialize(), 200);
  const replay = await initialize();
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(await data(replay, 200), checkout);
  assert.equal(sessions.size, 1);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  const initial = await paymentState();
  assert.equal(initial.is_paid, false);
  assert.equal(
    (await request(`/payments/verify/${checkout.reference}`, { actor: other }))
      .status,
    404,
  );
  assert.equal(
    (await request(`/payments/verify/${checkout.reference}`)).status,
    401,
  );
  await data(
    await request(`/payments/verify/${checkout.reference}?paid=true`, {
      actor: customer,
    }),
    200,
  );
  assert.deepEqual(await paymentState(), initial);
  const session = sessions.get(checkout.sessionId);
  session.status = "complete";
  session.payment_status = "paid";
  assert.equal(
    (await webhook(session, undefined, { livemode: true })).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${fixture.base}/api/v1/payments/webhook`, {
        method: "POST",
        body: "{}",
      })
    ).status,
    400,
  );
  assert.deepEqual(await paymentState(), initial);
  for (let i = 0; i < 3; i++)
    assert.equal((await webhook(session)).status, 200);
  const settled = await paymentState();
  assert.equal(settled.is_paid, true);
  assert.equal(settled.receipts, 1);
  assert.equal(settled.settled, 1);
  for (const actor of [owner, customer])
    await data(
      await request(`/payments/verify/${checkout.reference}`, { actor }),
      200,
    );
  assert.deepEqual(await paymentState(), settled);
  assert.equal((await initialize("new-after-payment")).status, 409);
  assert.deepEqual(fixture.databaseErrors, []);
});

test("unknown sandbox provider outcomes retain the original checkout and provider idempotency key", async () => {
  unavailableCreates = 2; // Both the SDK's initial call and its single network retry.
  assert.equal((await initialize()).status, 502);
  const uncertain = await paymentState();
  assert.equal(uncertain.is_paid, false);
  assert.equal(uncertain.payments, 1);
  assert.equal(uncertain.guards, 1);
  const recovered = await data(await initialize(), 200);
  assert.equal(sessions.size, 1);
  const creates = calls.filter((call) => call.method === "POST");
  assert.ok(creates.length >= 3);
  assert.equal(
    new Set(creates.map((call) => call.headers["idempotency-key"])).size,
    1,
  );
  assert.equal(new Set(creates.map((call) => call.body)).size, 1);
  assert.equal(recovered.sessionId, [...sessions.keys()][0]);
  assert.deepEqual(await paymentState(), uncertain);
  assert.deepEqual(fixture.databaseErrors, []);
});

test("an expired unpaid sandbox checkout releases its guard and permits a new payment attempt", async () => {
  const first = await data(await initialize(), 200);
  const session = sessions.get(first.sessionId);
  session.status = "expired";
  assert.equal(
    (await webhook(session, "checkout.session.expired")).status,
    200,
  );
  assert.equal(
    (await webhook(session, "checkout.session.expired")).status,
    200,
  );
  const expired = await paymentState();
  assert.equal(expired.is_paid, false);
  assert.equal(expired.receipts, 0);
  assert.equal(expired.guards, 0);
  assert.equal((await initialize()).status, 409);
  const second = await data(await initialize("after-expiry"), 200);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(sessions.size, 2);
  assert.equal((await paymentState()).payments, 2);
  assert.deepEqual(fixture.databaseErrors, []);
});
