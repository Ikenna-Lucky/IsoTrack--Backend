import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdtemp,
  writeFile,
  copyFile,
  chmod,
  mkdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import IORedis from "ioredis";
import { sql } from "drizzle-orm";
import { postgresFixture } from "./helpers/postgres.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import {
  createOperationalRouter,
  readinessStatement,
} from "../src/observability/health.ts";
import {
  createTelemetry,
  createEventLogger,
  requestTelemetry,
  safeErrorHandler,
} from "../src/observability/telemetry.ts";
import { backlogStatement } from "../src/observability/backlog.ts";

const exec = promisify(execFile);
const docker = (...args) =>
  exec("docker", args, { encoding: "utf8", timeout: 120000 });
const id = randomUUID();
const redisName = `isotrack-monitor-redis-${id}`;
const pg = postgresFixture({ prefix: "monitor" });
const root = fileURLToPath(new URL("../", import.meta.url));
const token = "local-observability-fixture-token-32";
let redis,
  server,
  base,
  active,
  metrics,
  folder,
  dbStopped = false,
  redisStarted = false;
const containers = [];
let network;
const received = [],
  logs = [];
const query = (text) => pg.query(sql.raw(text));
const store = {
  execute: async (statement) =>
    JSON.parse(
      await pg.query(
        sql`select coalesce(json_agg(r),'[]') from (${statement}) r`,
      ),
    ),
  transaction: async (statements) =>
    pg.query(
      sql.join(
        [sql.raw("begin"), ...statements, sql.raw("commit")],
        sql.raw(";"),
      ),
    ),
};
async function until(check, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > end) throw new Error("Fixture condition deadline");
    await delay(250);
  }
}
async function containerDiagnostic(name) {
  const inspect = await docker("inspect", "--format", "{{json .State}}", name)
    .then((result) => JSON.parse(result.stdout))
    .catch(() => ({ unavailable: true }));
  const output = await docker("logs", "--tail", "80", name)
    .then((result) => `${result.stdout}${result.stderr}`)
    .catch(() => "Container logs unavailable");
  const diagnostic = {
    name,
    state: inspect,
    logs: output.replaceAll(token, "[redacted]"),
  };
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(
    join(
      root,
      `reports/monitoring-${name.includes("-am-") ? "alertmanager" : "prometheus"}-diagnostic.json`,
    ),
    JSON.stringify(diagnostic, null, 2) + "\n",
  );
  return diagnostic;
}
async function readyContainerPort(name, internalPort) {
  try {
    const port = Number(
      (await docker("port", name, `${internalPort}/tcp`)).stdout
        .trim()
        .split(":")
        .at(-1),
    );
    assert.ok(
      Number.isInteger(port) && port > 0,
      "Missing published fixture port",
    );
    await until(async () => {
      const state = JSON.parse(
        (await docker("inspect", "--format", "{{json .State}}", name)).stdout,
      );
      if (!state.Running)
        throw new Error(`${name} exited with code ${state.ExitCode}`);
      return fetch(`http://127.0.0.1:${port}/-/ready`, {
        signal: AbortSignal.timeout(1000),
      })
        .then((response) => response.ok)
        .catch(() => false);
    });
    return port;
  } catch (error) {
    const diagnostic = await containerDiagnostic(name);
    throw new Error(
      `Monitoring container startup failed: ${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
}
function app(options = {}) {
  metrics = createTelemetry();
  const result = new Hono();
  result.use(
    "*",
    requestTelemetry(
      metrics,
      createEventLogger((line) => logs.push(line)),
    ),
  );
  result.onError(
    safeErrorHandler(createEventLogger((line) => logs.push(line))),
  );
  result.route(
    "/",
    createOperationalRouter({
      metrics,
      token,
      draining: () => false,
      timeoutMs: 10000,
      cacheMs: 0,
      database: () => query(readinessStatement),
      redis: () => redis.ping(),
      backlog: async () => {
        const output = await pg.query(backlogStatement());
        return output.split("\n").map((line) => {
          const row = JSON.parse(line);
          return { ...row, age: Number(row.age) };
        });
      },
      ...options,
    }),
  );
  return result;
}
const scrape = () =>
  fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${token}` } });
