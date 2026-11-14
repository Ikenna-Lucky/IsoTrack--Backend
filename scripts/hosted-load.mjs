import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { assertPreviewIsolation } from "../src/lib/preview-isolation.ts";
import { runPhase, percentile } from "./load-engine.mjs";

// Deliberately small manual profile. Never accepts an arbitrary deployment URL.
const expectedSha = process.argv[2];
const runId = randomUUID(),
  root = process.cwd();
const report = {
  runId,
  startedAt: new Date().toISOString(),
  passed: false,
  scope:
    "Internet HTTP to isolated Render preview, real Neon and Redis; small existing fixture; no provider traffic or capacity ceiling claim",
  expectedSha,
  profile: [
    { name: "warmup", rate: 0.5, seconds: 10 },
    { name: "steady", rate: 1, seconds: 30 },
    { name: "burst", rate: 2, seconds: 15 },
    { name: "recovery", rate: 1, seconds: 20 },
  ],
  thresholds: {
    readP95Ms: 2000,
    trackingP95Ms: 2000,
    writeOperationP95Ms: 6000,
    loginP95Ms: 3000,
    failed: 0,
    dropped: 0,
    maxInFlight: 4,
    requestDeadlineMs: 10000,
  },
  phases: [],
  failures: [],
  requests: [],
  syntheticShipments: [],
  resources: {
    renderCpuMemory: "Not available to runner; dashboard observation required",
    databaseConnections: [],
  },
};
let config,
  origin,
  client,
  stopped = false,
  stage = "configuration";
