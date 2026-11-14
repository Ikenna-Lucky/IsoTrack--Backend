import assert from "node:assert/strict";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { parseEnv, promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import pg from "pg";

const root = process.cwd(),
  runId = randomUUID();
const execute = promisify(execFile);
const report = {
  runId,
  startedAt: new Date().toISOString(),
  scope:
    "Local full Bun application over real hosted Neon recovery database and disposable Redis; no deployment or external providers",
  passed: false,
  cases: [],
};
const reportPath = join(root, "reports", `recovery-smoke-${runId}.json`);
const redisName = `isotrack-recovery-smoke-${runId}`;
let client,
  child,
  redisStarted = false,
  base,
  appEnv,
  blockedHttp = 0;
const normalize = (host) => host.toLowerCase().replace("-pooler.", ".");
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function docker(...args) {
  return execute("docker", args, { timeout: 60000, windowsHide: true });
}
async function check(name, fn) {
  const start = performance.now();
  try {
    await fn();
    report.cases.push({
      name,
      passed: true,
      ms: Math.round(performance.now() - start),
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.cases.push({
      name,
      passed: false,
      ms: Math.round(performance.now() - start),
      ...(Number.isInteger(error.actual)
        ? { actual: error.actual, expected: error.expected }
        : {}),
    });
    throw new Error("Recovery smoke check failed");
  }
}
async function request(
  path,
  { actor, method = "GET", body, key, cookie } = {},
) {
  return fetch(base + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(45000),
    headers: {
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
      ...(cookie ? { Cookie: cookie, Origin: "https://recovery.invalid" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function data(response, status = 200) {
  assert.equal(response.status, status);
  return (await response.json()).data;
}
async function stopApp() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([stopped, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await stopped;
    }
  }
}
async function startApp() {
  child = spawn(
    process.env.BUN_EXECUTABLE ?? "bun",
    ["--no-env-file", "run", "scripts/recovery-smoke-server.mjs"],
    {
      cwd: root,
      env: appEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Recovery app startup timeout")),
      30000,
    );
    let pending = "";
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Bun unavailable"));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Recovery app exited"));
    });
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const match = /^RECOVERY_LISTENING:(\d+)$/.exec(line);
        if (match) {
          base = `http://127.0.0.1:${match[1]}`;
          clearTimeout(timer);
          resolve();
        }
        if (line === "RECOVERY_BLOCKED_HTTP") blockedHttp++;
      }
    });
    child.stderr.on("data", () => {}); // Never copy response bodies, hashes or credentials.
  });
}
const actors = {};
let shipment, baselineMoney, baselineOutbox;
async function moneySnapshot() {
  const result = {};
  for (const table of [
    "payments",
    "shipment_payment_receipts",
    "payment_checkout_guards",
  ]) {
    const rows = (
      await client.query(
        `select coalesce(jsonb_agg(row order by row::text),'[]'::jsonb)::text content from (select to_jsonb(t) row from ${table} t) records`,
      )
    ).rows[0];
    result[table] = sha(rows.content);
  }
  return result;
}
try {
  await mkdir(join(root, "reports"), { recursive: true });
  const config = parseEnv(
    await readFile(join(root, ".env.recovery-hosted"), "utf8"),
  );
  const preview = parseEnv(await readFile(join(root, ".env.preview"), "utf8"));
  const source = new URL(config.RECOVERY_SOURCE_DATABASE_URL),
    target = new URL(config.RECOVERY_TARGET_DATABASE_URL),
    expected = new URL(preview.DATABASE_URL);
  await check(
    "recovery destination and restored financial baseline",
    async () => {
      assert.equal(target.pathname, "/isotrack_recovery");
      assert(
        target.hostname.endsWith(".neon.tech") &&
          !target.hostname.includes("-pooler."),
      );
      assert(
        ["require", "verify-full"].includes(target.searchParams.get("sslmode")),
      );
      assert(preview.LIVE_DATABASE_HOST);
      assert.notEqual(
        normalize(target.hostname),
        normalize(preview.LIVE_DATABASE_HOST),
      );
      assert.notEqual(normalize(target.hostname), normalize(source.hostname));
      assert.equal(normalize(source.hostname), normalize(expected.hostname));
      assert.equal(source.pathname, expected.pathname);
      const reports = [];
      for (const name of await readdir(join(root, "reports"))) {
        if (/^hosted-recovery-[a-f0-9-]+\.json$/.test(name)) {
          const r = JSON.parse(
            await readFile(join(root, "reports", name), "utf8"),
          );
          if (r.passed && r.status === "hosted_snapshot_restore_verified")
            reports.push(r);
        }
      }
      reports.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
      assert(reports.length);
      const recovery = reports[0];
      report.restoreRunId = recovery.originalRunId ?? recovery.runId;
      report.archiveSha256 = recovery.archiveSha256;
      const tls = new URL(target);
      tls.searchParams.set("sslmode", "verify-full");
      client = new pg.Client({
        connectionString: tls.href,
        connectionTimeoutMillis: 30000,
        statement_timeout: 30000,
      });
      await client.connect();
      baselineMoney = await moneySnapshot();
      for (const [table, value] of Object.entries(baselineMoney))
        assert.equal(value, recovery.tables[`public.${table}`].sha256);
      const fixtures = (
        await client.query(
          "select id from users where id in ('preview-owner','preview-other','preview-driver','preview-customer') and is_active",
        )
      ).rows;
      assert.equal(fixtures.length, 4);
      baselineOutbox = (
        await client.query(
          "select count(*)::int n from notification_outbox where state<>'pending' or attempts<>0",
        )
      ).rows[0].n;
      report.runtimeCodeSha256 = sha(
        await readFile(join(root, "src/index.ts")),
      );
    },
  );
  await check("isolated Redis and full Bun app readiness", async () => {
    await docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      redisName,
      "-p",
      "127.0.0.1::6379",
      "redis:7-alpine",
    );
    redisStarted = true;
    const { stdout } = await docker("port", redisName, "6379/tcp");
    const port = Number(stdout.trim().split(":").at(-1));
    assert(Number.isInteger(port));
    appEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      NODE_ENV: "production",
      DEPLOYMENT_ENV: "preview",
      PORT: "0",
      RELEASE_SHA: "b".repeat(40),
      NOTIFICATION_WORKERS_ENABLED: "false",
      RETENTION_ENABLED: "false",
      STRIPE_MODE: "disabled",
      DATABASE_URL: target.href,
      PREVIEW_DATABASE_HOST: target.hostname,
      LIVE_DATABASE_HOST: preview.LIVE_DATABASE_HOST,
      UPSTASH_REDIS_URL: `redis://127.0.0.1:${port}`,
      PREVIEW_REDIS_HOST: "127.0.0.1",
      LIVE_REDIS_HOST: "live.recovery.invalid",
      APP_URL: "https://recovery.invalid",
      FRONTEND_URL: "https://recovery.invalid",
      PREVIEW_APP_HOST: "recovery.invalid",
      LIVE_APP_HOST: "live.recovery.invalid",
      JWT_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
    };
    await startApp();
    assert.equal((await request("/health/live")).status, 200);
    let ready = false;
    for (let i = 0; i < 6; i++) {
      if ((await request("/health/ready")).status === 200) {
        ready = true;
        break;
      }
      await delay(6000);
    }
    assert(ready);
  });
  await check(
    "restored account logins and invalid-password denial",
    async () => {
      for (const id of [
        "preview-owner",
        "preview-other",
        "preview-driver",
        "preview-customer",
      ]) {
        const response = await request("/api/v1/auth/login", {
          method: "POST",
          body: {
            email: id + "@example.invalid",
            password: preview.PREVIEW_FIXTURE_PASSWORD,
          },
        });
        const cookie = response.headers.get("set-cookie")?.split(";")[0];
        const result = await data(response);
        assert.equal(result.user.id, id);
        assert(result.accessToken && cookie);
        actors[id] = { token: result.accessToken, cookie };
      }
      assert.equal(
        (
          await request("/api/v1/auth/login", {
            method: "POST",
            body: {
              email: "preview-owner@example.invalid",
              password: "IncorrectRecoveryPassword123!",
            },
          })
        ).status,
        401,
      );
      assert.equal(
        (await request("/api/v1/shipments/preview-shipment")).status,
        401,
      );
    },
  );
  await check(
    "restored shipment access and cross-business denial",
    async () => {
      const before = (
        await client.query(
          "select to_jsonb(s) content from shipments s where id='preview-shipment'",
        )
      ).rows[0].content;
      for (const id of [
        "preview-owner",
        "preview-driver",
        "preview-customer",
      ]) {
        const s = await data(
          await request("/api/v1/shipments/preview-shipment", {
            actor: actors[id],
          }),
        );
        assert.equal(s.id, "preview-shipment");
      }
      const other = actors["preview-other"];
      assert.equal(
        (await request("/api/v1/shipments/preview-shipment", { actor: other }))
          .status,
        404,
      );
      assert.equal(
        (
          await request("/api/v1/shipments/preview-shipment", {
            actor: other,
            method: "DELETE",
            key: runId + "-foreign",
            body: { expectedVersion: before.version },
          })
        ).status,
        404,
      );
      assert.deepEqual(
        (
          await client.query(
            "select to_jsonb(s) content from shipments s where id='preview-shipment'",
          )
        ).rows[0].content,
        before,
      );
    },
  );
  await check(
    "restored receipt and refund projections without Stripe calls",
    async () => {
      const rows = (
        await client.query(
          "select p.shipment_id,p.status,p.amount_kobo from payments p where p.status in ('success','refunded') order by p.id",
        )
      ).rows;
      assert(
        rows.some((r) => r.status === "refunded") &&
          rows.some((r) => r.status === "success"),
      );
      for (const row of rows) {
        const s = await data(
          await request(
            "/api/v1/shipments/" + encodeURIComponent(row.shipment_id),
            { actor: actors["preview-owner"] },
          ),
        );
        assert.equal(s.payment.status, row.status);
        assert.equal(s.payment.amountKobo, row.amount_kobo);
        if (row.status === "refunded") assert.equal(s.isPaid, false);
      }
      assert.deepEqual(await moneySnapshot(), baselineMoney);
    },
  );
  await check(
    "new shipment writes, cancellation and idempotent replay",
    async () => {
      const actor = actors["preview-owner"],
        key = runId + "-create",
        body = {
          description: "Recovery HTTP smoke " + runId,
          weightKg: 1,
          customerId: "preview-customer",
          pickupAddress: {
            street: "Recovery pickup",
            city: "Lagos",
            state: "Lagos",
          },
          deliveryAddress: {
            street: "Recovery delivery",
            city: "Lagos",
            state: "Lagos",
          },
          priceKobo: 100,
        };
      shipment = await data(
        await request("/api/v1/shipments", {
          actor,
          method: "POST",
          key,
          body,
        }),
        201,
      );
      const replay = await request("/api/v1/shipments", {
        actor,
        method: "POST",
        key,
        body,
      });
      assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
      assert.equal((await data(replay, 201)).id, shipment.id);
      const cancel = {
        actor,
        method: "DELETE",
        key: runId + "-cancel",
        body: { expectedVersion: shipment.version },
      };
      assert.equal(
        (await data(await request("/api/v1/shipments/" + shipment.id, cancel)))
          .status,
        "cancelled",
      );
      const repeated = await request(
        "/api/v1/shipments/" + shipment.id,
        cancel,
      );
      assert.equal(repeated.headers.get("Idempotency-Replayed"), "true");
      assert.equal((await data(repeated)).status, "cancelled");
      const persisted = (
        await client.query(
          "select s.status,s.version,(select count(*)::int from shipment_events where shipment_id=s.id) events from shipments s where s.id=$1",
          [shipment.id],
        )
      ).rows[0];
      assert.equal(persisted.status, "cancelled");
      assert.equal(persisted.version, shipment.version + 1);
      assert.equal(persisted.events, 2);
      report.syntheticShipmentId = shipment.id;
    },
  );
  await check(
    "restart persistence, session revocation and side-effect isolation",
    async () => {
      await stopApp();
      await startApp();
      const actor = actors["preview-owner"];
      let response;
      report.restartReadStatuses = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        response = await request("/api/v1/shipments/" + shipment.id, { actor });
        report.restartReadStatuses.push(response.status);
        if (response.status !== 503) break;
        await response.arrayBuffer();
        await delay(500);
      }
      const saved = await data(response);
      assert.equal(saved.status, "cancelled");
      assert.equal(
        (
          await request("/api/v1/auth/logout", {
            method: "POST",
            cookie: actor.cookie,
          })
        ).status,
        200,
      );
      assert.equal(
        (await request("/api/v1/shipments/" + shipment.id, { actor })).status,
        401,
      );
      assert.deepEqual(await moneySnapshot(), baselineMoney);
      assert.equal(
        (
          await client.query(
            "select count(*)::int n from notification_outbox where state<>'pending' or attempts<>0",
          )
        ).rows[0].n,
        baselineOutbox,
      );
      assert.equal(blockedHttp, 0);
      report.externalHttpAttemptsBlocked = blockedHttp;
    },
  );
  report.passed = true;
} catch {
  process.exitCode = 1;
} finally {
  let cleanup = true;
  try {
    await stopApp();
  } catch {
    cleanup = false;
  }
  try {
    await client?.end();
  } catch {
    cleanup = false;
  }
  if (redisStarted)
    try {
      await docker("stop", "--time", "1", redisName);
    } catch {
      cleanup = false;
    }
  report.cleanupPassed = cleanup;
  if (!cleanup) {
    report.passed = false;
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      passed: report.passed,
      passedCases: report.cases.filter((c) => c.passed).length,
      failedCases: report.cases.filter((c) => !c.passed).length,
      cleanupPassed: cleanup,
      report: reportPath,
    }),
  );
}