before(async () => {
  await pg.start();
  await runMigrations(store, join(root, "drizzle"));
  await query(`insert into users(id,email,password_hash,name,role) values('monitor-owner','monitor@example.test','hash','Monitor','business');
    insert into businesses(id,user_id,business_name) values('monitor-biz','monitor-owner','Monitor');
    insert into shipments(id,tracking_id,business_id,description,weight_kg,pickup_address,delivery_address,price_kobo)
    values('monitor-shipment','IST-MONITOR','monitor-biz','Fixture',1,'{}','{}',100);`);
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
  const port = Number(
    (await docker("port", redisName, "6379/tcp")).stdout
      .trim()
      .split(":")
      .at(-1),
  );
  redis = new IORedis({
    host: "127.0.0.1",
    port,
    commandTimeout: 1000,
    maxRetriesPerRequest: 0,
  });
  redis.on("error", () => {});
  await until(async () => {
    try {
      return (await redis.ping()) === "PONG";
    } catch {
      return false;
    }
  });
  const wrapper = new Hono();
  wrapper.post("/receiver", async (c) => {
    received.push(await c.req.json());
    return c.text("OK");
  });
  wrapper.all("*", (c) => active.fetch(c.req.raw));
  server = serve({ fetch: wrapper.fetch, hostname: "0.0.0.0", port: 0 });
  if (!server.listening) await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  folder = await mkdtemp(join(tmpdir(), "isotrack-monitor-"));
  // mkdtemp uses 0700 on Linux. The images' non-root users must traverse
  // this synthetic-config directory through the read-only bind mount.
  await chmod(folder, 0o755);
});
beforeEach(async () => {
  await query("truncate payments,notification_outbox,account_actions cascade");
  logs.length = 0;
  active = app();
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  redis?.disconnect();
  for (const name of containers.reverse()) await docker("rm", "--force", name);
  if (network) await docker("network", "rm", network);
  if (redisStarted) await docker("stop", "--time", "1", redisName);
  if (!dbStopped) await pg.stop();
  if (folder) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("isotrack-monitor-")
    )
      throw new Error("Unsafe fixture cleanup");
    await rm(folder, { recursive: true, force: true });
  }
});

test("real HTTP readiness checks actual migrated PostgreSQL and Redis; metrics require the dedicated token", async () => {
  assert.equal((await fetch(`${base}/health/ready`)).status, 200);
  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  const result = await scrape();
  assert.equal(result.status, 200);
  const text = await result.text();
  assert.match(text, /isotrack_dependency_ready\{dependency="database"\} 1/);
  assert.match(text, /isotrack_dependency_ready\{dependency="redis"\} 1/);
  assert.ok(!logs.join("").includes(token));
  assert.ok(!text.includes("monitor@example.test"));
});

test("schema failure removes readiness without killing liveness or exposing SQL details", async () => {
  await query(
    "alter table payments rename checkout_state to unavailable_checkout_state",
  );
  try {
    const response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready" });
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
  } finally {
    await query(
      "alter table payments rename unavailable_checkout_state to checkout_state",
    );
  }
  active = app();
  assert.equal((await fetch(`${base}/health/ready`)).status, 200);
});

test("backlog metrics read durable delayed work, dead letters, expired leases and unresolved money", async () => {
  await query(`insert into notification_outbox(id,shipment_id,recipient_id,channel,kind,payload,state,available_at,lease_token,lease_until) values
    ('due','monitor-shipment','monitor-owner','in_app','shipment_status','{}','pending',now()-interval '20 minutes',null,null),
    ('dead','monitor-shipment','monitor-owner','email','shipment_status','{}','dead',now()-interval '20 minutes',null,null),
    ('leased','monitor-shipment','monitor-owner','email','shipment_status','{}','processing',now()-interval '20 minutes','old',now()-interval '10 minutes');
    insert into account_actions(id,user_id,purpose,email,credential_version,expires_at,delivery_state,available_at,lease_token,lease_until) values
    ('due-account','monitor-owner','password_changed','monitor@example.test',0,now()+interval '1 hour','pending',now()-interval '20 minutes',null,null),
    ('dead-account','monitor-owner','password_changed','monitor@example.test',0,now()+interval '1 hour','dead',now()-interval '20 minutes',null,null),
    ('lease-account','monitor-owner','password_changed','monitor@example.test',0,now()+interval '1 hour','processing',now()-interval '20 minutes','old',now()-interval '10 minutes');
    insert into payments(id,shipment_id,provider_reference,amount_kobo,reconcile_after,checkout_state,review_reason,received_at) values
    ('pending','monitor-shipment','MONITOR-PENDING',100,now()-interval '20 minutes','creating',null,null),
    ('review','monitor-shipment','MONITOR-REVIEW',100,now(),'review','additional_payment',now()-interval '20 minutes');`);
  const text = await (await scrape()).text();
  for (const queue of [
    "notifications",
    "notification_dead",
    "notification_leases",
    "account_emails",
    "account_email_dead",
    "account_email_leases",
    "payments",
    "payment_reviews",
  ])
    assert.match(
      text,
      new RegExp(`isotrack_backlog_present\\{queue="${queue}"\\} 1`),
    );
  const rows = (await metrics.snapshots.get()).values;
  assert.ok(
    rows
      .filter(
        (row) =>
          !row.labels.queue.startsWith("delivery_") &&
          row.labels.queue !== "held_packages" &&
          row.labels.queue !== "retention",
      )
      .every((row) => row.value >= 590),
  );
  await query("truncate payments,notification_outbox,account_actions cascade");
  active = app();
  await scrape();
  assert.ok(
    (await metrics.present.get()).values
      .filter((row) => row.labels.queue !== "retention")
      .every((row) => row.value === 0),
  );
  assert.equal(
    (await metrics.present.get()).values.find(
      (row) => row.labels.queue === "retention",
    ).value,
    1,
  );
});

