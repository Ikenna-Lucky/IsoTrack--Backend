import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createPaystackWebhookRouter } from "../src/routes/paystack-webhook.ts";

const secret = "isolated-paystack-test-secret";
const charge = { event: "charge.success", data: { reference: "IST-PAY-TEST", status: "success",
  amount: 100, currency: "NGN", channel: "card", paid_at: "2026-11-03T00:00:00.000Z" } };
const signature = (body) => createHmac("sha512", secret).update(body).digest("hex");
function fixture(options = {}) {
  const calls = [];
  const app = new Hono();
  app.onError((error, c) => error instanceof HTTPException ? error.getResponse() : c.text("Storage failure", 500));
  app.route("/", createPaystackWebhookRouter({ secret, confirm: async (value) => {
    calls.push(value); if (options.fail) throw new Error("database down"); return options.match !== false;
  }, ...options }));
  // Match the production mount order: user authentication protects later routes.
  app.use("*", (c) => c.text("Authentication required", 401));
  app.post("/initialize", (c) => c.text("Must not be reached", 200));
  const send = (body = JSON.stringify(charge), header = signature(body)) => app.request("/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", ...(header === null ? {} : { "x-paystack-signature": header }) }, body,
  });
  return { app, send, calls };
}

test("signed webhook is public while other payment routes remain protected", async () => {
  const { app, send, calls } = fixture();
  assert.equal((await send()).status, 200);
  assert.equal(calls[0].amountKobo, 100);
  assert.equal((await app.request("/initialize", { method: "POST" })).status, 401);
});

test("invalid or missing signatures never reach settlement", async () => {
  const { send, calls } = fixture();
  for (const header of [null, "bad", "f".repeat(128)]) assert.equal((await send(undefined, header)).status, 401);
  assert.equal(calls.length, 0);
});

test("signature covers raw bytes, including whitespace", async () => {
  const { send } = fixture();
  const compact = JSON.stringify(charge);
  const formatted = JSON.stringify(charge, null, 2);
  assert.equal((await send(formatted, signature(compact))).status, 401);
  assert.equal((await send(formatted)).status, 200);
});

test("malformed or incomplete signed events cannot confirm payment", async () => {
  const { send, calls } = fixture();
  for (const body of ["{", "null", JSON.stringify({ event: "charge.success" }),
    JSON.stringify({ ...charge, data: { ...charge.data, amount: -1 } }),
    JSON.stringify({ ...charge, data: { ...charge.data, paid_at: null } }),
    JSON.stringify({ ...charge, data: { ...charge.data, status: "pending" } })]) {
    assert.equal((await send(body)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test("unsupported signed events are acknowledged without changing payments", async () => {
  const { send, calls } = fixture();
  assert.equal((await send(JSON.stringify({ event: "transfer.success", data: {} }))).status, 200);
  assert.equal(calls.length, 0);
});

test("unmatched charges and storage failures are not acknowledged as successful", async () => {
  assert.equal((await fixture({ match: false }).send()).status, 409);
  assert.equal((await fixture({ fail: true }).send()).status, 500);
});

test("missing configuration and oversized bodies fail closed", async () => {
  assert.equal((await fixture({ secret: undefined }).send()).status, 503);
  const { send, calls } = fixture();
  assert.equal((await send("x".repeat(262_145))).status, 413);
  assert.equal(calls.length, 0);
});