const actors = {};
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function request(
  path,
  {
    actor,
    method = "GET",
    body,
    key,
    status = 200,
    timeout = 10000,
    phase = "setup",
  } = {},
) {
  if (stopped) throw new Error("Further traffic stopped");
  const began = performance.now();
  const startedAt = new Date().toISOString();
  const route = path.startsWith("/api/v1/shipments/")
    ? "/api/v1/shipments/:id"
    : path;
  let recorded = false,
    requestId;
  try {
    const response = await fetch(origin + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: {
        ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    requestId = response.headers.get("X-Request-Id");
    const text = await response.text();
    assert(Buffer.byteLength(text) <= 131072);
    const record = {
      phase,
      method,
      route,
      startedAt,
      requestId,
      status: response.status,
      ms: Math.round(performance.now() - began),
      bytes: Buffer.byteLength(text),
    };
    report.requests.push(record);
    recorded = true;
    if (response.status === 429 || response.status >= 500) {
      stopped = true;
      record.retryAfter = response.headers.get("Retry-After");
      throw new Error("Hosted endpoint throttled or unavailable");
    }
    assert.equal(response.status, status);
    return {
      body: JSON.parse(text),
      replayed: response.headers.get("Idempotency-Replayed"),
    };
  } catch (error) {
    if (!recorded) {
      report.requests.push({
        phase,
        method,
        route,
        startedAt,
        requestId,
        status:
          error.name === "TimeoutError" || error.name === "AbortError"
            ? "timeout"
            : "client_error",
        ms: Math.round(performance.now() - began),
      });
    }
    stopped = true;
    throw new Error("Hosted request failed");
  }
}
async function connections(phase) {
  const rows = (
    await client.query(
      "select count(*)::int total,count(*) filter(where state='active')::int active from pg_stat_activity where datname=current_database()",
    )
  ).rows[0];
  report.resources.databaseConnections.push({ phase, ...rows });
}
async function financialHash() {
  return hash(
    (
      await client.query(
        "select coalesce(jsonb_agg(row order by row::text),'[]'::jsonb)::text content from (select to_jsonb(p) row from (select id,shipment_id,provider_reference,provider,stripe_session_id,checkout_state,amount_kobo,status,paid_at,received_at,review_reason,refund_id,refund_recorded_by,refund_recorded_at from payments) p) q",
      )
    ).rows[0].content,
  );
}
try {
  await mkdir(join(root, "reports"), { recursive: true });
  assert(/^[a-f0-9]{40}$/.test(expectedSha ?? ""));
  config = parseEnv(await readFile(join(root, ".env.preview"), "utf8"));
  assertPreviewIsolation({ ...config, RELEASE_SHA: expectedSha });
  origin = new URL(config.APP_URL).origin;
  assert.equal(origin, "https://isotrack-backend-preview.onrender.com");
  assert(config.PREVIEW_FIXTURE_PASSWORD?.length >= 32);
  stage = "release and readiness";
  const release = (await request("/health/release", { timeout: 20000 })).body;
  assert.equal(release.environment, "preview");
  assert.equal(release.sha, expectedSha);
  report.release = release;
  assert.equal(
    (await request("/health/ready", { timeout: 20000 })).body.status,
    "ready",
  );
  stage = "read-only database baseline";
  const dbUrl = new URL(config.DATABASE_URL);
  dbUrl.searchParams.set("sslmode", "verify-full");
  client = new pg.Client({
    connectionString: dbUrl.href,
    connectionTimeoutMillis: 30000,
    statement_timeout: 15000,
    application_name: "isotrack-hosted-load-observer",
  });
  await client.connect();
  await client.query("set default_transaction_read_only=on");
  report.dataset = (
    await client.query(
      "select (select count(*)::int from shipments) shipments,(select count(*)::int from businesses) businesses,(select count(*)::int from users) users",
    )
  ).rows[0];
  const moneyBefore = await financialHash();
  const foreignBefore = (
    await client.query(
      "select to_jsonb(s) content from shipments s where id='preview-foreign-shipment'",
    )
  ).rows[0].content;
  await connections("before");
  stage = "login sample";
  const loginTimes = [];
  for (const name of ["owner", "other", "driver", "customer"]) {
    const began = performance.now();
    const response = await request("/api/v1/auth/login", {
      method: "POST",
      body: {
        email: `preview-${name}@example.invalid`,
        password: config.PREVIEW_FIXTURE_PASSWORD,
      },
      phase: "login",
    });
    assert(response.body.data.accessToken);
    assert.equal(response.body.data.user.id, "preview-" + name);
    actors[name] = { token: response.body.data.accessToken };
    loginTimes.push(performance.now() - began);
  }
  report.login = {
    count: loginTimes.length,
    p95Ms: percentile(loginTimes, 0.95),
    maxMs: Math.max(...loginTimes),
    note: "Four serial samples, exploratory only; no authentication saturation test",
  };
  if (report.login.p95Ms > report.thresholds.loginP95Ms)
    report.failures.push("Login p95 exceeded 3000ms");
  for (const phase of report.profile) {
    if (stopped) break;
    stage = "phase " + phase.name;
    console.log(
      "Starting " + phase.name + " at " + phase.rate + " operations/s",
    );
    const result = await runPhase(
      { ...phase, maxInFlight: 4 },
      async (index) => {
        if (stopped) throw new Error("Further traffic stopped");
        const slot = index % 10;
        if (slot === 0) {
          const key = runId + "-" + phase.name + "-" + index;
          const body = {
            description: "Hosted load " + key,
            weightKg: 1,
            customerId: "preview-customer",
            pickupAddress: {
              street: "Load fixture pickup",
              city: "Lagos",
              state: "Lagos",
            },
            deliveryAddress: {
              street: "Load fixture delivery",
              city: "Lagos",
              state: "Lagos",
            },
            priceKobo: 100,
          };
          const create = {
            actor: actors.owner,
            method: "POST",
            key: key + "-create",
            body,
            status: 201,
            phase: phase.name,
          };
          const created = (await request("/api/v1/shipments", create)).body
            .data;
          report.syntheticShipments.push({
            id: created.id,
            version: created.version,
          });
          const replay = await request("/api/v1/shipments", create);
          assert.equal(replay.replayed, "true");
          assert.equal(replay.body.data.id, created.id);
          const cancel = {
            actor: actors.owner,
            method: "DELETE",
            key: key + "-cancel",
            body: { expectedVersion: created.version },
            phase: phase.name,
          };
          assert.equal(
            (await request("/api/v1/shipments/" + created.id, cancel)).body.data
              .status,
            "cancelled",
          );
          const cancelled = await request(
            "/api/v1/shipments/" + created.id,
            cancel,
          );
          assert.equal(cancelled.replayed, "true");
          assert.equal(cancelled.body.data.status, "cancelled");
          return "write";
        }
        if (slot === 1 || slot === 2) {
          const result = await request("/api/v1/track/IST-PREVIEW-ONLY", {
            phase: phase.name,
          });
          assert(result.body.data);
          assert(!JSON.stringify(result.body).includes("PRIVATE-PREVIEW"));
          return "tracking";
        }
        if (slot === 9) {
          await request("/api/v1/shipments/preview-shipment", {
            actor: actors.other,
            status: 404,
            phase: phase.name,
          });
          return "read-denied";
        }
        const actor = actors[["owner", "driver", "customer"][index % 3]];
        if (slot === 3) {
          const result = await request("/api/v1/shipments/preview-shipment", {
            actor,
            phase: phase.name,
          });
          assert.equal(result.body.data.id, "preview-shipment");
        } else {
          const result = await request("/api/v1/shipments?limit=20", {
            actor,
            phase: phase.name,
          });
          assert(Array.isArray(result.body.data));
          for (const s of result.body.data) {
            assert.equal(s.businessId, "preview-biz");
            if (actor === actors.customer)
              assert.equal(s.customerId, "preview-customer");
            if (actor === actors.driver)
              assert.equal(s.driverId, "preview-driver-profile");
          }
        }
        return "read";
      },
    );
    report.phases.push(result);
    if (
      result.failed ||
      result.dropped ||
      result.completed + result.dropped !== result.offered
    )
      report.failures.push(
        phase.name + ": failures, drops or incomplete arrival accounting",
      );
    for (const [operation, stats] of Object.entries(result.operations)) {
      const limit = operation === "write" ? 6000 : 2000;
      if (operation !== "failed" && stats.p95Ms > limit)
        report.failures.push(
          phase.name + "/" + operation + ": latency target exceeded",
        );
    }
    await connections(phase.name);
    if (stopped || result.failed || result.dropped) break;
    await delay(500);
  }
  stage = "integrity checks";
  assert.equal(await financialHash(), moneyBefore);
  assert.deepEqual(
    (
      await client.query(
        "select to_jsonb(s) content from shipments s where id='preview-foreign-shipment'",
      )
    ).rows[0].content,
    foreignBefore,
  );
  for (const item of report.syntheticShipments) {
    const row = (
      await client.query(
        "select s.status,s.version,(select count(*)::int from shipment_events e where e.shipment_id=s.id) events from shipments s where s.id=$1",
        [item.id],
      )
    ).rows[0];
    assert.equal(row.status, "cancelled");
    assert.equal(row.version, item.version + 1);
    assert.equal(row.events, 2);
  }
  report.integrityPassed = true;
  assert.equal(report.phases.length, report.profile.length);
  const after = (await request("/health/release")).body;
  assert.equal(after.sha, expectedSha);
  assert.equal((await request("/health/ready")).body.status, "ready");
  report.passed = report.failures.length === 0;
} catch {
  report.failedStage = stage;
  report.failures.push("Run stopped at " + stage);
} finally {
  await client?.end().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.httpRequests = report.requests.length;
  await writeFile(
    join(root, "reports", `hosted-load-${runId}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      httpRequests: report.httpRequests,
      phases: report.phases.length,
      failures: report.failures,
      runId,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