test("Prometheus validates production rules and evaluates held, firing and recovered alerts", async () => {
  await copyFile(
    join(root, "monitoring/alerts.yml"),
    join(folder, "alerts.yml"),
  );
  await copyFile(
    join(root, "tests/fixtures/alerts.test.yml"),
    join(folder, "rules-test.yml"),
  );
  await chmod(join(folder, "alerts.yml"), 0o644);
  await chmod(join(folder, "rules-test.yml"), 0o644);
  const result = await docker(
    "run",
    "--rm",
    "--mount",
    `type=bind,source=${folder},target=/config,readonly`,
    "--workdir",
    "/config",
    "--entrypoint",
    "/bin/promtool",
    "quay.io/prometheus/prometheus:v3.13.5",
    "test",
    "rules",
    "rules-test.yml",
  );
  assert.match(result.stdout, /SUCCESS/);
});

test("real Prometheus scrapes SQL-backed review metrics and Alertmanager delivers and acknowledges a local alert", async () => {
  await query(`insert into payments(id,shipment_id,provider_reference,amount_kobo,checkout_state,review_reason,received_at)
    values('alert-review','monitor-shipment','MONITOR-ALERT',100,'review','additional_payment',now()-interval '20 minutes')`);
  const port = server.address().port;
  network = `isotrack-monitor-${id}`;
  await docker("network", "create", network);
  await writeFile(
    join(folder, "alertmanager.yml"),
    `route:\n  receiver: local\n  group_by: [alertname]\n  group_wait: 1s\n  group_interval: 1s\n  repeat_interval: 1h\nreceivers:\n  - name: local\n    webhook_configs:\n      - url: http://host.docker.internal:${port}/receiver\n        send_resolved: true\n`,
  );
  const am = `isotrack-monitor-am-${id}`;
  await chmod(join(folder, "alertmanager.yml"), 0o644);
  containers.push(am);
  await docker(
    "run",
    "--detach",
    "--name",
    am,
    "--network",
    network,
    "--network-alias",
    "alertmanager",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    "127.0.0.1::9093",
    "--mount",
    `type=bind,source=${folder},target=/config,readonly`,
    "quay.io/prometheus/alertmanager:v0.34.2",
    "--config.file=/config/alertmanager.yml",
  );
  const amPort = await readyContainerPort(am, 9093);
  await writeFile(
    join(folder, "prometheus.yml"),
    // Match the production scrape cadence. A 1s scrape also imposed a 1s
    // deadline on the Docker/psql adapter during parallel integration work.
    `global:\n  scrape_interval: 15s\n  scrape_timeout: 10s\n  evaluation_interval: 1s\nrule_files: [/config/alerts.yml]\nalerting:\n  alertmanagers:\n    - static_configs:\n        - targets: [alertmanager:9093]\nscrape_configs:\n  - job_name: isotrack\n    metrics_path: /metrics\n    authorization:\n      type: Bearer\n      credentials: ${token}\n    static_configs:\n      - targets: [host.docker.internal:${port}]\n`,
  );
  const prom = `isotrack-monitor-prom-${id}`;
  await chmod(join(folder, "prometheus.yml"), 0o644);
  containers.push(prom);
  await docker(
    "run",
    "--detach",
    "--name",
    prom,
    "--network",
    network,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    "127.0.0.1::9090",
    "--mount",
    `type=bind,source=${folder},target=/config,readonly`,
    "quay.io/prometheus/prometheus:v3.13.5",
    "--config.file=/config/prometheus.yml",
  );
  const promPort = await readyContainerPort(prom, 9090);
  try {
    await until(
      () =>
        received.find(
          (event) =>
            event.status === "firing" &&
            event.alerts.some(
              (a) => a.labels.alertname === "IsoTrackPaymentReview",
            ),
        ),
      120000,
    );
  } catch (error) {
    await containerDiagnostic(am);
    await containerDiagnostic(prom);
    const response = await fetch(
      `http://127.0.0.1:${promPort}/api/v1/targets`,
      { signal: AbortSignal.timeout(3000) },
    );
    const targets = await response.json();
    await writeFile(
      join(root, "reports/monitoring-alert-diagnostic.json"),
      JSON.stringify(
        {
          scope: "local fixture alert deadline",
          received: received.length,
          targets: targets.data?.activeTargets?.map((t) => ({
            health: t.health,
            lastError: t.lastError,
            lastScrapeDuration: t.lastScrapeDuration,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    throw error;
  }
  assert.ok(!JSON.stringify(received).includes(token));
  assert.ok(!JSON.stringify(received).includes("MONITOR-ALERT"));
  const silence = await fetch(`http://127.0.0.1:${amPort}/api/v2/silences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      matchers: [
        { name: "alertname", value: "IsoTrackPaymentReview", isRegex: false },
      ],
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 60000).toISOString(),
      createdBy: "local-fixture",
      comment: "Acknowledged synthetic drill",
    }),
  });
  assert.equal(silence.status, 200);
  assert.ok((await silence.json()).silenceID);
});

test("actual database container loss fails readiness and retains a live process", async () => {
  await pg.stop();
  dbStopped = true;
  assert.equal((await fetch(`${base}/health/ready`)).status, 503);
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  assert.equal((await scrape()).status, 200);
  assert.equal((await metrics.snapshotTime.get()).values[0].value, 0);
});
