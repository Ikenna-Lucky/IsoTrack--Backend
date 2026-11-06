import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import {
  apiBodyBoundary,
  createApiProtection,
} from "../src/middleware/api-protection.ts";
import { createRedisBudget } from "../src/lib/api-budget.ts";

test("body limits inspect streamed bytes even when Content-Length understates them", async () => {
  const app = new Hono();
  let calls = 0;
  app.use("*", apiBodyBoundary());
  app.post("*", async (c) => {
    calls++;
    return c.text(await c.req.text());
  });
  for (const headers of [{}, { "Content-Length": "1" }]) {
    const response = await app.request("/api/v1/test", {
      method: "POST",
      headers,
      body: "x".repeat(16385),
    });
    assert.equal(response.status, 413);
  }
  assert.equal(calls, 0);
  assert.equal(
    (
      await app.request("/api/v1/test", {
        method: "POST",
        body: "x".repeat(16384),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request("/api/v1/test", {
        method: "POST",
        headers: { "Content-Encoding": "gzip" },
        body: "abc",
      })
    ).status,
    415,
  );
});

test("stalled body streams time out and are cancelled before a handler runs", async () => {
  const app = new Hono();
  let calls = 0,
    cancelled = false;
  app.use("*", apiBodyBoundary(25));
  app.post("*", (c) => {
    calls++;
    return c.text("OK");
  });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await app.request(
    new Request("http://localhost/api/v1/test", {
      method: "POST",
      body: stream,
      duplex: "half",
    }),
  );
  assert.equal(response.status, 408);
  assert.equal(calls, 0);
  assert.equal(cancelled, true);
});

test("guard fails closed without a verified peer, skips preflights and never echoes Redis errors", async () => {
  for (const peer of [undefined, "invalid", "127.0.0.1"]) {
    const app = new Hono();
    let calls = 0,
      reported = 0;
    const protect = createApiProtection({
      secret: "test-budget-signing-key-32-characters",
      peer: () => peer,
      budget: {
        consume: async () => {
          throw new Error("PRIVATE-REDIS-URL");
        },
      },
      reportFailure: () => {
        reported++;
      },
    });
    app.use("*", protect("tracking", "peer"));
    app.all("*", (c) => {
      calls++;
      return c.text("OK");
    });
    const response = await app.request("/track/id");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "5");
    assert.ok(!(await response.text()).includes("PRIVATE-"));
    assert.equal(calls, 0);
    assert.equal(reported, peer === "127.0.0.1" ? 1 : 0);
    assert.equal(
      (await app.request("/track/id", { method: "OPTIONS" })).status,
      200,
    );
  }
});

test("budget adapter rejects malformed replies and invalid policies", async () => {
  for (const result of [null, [2, 1000], [1, -1], [1, 60001], [1, "1000"]]) {
    const budget = createRedisBudget({ eval: async () => result });
    await assert.rejects(() => budget.consume("key", 1, 60000));
  }
  const budget = createRedisBudget({ eval: async () => [1, 1] });
  await assert.rejects(() => budget.consume("key", 0, 60000));
});
