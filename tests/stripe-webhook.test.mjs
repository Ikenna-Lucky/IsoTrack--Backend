import assert from "node:assert/strict";
import { test } from "node:test";
import Stripe from "stripe";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createStripeWebhookRouter } from "../src/routes/stripe-webhook.ts";
import { parseStripeSession } from "../src/lib/stripe-payload.ts";

const secret = "whsec_isolated_test";
const event = {
  id: "evt_test",
  object: "event",
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_example",
      object: "checkout.session",
      mode: "payment",
      client_reference_id: "REF",
      metadata: { reference: "REF" },
      status: "complete",
      payment_status: "paid",
      amount_total: 100,
      currency: "ngn",
    },
  },
};
function fixture(options = {}) {
  const calls = [];
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : c.text("Storage failure", 500),
  );
  app.route(
    "/",
    createStripeWebhookRouter({
      secret,
      expectedLiveMode: false,
      parseSession: (session, paidAt) =>
        parseStripeSession(session, undefined, paidAt),
      confirm: async (payment) => {
        calls.push(payment);
        if (options.fail) throw Error("storage");
        return options.match !== false;
      },
      ...options,
    }),
  );
  app.use("*", (c) => c.text("Authentication required", 401));
  const send = (
    body = JSON.stringify(event),
    signature = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret,
    }),
  ) =>
    app.request("/webhook", {
      method: "POST",
      body,
      headers: { "stripe-signature": signature },
    });
  return { app, calls, send };
}
test("Stripe signed webhook is public while other endpoints require authentication", async () => {
  const { app, calls, send } = fixture();
  assert.equal((await send()).status, 200);
  assert.equal(calls[0].reference, "REF");
  assert.equal(
    (await app.request("/initialize", { method: "POST" })).status,
    401,
  );
});
test("invalid, stale and modified signatures do not settle", async () => {
  const { calls, send } = fixture();
  const body = JSON.stringify(event);
  for (const signature of [
    "invalid",
    Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret,
      timestamp: 1,
    }),
    Stripe.webhooks.generateTestHeaderString({ payload: body + " ", secret }),
  ])
    assert.equal((await send(body, signature)).status, 400);
  assert.equal(calls.length, 0);
});
test("wrong mode and malformed sessions cannot settle", async () => {
  const { send, calls } = fixture();
  assert.equal(
    (await send(JSON.stringify({ ...event, livemode: true }))).status,
    400,
  );
  assert.equal(
    (await send(JSON.stringify({ ...event, data: { object: {} } }))).status,
    400,
  );
  assert.equal(calls.length, 0);
});
test("unpaid completion and unrelated Stripe events are acknowledged without settlement", async () => {
  const { send, calls } = fixture();
  assert.equal(
    (await send(JSON.stringify({ ...event, type: "payment_intent.succeeded" })))
      .status,
    200,
  );
  assert.equal(
    (
      await send(
        JSON.stringify({
          ...event,
          data: { object: { ...event.data.object, payment_status: "unpaid" } },
        }),
      )
    ).status,
    200,
  );
  assert.equal(calls.length, 0);
});
test("asynchronous paid completion is settled", async () => {
  const { send, calls } = fixture();
  assert.equal(
    (
      await send(
        JSON.stringify({
          ...event,
          type: "checkout.session.async_payment_succeeded",
        }),
      )
    ).status,
    200,
  );
  assert.equal(calls.length, 1);
});
test("configuration, body size, storage and unmatched errors remain non-success", async () => {
  assert.equal((await fixture({ secret: undefined }).send()).status, 503);
  assert.equal((await fixture().send("x".repeat(262145))).status, 413);
  assert.equal((await fixture({ fail: true }).send()).status, 500);
  assert.equal((await fixture({ match: false }).send()).status, 409);
});
