import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { postgresFixture } from "./helpers/postgres.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import { activeSessionStatement } from "../src/db/queries/session-statements.ts";
import { findRequestStatement } from "../src/db/queries/idempotency.ts";
import { shipmentTransitionStatement } from "../src/db/queries/shipment-access.ts";

// This drill never reads .env or accepts a database URL. Both databases are
// generated, unexposed Docker fixtures; archives contain synthetic data only.
const source = postgresFixture({ prefix: "recovery-source" });
const target = postgresFixture({ prefix: "recovery-target" });
const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const query = (pg, statement) => pg.query(sql.raw(statement));
const store = (pg) => ({
  execute: async (statement) =>
    JSON.parse(
      await pg.query(
        sql`select coalesce(json_agg(r),'[]') from (${statement}) r`,
      ),
    ),
  transaction: (statements) =>
    pg.query(
      sql.join(
        [sql.raw("begin"), ...statements, sql.raw("commit")],
        sql.raw(";"),
      ),
    ),
});
let archive,
  baseline,
  sourceStopped = false;
const evidence = {
  scope: "synthetic local PostgreSQL 17 logical recovery",
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  commit: process.env.GITHUB_SHA ?? null,
  recoveryBudgetMs: 120000,
  passed: false,
};
const evidencePath = join(root, "reports/recovery-measurements.json");
const columns = pgTable("shipments", {
  businessId: text("business_id"),
  driverId: text("driver_id"),
  customerId: text("customer_id"),
});

async function snapshot(pg) {
  const tables = JSON.parse(
    await query(
      pg,
      `select json_agg(json_build_object('schema',schemaname,'name',tablename) order by schemaname,tablename)
    from pg_tables where schemaname in ('public','drizzle')`,
    ),
  );
  const result = {};
  for (const table of tables) {
    // Identifiers originate from our migrated fixture, not user input.
    const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
    const rows = await query(
      pg,
      `select coalesce(jsonb_agg(row order by row::text),'[]'::jsonb)::text from
      (select to_jsonb(t) row from ${quote(table.schema)}.${quote(table.name)} t) records`,
    );
    result[`${table.schema}.${table.name}`] = {
      count: JSON.parse(rows).length,
      sha256: createHash("sha256").update(rows).digest("hex"),
    };
  }
  return result;
}

