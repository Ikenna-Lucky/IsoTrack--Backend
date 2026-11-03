import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requireIdempotencyKey,
  requestFingerprint,
} from "../src/lib/idempotency.ts";
import { shipmentInput } from "../src/lib/write-inputs.ts";
import { Hono } from "hono";
import { ZodError } from "zod";
import { createShipmentCreationRouter } from "../src/routes/idempotent-writes.ts";
import { apiCors } from "../src/lib/api-cors.ts";

test("HTTP validation rejects bad input while internal schema errors remain server failures", async () => {
  let writes = 0;
  const authorize = async (c, next) => {
    c.set("userId", "owner");
    c.set("userRole", "business");
    c.set("user", { email: "owner@example.test" });
    await next();
  };
  const app = createShipmentCreationRouter({
    authorize,
    writes: {
      createShipment: async () => {
        writes++;
        throw new ZodError([]);
      },
    },
  });
  app.onError((_error, c) => c.json({ error: "SERVER_FAILURE" }, 500));
  const headers = {
    "Content-Type": "application/json",
    "Idempotency-Key": "test-request-key-123456",
  };
  assert.equal(
    (await app.request("/", { method: "POST", headers, body: "{" })).status,
    400,
  );
  assert.equal(
    (await app.request("/", { method: "POST", headers, body: "{}" })).status,
    400,
  );
  assert.equal(writes, 0);
  const valid = {
    description: "Box",
    weightKg: 1,
    pickupAddress: { street: "A", city: "Lagos" },
    deliveryAddress: { street: "B", city: "Lagos" },
    priceKobo: 100,
  };
  assert.equal(
    (
      await app.request("/", {
        method: "POST",
        headers,
        body: JSON.stringify(valid),
      })
    ).status,
    500,
  );
  assert.equal(writes, 1);
});

test("API CORS permits idempotency preflights and exposes replay/retry headers", async () => {
  const app = new Hono();
  app.use("*", apiCors("https://app.example.test/path"));
  app.post("/write", (c) => c.json({ ok: true }));
  const response = await app.request("/write", {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.example.test",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "content-type,authorization,idempotency-key",
    },
  });
  assert.equal(response.status, 204);
  assert.match(
    response.headers.get("access-control-allow-headers"),
    /Idempotency-Key/i,
  );
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://app.example.test",
  );
  const actual = await app.request("/write", {
    method: "POST",
    headers: { Origin: "https://app.example.test" },
  });
  assert.match(
    actual.headers.get("access-control-expose-headers"),
    /Idempotency-Replayed/i,
  );
  assert.match(
    actual.headers.get("access-control-expose-headers"),
    /Retry-After/i,
  );
});

test("request fingerprints ignore object ordering and preserve meaningful changes", () => {
  assert.equal(
    requestFingerprint({ a: 1, b: { x: 2, y: 3 } }),
    requestFingerprint({ b: { y: 3, x: 2 }, a: 1 }),
  );
  assert.notEqual(requestFingerprint({ a: 1 }), requestFingerprint({ a: "1" }));
  assert.notEqual(
    requestFingerprint({ a: [1, 2] }),
    requestFingerprint({ a: [2, 1] }),
  );
  assert.equal(
    requireIdempotencyKey("12345678-1234-1234-1234-123456789abc"),
    "12345678-1234-1234-1234-123456789abc",
  );
  for (const key of [
    undefined,
    "short",
    "a".repeat(129),
    "contains spaces in key",
    "unsafe/key/path/123",
  ]) {
    assert.throws(() => requireIdempotencyKey(key));
  }
});
test("shipment request validation normalizes defaults, email and equivalent timestamps", () => {
  const body = {
    description: " Package ",
    weightKg: 1,
    pickupAddress: { street: "A", city: "Lagos" },
    deliveryAddress: { street: "B", city: "Lagos" },
    priceKobo: 100,
    customerEmail: "CUSTOMER@example.test",
    scheduledPickup: "2026-12-01T12:00:00+01:00",
  };
  const first = shipmentInput.parse(body);
  const second = shipmentInput.parse({
    ...body,
    description: "Package",
    customerEmail: "customer@example.test",
    scheduledPickup: "2026-12-01T11:00:00Z",
    pickupAddress: { ...body.pickupAddress, state: "Lagos" },
  });
  assert.equal(requestFingerprint(first), requestFingerprint(second));
  assert.equal(
    shipmentInput.safeParse({ ...body, priceKobo: 2147483648 }).success,
    false,
  );
  assert.equal(
    shipmentInput.safeParse({ ...body, weightKg: Infinity }).success,
    false,
  );
  assert.equal(
    shipmentInput.safeParse({ ...body, userId: "spoofed" }).success,
    false,
  );
});
