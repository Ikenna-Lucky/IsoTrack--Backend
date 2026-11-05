import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { cpus, totalmem } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serve } from "@hono/node-server";
import { SignJWT } from "jose";
import { runMigrations } from "../src/db/migration-runner.ts";
import { createShipmentListRouter } from "../src/routes/shipment-list.ts";
import { createShipmentCommandRouter } from "../src/routes/shipment-commands.ts";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.ts";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { activeSessionStatement } from "../src/db/queries/session-statements.ts";
import { shipmentPageStatement } from "../src/db/queries/shipment-page.ts";
import { parseShipmentPage } from "../src/lib/shipment-page.ts";
import { runPhase, phaseFailures } from "./load-engine.mjs";

// No target URL, application environment or existing database is accepted.
const profile = process.argv[2] ?? "baseline";
if (process.argv.length > 3 || !["baseline", "smoke"].includes(profile))
  throw new Error(
    "Expected baseline or smoke; arbitrary targets are not supported",
  );
const phases =
  profile === "baseline"
    ? [
        { name: "warmup", rate: 10, seconds: 5 },
        { name: "steady", rate: 20, seconds: 30 },
        { name: "burst", rate: 100, seconds: 15 },
        { name: "recovery", rate: 20, seconds: 15 },
      ]
    : [{ name: "smoke", rate: 10, seconds: 5 }];
const id = randomUUID();
const container = `isotrack-load-${id}`;
const password = randomUUID();
const secret = new TextEncoder().encode(randomUUID() + randomUUID());
const exec = promisify(execFile);
const docker = (...args) =>
  exec("docker", args, { encoding: "utf8", timeout: 60000 });
const dialect = new PgDialect();
const loop = monitorEventLoopDelay({ resolution: 20 });
const report = {
  profile,
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  commit: process.env.GITHUB_SHA ?? null,
  cpus: cpus().length,
  hostMemoryBytes: totalmem(),
  scope:
    "Loopback Node/Hono production routers and JWT/session middleware; real PostgreSQL TCP. Not full app, Bun, Neon, workers or provider capacity.",
  dataset: { tenants: 10, readShipments: 50000, writeShipments: 5000 },
  database: {
    image: "postgres:17-alpine",
    cpus: 2,
    memory: "512m",
    poolMax: 16,
  },
  thresholds: {
    normalReadP95Ms: 500,
    normalAssignReplayP95Ms: 1000,
    burstReadP95Ms: 1500,
    burstAssignReplayP95Ms: 2500,
    failed: 0,
    dropped: 0,
  },
  phases: [],
  failures: [],
  passed: false,
};
let pool,
  server,
  started = false,
  sampler;
let assignment = 0,
  httpRequests = 0,
  peakPoolWaiting = 0,
  peakRssBytes = 0;