async function restore(bytes) {
  assert.equal(
    await query(
      target,
      `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'`,
    ),
    "0",
    "Restore target must be empty",
  );
  const process = execute(
    "docker",
    [
      "exec",
      "-i",
      target.container,
      "pg_restore",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
    ],
    { timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
  );
  // pg_restore may reject a corrupt archive before reading the entire stream.
  process.child.stdin.on("error", () => {});
  process.child.stdin.end(bytes);
  await process;
}

before(async () => {
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  await source.start();
  await target.start();
  await runMigrations(store(source), join(root, "drizzle"));
  const passwordHash = await bcrypt.hash("synthetic-recovery-password", 12);
  await source.query(sql`insert into users(id,email,password_hash,name,role) values
    ('owner','owner@example.test',${passwordHash},'Owner','business'),
    ('driver-user','driver@example.test',${passwordHash},'Driver','driver'),
    ('customer','customer@example.test',${passwordHash},'Customer','customer');
    insert into businesses(id,user_id,business_name) values('business','owner','Recovery fixture');
    insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate) values('driver','driver-user','business','bike','TEST');
    insert into shipments(id,tracking_id,business_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo,is_paid)
      values('shipment','IST-RECOVERY','business','customer','Synthetic box',1,'{}','{}',100,true);
    insert into shipment_events(id,shipment_id,status,message) values('created','shipment','pending','Shipment created');
    insert into payments(id,shipment_id,provider_reference,stripe_session_id,amount_kobo,status,checkout_state,paid_at,received_at)
      values('payment','shipment','REF-RECOVERY','cs_recovery',100,'success','settled',now(),now());
    insert into shipment_payment_receipts(shipment_id,payment_id) values('shipment','payment');
    insert into payment_checkout_guards(shipment_id,payment_id) values('shipment','payment');
    insert into auth_sessions(id,user_id,credential_version,expires_at) values('session','owner',0,now()+interval '1 day');
    insert into idempotency_requests(id,user_id,operation,key_hash,request_hash,resource_id,state,response)
      values('request','owner','shipments.create',repeat('a',64),repeat('b',64),'shipment','completed','{"data":{"id":"shipment"}}');`);
  baseline = await snapshot(source);
  const started = performance.now();
  const dump = await execute(
    "docker",
    [
      "exec",
      source.container,
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
    ],
    { encoding: "buffer", timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
  );
  archive = dump.stdout;
  assert.equal(archive.subarray(0, 5).toString(), "PGDMP");
  evidence.backupMs = Math.round(performance.now() - started);
  evidence.archiveBytes = archive.length;
  evidence.archiveSha256 = createHash("sha256").update(archive).digest("hex");
  // A later committed record must not appear in the recovered snapshot.
  await query(
    source,
    "insert into users(id,email,password_hash,name,role) values('after-backup','later@example.test','hash','Later','customer')",
  );
  await source.stop();
  sourceStopped = true;
});

after(async () => {
  const cleanup = await Promise.allSettled([
    ...(sourceStopped ? [] : [source.stop()]),
    target.stop(),
  ]);
  evidence.finishedAt = new Date().toISOString();
  evidence.cleanupPassed = cleanup.every(
    (result) => result.status === "fulfilled",
  );
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  for (const result of cleanup)
    if (result.status === "rejected") throw result.reason;
});

test("corrupt archive fails without leaving a partial schema", async () => {
  await assert.rejects(
    restore(archive.subarray(0, Math.floor(archive.length / 2))),
  );
  assert.equal(
    await query(
      target,
      "select count(*) from pg_tables where schemaname in ('public','drizzle')",
    ),
    "0",
  );
});

test("restore with source unavailable preserves data and supports credential, session and shipment operations", async () => {
  const started = performance.now();
  await restore(archive);
  await query(target, "analyze");
  assert.deepEqual(await snapshot(target), baseline);
  assert.equal(
    await query(target, "select count(*) from users where id='after-backup'"),
    "0",
  );
  assert.equal(await runMigrations(store(target), join(root, "drizzle")), 0);
  assert.equal(
    await target.query(activeSessionStatement("session", "owner")),
    "session",
  );
  const hash = await query(
    target,
    "select password_hash from users where id='owner'",
  );
  assert.equal(await bcrypt.compare("synthetic-recovery-password", hash), true);
  const replay = JSON.parse(
    await target.query(
      findRequestStatement("owner", "shipments.create", "a".repeat(64)),
    ),
  );
  assert.equal(replay.state, "completed");
  assert.equal(replay.response.data.id, "shipment");
  const shipment = JSON.parse(
    await target.query(
      shipmentTransitionStatement(
        columns,
        { userId: "owner", role: "business" },
        {
          shipmentId: "shipment",
          expectedStatus: "pending",
          status: "assigned",
          driverId: "driver",
          eventId: "restored-assignment",
          message: "Assignment after recovery",
        },
      ),
    ),
  );
  assert.equal(shipment.status, "assigned");
  assert.equal(
    await query(
      target,
      "select count(*) from notification_outbox where id like 'shipment_restored-assignment_%'",
    ),
    "3",
  );
  assert.equal(
    await query(
      target,
      "select p.amount_kobo from shipment_payment_receipts r join payments p on p.id=r.payment_id join shipments s on s.id=r.shipment_id where s.is_paid",
    ),
    "100",
  );
  await assert.rejects(
    query(
      target,
      "insert into shipment_payment_receipts(shipment_id,payment_id) values('shipment','payment')",
    ),
    /duplicate key/,
  );
  await query(
    target,
    "update users set password_hash='changed-after-recovery' where id='owner'",
  );
  assert.equal(
    await target.query(activeSessionStatement("session", "owner")),
    "",
  );
  evidence.restoreAndVerificationMs = Math.round(performance.now() - started);
  assert.ok(
    evidence.restoreAndVerificationMs < evidence.recoveryBudgetMs,
    "Small-fixture recovery exceeded its local budget",
  );
  evidence.tables = baseline;
  evidence.recoveryPoint =
    "All fixture records at dump; subsequent committed source record excluded";
});

test("restore refuses a populated destination and preserves its records", async () => {
  const before = await snapshot(target);
  await assert.rejects(restore(archive), /Restore target must be empty/);
  assert.deepEqual(await snapshot(target), before);
  evidence.passed = true;
});
