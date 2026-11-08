import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertPreviewIsolation } from "../src/lib/preview-isolation.ts";
import { percentile } from "./load-engine.mjs";

// Low-rate sequential diagnosis, separate from load acceptance or capacity tests.
const expectedSha = process.argv[2];
const runId = randomUUID();
const report = {
  runId,
  startedAt: new Date().toISOString(),
  completed: false,
  scope:
    "Six sequential samples per endpoint from this machine; no shipment/payment writes, provider calls or capacity claim",
  expectedSha,
  requestDeadlineMs: 10000,
  gapMs: 2000,
  samples: [],
  setup: [],
  summary: {},
};
let origin,
  token,
  cookie,
  config,
  timeoutCount = 0;
async function probe(name, path, options = {}, setup = false) {
  const started = performance.now();
  const result = { name, route: path, startedAt: new Date().toISOString() };
  let body;
  try {
    const response = await fetch(origin + path, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    result.headersMs = Math.round(performance.now() - started);
    result.status = response.status;
    result.requestId = response.headers.get("X-Request-Id");
    result.retryAfter = response.headers.get("Retry-After");
    const text = await response.text();
    assert(Buffer.byteLength(text) <= 131072);
    result.bytes = Buffer.byteLength(text);
    body = JSON.parse(text);
  } catch (error) {
    result.failure = ["TimeoutError", "AbortError"].includes(error.name)
      ? "timeout"
      : "transport_or_response_error";
    if (result.failure === "timeout") timeoutCount++;
  }
  result.totalMs = Math.round(performance.now() - started);
  (setup ? report.setup : report.samples).push(result);
  return { result, body };
}
try {
  assert(/^[a-f0-9]{40}$/.test(expectedSha ?? ""));
  config = parseEnv(await readFile(".env.preview", "utf8"));
  assertPreviewIsolation({ ...config, RELEASE_SHA: expectedSha });
  origin = new URL(config.APP_URL).origin;
  assert.equal(origin, "https://isotrack-backend-preview.onrender.com");
  assert(config.PREVIEW_FIXTURE_PASSWORD?.length >= 32);
  const release = await probe("release", "/health/release", {}, true);
  assert.equal(release.result.status, 200);
  assert.equal(release.body.environment, "preview");
  assert.equal(release.body.sha, expectedSha);
  report.release = release.body;

  // One fixture login is the only intended database write (session/auth budget).
  let loginResponse;
  const originalFetch = globalThis.fetch;
  // Capture the cookie without retaining token or cookie values in the report.
  const loginStart = performance.now();
  loginResponse = await originalFetch(origin + "/api/v1/auth/login", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "preview-owner@example.invalid",
      password: config.PREVIEW_FIXTURE_PASSWORD,
    }),
  });
  const login = await loginResponse.json();
  report.setup.push({
    name: "fixture login",
    status: loginResponse.status,
    totalMs: Math.round(performance.now() - loginStart),
    requestId: loginResponse.headers.get("X-Request-Id"),
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(login.data.user.id, "preview-owner");
  token = login.data.accessToken;
  assert(token);
  cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];

  const endpoints = [
    {
      name: "liveness",
      path: "/health/live",
      valid: (body) => body?.status === "ok",
    },
    {
      name: "readiness",
      path: "/health/ready",
      valid: (body) => body?.status === "ready",
    },
    {
      name: "shipment",
      path: "/api/v1/shipments/preview-shipment",
      valid: (body) => body?.data?.id === "preview-shipment",
    },
  ];
  for (let round = 0; round < 6; round++) {
    // Rotate order so a particular endpoint is not always the first request.
    for (let offset = 0; offset < 3; offset++) {
      const endpoint = endpoints[(round + offset) % 3];
      const { result, body } = await probe(
        endpoint.name,
        endpoint.path,
        endpoint.name === "shipment"
          ? { headers: { Authorization: `Bearer ${token}` } }
          : {},
      );
      result.round = round + 1;
      result.valid =
        result.status === 200 && !result.failure && endpoint.valid(body);
      console.log(
        JSON.stringify({
          round: round + 1,
          endpoint: endpoint.name,
          status: result.status ?? result.failure,
          ms: result.totalMs,
        }),
      );
      if (result.status === 429 || timeoutCount >= 2) {
        report.stopReason = "Rate limit or two request deadlines reached";
        break;
      }
      await delay(2000);
    }
    if (report.stopReason) break;
  }
  for (const endpoint of endpoints) {
    const rows = report.samples.filter((s) => s.name === endpoint.name),
      success = rows.filter((s) => s.valid).map((s) => s.totalMs);
    report.summary[endpoint.name] = {
      samples: rows.length,
      successful: success.length,
      failures: rows.length - success.length,
      minMs: success.length ? Math.min(...success) : null,
      p50Ms: percentile(success, 0.5),
      p95Ms: percentile(success, 0.95),
      maxMs: success.length ? Math.max(...success) : null,
    };
  }
  const final = await probe("release after", "/health/release", {}, true);
  assert.equal(final.body?.sha, expectedSha);
  assert.equal(final.body?.environment, "preview");
  report.completed = report.samples.length === 18;
  report.allSampleChecksPassed =
    report.completed && report.samples.every((s) => s.valid);
} catch {
  report.failure =
    "Diagnosis stopped before all checks completed; private response details withheld";
} finally {
  report.fixtureSessionRevoked = false;
  report.sessionCleanup = "No refresh cookie returned; no logout attempted";
  if (cookie && origin && config?.FRONTEND_URL) {
    const logout = await probe(
      "fixture logout",
      "/api/v1/auth/logout",
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: new URL(config.FRONTEND_URL).origin,
        },
      },
      true,
    );
    report.fixtureSessionRevoked = logout.result.status === 200;
    report.sessionCleanup = "Logout attempted; see setup result";
  }
  report.finishedAt = new Date().toISOString();
  await mkdir("reports", { recursive: true });
  const path = join("reports", `hosted-diagnostics-${runId}.json`);
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      completed: report.completed,
      allSampleChecksPassed: report.allSampleChecksPassed,
      summary: report.summary,
      report: path,
    }),
  );
  if (!report.allSampleChecksPassed) process.exitCode = 1;
}
