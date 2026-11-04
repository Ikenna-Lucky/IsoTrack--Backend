import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createDeliveryRouter } from "../src/routes/delivery.ts";
test("delivery routes fail closed without configuration and reject malformed bodies before storage", async () => {
  const store = {
    execute: async () => {
      throw new Error("Storage must not be called");
    },
  };
  function app(secret) {
    const a = new Hono();
    a.use("*", async (c, next) => {
      c.set("userId", "owner");
      c.set("userRole", "business");
      await next();
    });
    a.route("/", createDeliveryRouter(store, secret));
    return a;
  }
  const request = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "valid-key-for-delivery",
    },
    body: JSON.stringify({
      expectedVersion: 1,
      recipientEmail: "guest@example.test",
    }),
  };
  assert.equal(
    (await app(undefined).request("/shipment/delivery-code", request)).status,
    503,
  );
  assert.equal(
    (
      await app("ab".repeat(32)).request("/shipment/delivery-code", {
        ...request,
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await app("ab".repeat(32)).request("/shipment/delivery-code", {
        ...request,
        body: JSON.stringify({ expectedVersion: 1, recipientEmail: "bad" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (await app("ab".repeat(32)).request("/bad!/delivery-code")).status,
    400,
  );
  assert.equal(
    (
      await app("ab".repeat(32)).request("/shipment/delivery-code", {
        ...request,
        body: "x".repeat(2049),
      })
    ).status,
    413,
  );
});
import {
  deliveryCode,
  deliveryProof,
  deliveryFingerprint,
} from "../src/lib/delivery-code.ts";
test("delivery codes and proofs are deterministic, domain-separated and key-dependent", () => {
  const key = "ab".repeat(32),
    code = deliveryCode("challenge", key);
  assert.match(code, /^\d{8}$/);
  assert.equal(deliveryCode("challenge", key), code);
  assert.notEqual(deliveryCode("other", key), code);
  assert.match(deliveryProof("challenge", code, key), /^[a-f0-9]{64}$/);
  assert.notEqual(
    deliveryProof("challenge", code, key),
    deliveryProof("other", code, key),
  );
  assert.notEqual(
    deliveryFingerprint({ code }, key),
    deliveryFingerprint({ code }, "cd".repeat(32)),
  );
  assert.throws(() => deliveryCode("challenge", "bad-key"));
});
