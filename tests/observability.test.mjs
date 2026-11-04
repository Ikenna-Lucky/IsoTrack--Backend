import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  createTelemetry,
  createEventLogger,
  requestTelemetry,
  safeErrorHandler,
  currentRequestId,
  instrumentDatabaseFetch,
} from "../src/observability/telemetry.ts";
import { createOperationalRouter } from "../src/observability/health.ts";

test("request logs use route templates and one generated correlation ID without copying secrets", async () => {
  const logs = [];
  const metrics = createTelemetry();
  const log = createEventLogger((line) => logs.push(JSON.parse(line)));
  const app = new Hono();
  app.use("*", requestTelemetry(metrics, log));
  app.onError(safeErrorHandler(log));
  app.get("/api/v1/shipments/:id", (c) => c.json({ id: currentRequestId() }));
  app.get("/failure", () => {
    throw new Error("postgres://password@host SELECT secret_token");
  });
  const responses = await Promise.all(
    ["private-reference-a", "private-reference-b"].map((id) =>
      app.request(`/api/v1/shipments/${id}?token=SECRET`, {
        headers: {
          Authorization: "Bearer SECRET",
          Cookie: "refresh=SECRET",
          "X-Request-Id": "attacker",
        },
      }),
    ),
  );
  const ids = await Promise.all(
    responses.map(async (r) => {
      const id = r.headers.get("X-Request-Id");
      assert.equal((await r.json()).id, id);
      return id;
    }),
  );
  assert.notEqual(ids[0], ids[1]);
  assert.notEqual(ids[0], "attacker");
  assert.equal((await app.request("/failure")).status, 500);
  const serialized = JSON.stringify(logs) + (await metrics.registry.metrics());
  for (const secret of [
    "SECRET",
    "private-reference-a",
    "private-reference-b",
    "postgres://",
    "secret_token",
  ])
    assert.ok(!serialized.includes(secret));
  assert.ok(serialized.includes("/api/v1/shipments/:id"));
  assert.equal(await metrics.inflight.get().then((m) => m.values[0].value), 0);
});

test("unknown paths cannot grow metric labels per request", async () => {
  const metrics = createTelemetry();
  const app = new Hono();
  app.use(
    "*",
    requestTelemetry(metrics, () => {}),
  );
  for (let i = 0; i < 100; i++) await app.request(`/unknown-${i}`);
  const result = await metrics.http.get();
  assert.deepEqual(
    [...new Set(result.values.map((v) => v.labels.route))],
    ["unmatched"],
  );
  assert.equal(
    result.values.find((v) => v.metricName.endsWith("_count")).value,
    100,
  );
});

test("log projection discards bodies, credentials, arbitrary errors and unsupported fields", () => {
  const lines = [];
  const log = createEventLogger((line) => lines.push(line));
  log("dependency_failure", {
    operation: "tracking",
    password: "SECRET",
    email: "PERSONAL",
    headers: { authorization: "SECRET" },
    error: new Error("SECRET"),
    body: "SECRET",
    query: "SECRET",
  });
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), [
    "event",
    "level",
    "operation",
    "timestamp",
  ]);
  const throwing = createEventLogger(() => {
    throw new Error("Disk full");
  });
  assert.doesNotThrow(() => throwing("dependency_failure"));
});

test("client errors retain status while internal errors have safe response and logs", async () => {
  const logs = [];
  const app = new Hono();
  app.onError(safeErrorHandler(createEventLogger((line) => logs.push(line))));
  app.get("/denied", () => {
    throw new HTTPException(401, { message: "Unauthorized" });
  });
  app.get("/internal", () => {
    throw new HTTPException(503, { message: "SECRET upstream key" });
  });
  assert.equal((await app.request("/denied")).status, 401);
  const response = await app.request("/internal");
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("SECRET"));
  assert.ok(!logs.join("").includes("SECRET"));
});

test("health probes share work, time out, stay live and fail readiness while draining", async () => {
  let calls = 0,
    draining = false;
  const metrics = createTelemetry();
  const app = createOperationalRouter({
    metrics,
    token: "fixture-token".repeat(4),
    draining: () => draining,
    timeoutMs: 30,
    database: async () => {
      calls++;
      await new Promise(() => {});
    },
    redis: async () => {},
    backlog: async () => [],
  });
  assert.equal((await app.request("/health/live")).status, 200);
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => app.request("/health/ready")),
  );
  assert.ok(responses.every((r) => r.status === 503));
  assert.equal(calls, 1);
  assert.equal((await app.request("/metrics")).status, 401);
  draining = true;
  assert.equal((await app.request("/health/ready")).status, 503);
  assert.equal((await app.request("/health/live")).status, 200);
});

test("metrics token protects collection and readiness tolerates asynchronous Redis degradation", async () => {
  const metrics = createTelemetry();
  let calls = 0;
  const deps = {
    metrics,
    token: "fixture-token".repeat(4),
    draining: () => false,
    database: async () => {},
    redis: async () => {
      throw new Error("SECRET Redis URL");
    },
    backlog: async () => {
      calls++;
      return [];
    },
  };
  const app = createOperationalRouter(deps);
  assert.equal((await app.request("/health/ready")).status, 200);
  assert.equal((await app.request("/metrics")).status, 401);
  assert.equal(calls, 0);
  const r = await app.request("/metrics", {
    headers: { Authorization: `Bearer ${deps.token}` },
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/plain/);
  assert.ok(!(await r.text()).includes("SECRET"));
  assert.equal(calls, 1);
  assert.equal(
    (
      await createOperationalRouter({ ...deps, token: undefined }).request(
        "/metrics",
      )
    ).status,
    404,
  );
});

test("database transport metrics record success, HTTP failure and outages without query labels", async () => {
  const metrics = createTelemetry();
  let mode = 0;
  const run = instrumentDatabaseFetch(metrics, async () => {
    if (mode === 2) throw new Error("SECRET");
    return new Response("{}", { status: mode === 0 ? 200 : 503 });
  });
  await run("http://fixture/query?SECRET");
  mode = 1;
  await run("http://fixture/query");
  mode = 2;
  await assert.rejects(run("http://fixture/query"));
  const values = (await metrics.database.get()).values.filter((v) =>
    v.metricName.endsWith("_count"),
  );
  assert.equal(values.find((v) => v.labels.outcome === "success").value, 1);
  assert.equal(values.find((v) => v.labels.outcome === "error").value, 2);
  assert.ok(!(await metrics.registry.metrics()).includes("SECRET"));
});