let base;
const execute = async (statement) => {
  const compiled = dialect.sqlToQuery(statement);
  const result = await pool.query(compiled.sql, compiled.params);
  return result.rows.map((row) => row.result ?? row);
};
try {
  await mkdir(new URL("../reports/", import.meta.url), { recursive: true });
  await docker(
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--cpus",
    "2",
    "--memory",
    "512m",
    "-p",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "postgres:17-alpine",
  );
  started = true;
  const port = Number(
    (await docker("port", container, "5432/tcp")).stdout
      .trim()
      .split(":")
      .at(-1),
  );
  assert.ok(Number.isInteger(port) && port > 0);
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await docker(
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
      );
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await delay(100);
    }
  }
  pool = new pg.Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password,
    database: "postgres",
    max: 16,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  pool.on("error", (error) =>
    report.failures.push(
      `Idle PostgreSQL connection: ${error.code ?? "error"}`,
    ),
  );
  await runMigrations(
    {
      execute,
      transaction: async (statements) => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          for (const statement of statements) {
            const compiled = dialect.sqlToQuery(statement);
            await client.query(compiled.sql, compiled.params);
          }
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      },
    },
    fileURLToPath(new URL("../drizzle", import.meta.url)),
  );
  // Bulk fixture creation is outside the timed workload; restore request limits
  // before serving traffic. New pooled connections also default to five seconds.
  await pool.query(`set statement_timeout='90s';
    insert into users(id,email,password_hash,name,role)
      select role||'-'||n,role||n||'@example.test','synthetic-hash',role||n,role::user_role
      from generate_series(0,9) n cross join unnest(array['business','driver','customer']) role;
    insert into businesses(id,user_id,business_name) select 'biz-'||n,'business-'||n,'Load business '||n from generate_series(0,9) n;
    insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate)
      select 'driver-profile-'||n,'driver-'||n,'biz-'||n,'bike','LOAD-'||n from generate_series(0,9) n;
    insert into auth_sessions(id,user_id,credential_version,expires_at)
      select 'session-'||id,id,0,now()+interval '1 hour' from users;
    insert into shipments(id,tracking_id,business_id,driver_id,customer_id,status,description,weight_kg,pickup_address,delivery_address,price_kobo,created_at)
      select 'load-read-'||n,'LOAD-R-'||n,'biz-'||(n%10),'driver-profile-'||(n%10),'customer-'||(n%10),
      'assigned','Synthetic shipment '||n,1,'{"city":"Lagos"}','{"city":"Abuja"}',10000,
      now()-(n%720)*interval '1 hour' from generate_series(1,50000) n;
    insert into shipments(id,tracking_id,business_id,description,weight_kg,pickup_address,delivery_address,price_kobo)
      select 'load-write-'||n,'LOAD-W-'||n,'biz-'||(n%10),'Write fixture',1,'{}','{}',10000 from generate_series(1,5000) n;
    insert into shipment_events(id,shipment_id,status,message,created_at)
      select 'load-event-'||n,'load-read-'||n,'assigned','Synthetic history',now()-interval '1 hour' from generate_series(1,50000) n;
    analyze; set statement_timeout='5s';`);
  const tokens = new Map();
  for (let tenant = 0; tenant < 10; tenant++)
    for (const role of ["business", "driver", "customer"]) {
      const user = `${role}-${tenant}`;
      tokens.set(
        user,
        await new SignJWT({ type: "access", role, sid: `session-${user}` })
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(user)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(secret),
      );
    }
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : c.json({ error: "SERVER_FAILURE" }, 500),
  );
  app.use(
    "*",
    createAuthenticationMiddleware({
      verifyToken: (token) => verifySessionToken(token, secret, "access"),
      findUser: async (user) =>
        (
          await pool.query(
            'select id,role,is_active as "isActive" from users where id=$1',
            [user],
          )
        ).rows[0],
      isSessionActive: async (sid, user) =>
        (await execute(activeSessionStatement(sid, user))).length > 0,
    }),
  );
  app.route("/shipments", createShipmentListRouter({ execute }));
  app.route("/shipments", createShipmentCommandRouter({ execute }));
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, user, body, key) {
    httpRequests++;
    const response = await fetch(`${base}${path}`, {
      method: body ? "PATCH" : "GET",
      headers: {
        Authorization: `Bearer ${tokens.get(user)}`,
        ...(body
          ? { "Content-Type": "application/json", "Idempotency-Key": key }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: response.status,
      body: await response.json(),
      replayed: response.headers.get("Idempotency-Replayed"),
    };
  }
  // Seed cursor positions outside the timed workload, then exercise first and deep pages.
  const cursors = new Map();
  for (const role of ["business", "driver", "customer"])
    for (let tenant = 0; tenant < 10; tenant++) {
      const user = `${role}-${tenant}`;
      let cursor;
      for (let page = 0; page < 5; page++) {
        const result = await request(
          `/shipments?limit=20${cursor ? `&cursor=${cursor}` : ""}`,
          user,
        );
        assert.equal(result.status, 200);
        assert.equal(result.body.data.length, 20);
        cursor = result.body.pagination.nextCursor;
      }
      cursors.set(user, cursor);
    }
  report.queryPlans = {};
  for (const role of ["business", "driver", "customer"]) {
    const actor = { userId: `${role}-0`, role };
    const params = new URLSearchParams({
      limit: "20",
      cursor: cursors.get(actor.userId),
    });
    const compiled = dialect.sqlToQuery(
      shipmentPageStatement(actor, parseShipmentPage(params, actor)),
    );
    const plan = (
      await pool.query(
        `explain (analyze, buffers, format json) ${compiled.sql}`,
        compiled.params,
      )
    ).rows[0]["QUERY PLAN"][0];
    report.queryPlans[role] = plan;
  }
  httpRequests = 0;
  loop.enable();
  const cpuStart = process.cpuUsage();
  sampler = setInterval(() => {
    peakPoolWaiting = Math.max(peakPoolWaiting, pool.waitingCount);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 100);
  let sequence = 0;
  for (const phase of phases) {
    console.log(
      `Load phase ${phase.name}: ${phase.rate} operations/s for ${phase.seconds}s`,
    );
    const result = await runPhase({ ...phase, maxInFlight: 64 }, async () => {
      const current = sequence++,
        tenant = Math.floor(current / 10) % 10;
      if (current % 10 < 7) {
        const role = ["business", "driver", "customer"][
          Math.floor(current / 100) % 3
        ];
        const user = `${role}-${tenant}`;
        const cursor = Math.floor(current / 30) % 2 ? cursors.get(user) : null;
        const response = await request(
          `/shipments?limit=20${cursor ? `&cursor=${cursor}` : ""}`,
          user,
        );
        assert.equal(response.status, 200, `read-${role} status`);
        assert.equal(response.body.data.length, 20);
        assert.ok(
          response.body.data.every((row) => row.businessId === `biz-${tenant}`),
          "Tenant data leaked",
        );
        assert.ok(
          response.body.data.every(
            (row) => role !== "customer" || row.customerId === user,
          ),
        );
        assert.ok(
          response.body.data.every(
            (row) =>
              role !== "driver" || row.driverId === `driver-profile-${tenant}`,
          ),
        );
        return `read-${role}`;
      }
      if (current % 10 < 9) {
        const number = ++assignment,
          owner = number % 10;
        assert.ok(number <= 5000, "Write fixture exhausted");
        const body = {
          expectedVersion: 0,
          driverId: `driver-profile-${owner}`,
        };
        const path = `/shipments/load-write-${number}/assign`,
          key = `load-assignment-${number.toString().padStart(16, "0")}`;
        const first = await request(path, `business-${owner}`, body, key);
        assert.equal(first.status, 200, "Assignment failed");
        assert.equal(first.body.data.version, 1);
        const replay = await request(path, `business-${owner}`, body, key);
        assert.equal(replay.status, 200);
        assert.equal(replay.replayed, "true");
        assert.deepEqual(replay.body, first.body);
        return "assign";
      }
      const response = await request(
        `/shipments/load-read-${tenant + 1}/assign`,
        `business-${tenant}`,
        { expectedVersion: 0, driverId: `driver-profile-${tenant}` },
        `load-denial-${current.toString().padStart(16, "0")}`,
      );
      assert.equal(response.status, 404, "Foreign write was not denied");
      return "deny";
    });
    report.phases.push(result);
    report.failures.push(...phaseFailures(result));
    console.log(
      `${phase.name}: ${result.completed} completed, ${result.failed} failed, ${result.dropped} dropped`,
    );
  }
  report.resources = {
    apiAndGeneratorCpuMicros: process.cpuUsage(cpuStart),
    peakRssBytes,
    peakPoolWaiting,
    eventLoopP99Ms: loop.percentile(99) / 1e6,
    httpRequests,
  };
  const integrity = (
    await pool.query(`select
    (select count(*)::int from shipments where id like 'load-write-%' and version=1 and status='assigned') as assigned,
    (select count(*)::int from shipment_events where shipment_id like 'load-write-%') as events,
    (select count(*)::int from idempotency_requests) as saved,
    (select count(*)::int from shipments where id like 'load-read-%' and version<>0) as foreign_changes`)
  ).rows[0];
  report.integrity = integrity;
  assert.equal(integrity.assigned, assignment);
  assert.equal(integrity.events, assignment);
  assert.equal(integrity.saved, assignment);
  assert.equal(integrity.foreign_changes, 0);
  report.databaseCounters = (
    await pool.query(
      "select xact_commit,xact_rollback,blks_read,blks_hit,deadlocks,temp_bytes from pg_stat_database where datname=current_database()",
    )
  ).rows[0];
  report.dockerStats = (
    await docker("stats", "--no-stream", "--format", "{{json .}}", container)
  ).stdout.trim();
  report.passed = report.failures.length === 0;
} catch (error) {
  report.failures.push(
    String(error.message).replaceAll(password, "[redacted]"),
  );
} finally {
  clearInterval(sampler);
  loop.disable();
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool
    ?.end()
    .catch(() => report.failures.push("Database cleanup failed"));
  if (started)
    await docker("stop", "--time", "1", container).catch(() =>
      report.failures.push("Container cleanup failed"),
    );
  report.passed = report.passed && report.failures.length === 0;
  report.finishedAt = new Date().toISOString();
  await writeFile(
    new URL(`../reports/load-${profile}.json`, import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    passed: report.passed,
    failures: report.failures,
    report: `reports/load-${profile}.json`,
  }),
);
if (!report.passed) process.exitCode = 1;
