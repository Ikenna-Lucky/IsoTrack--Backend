import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";
import pg from "pg";
import bcrypt from "bcryptjs";

// Explicit operator command, never loaded by the server or ordinary test runner.
// Database writes are restricted to a separate, empty recovery-only destination.
const root = process.cwd();
const mode = process.argv[2] ?? "check";
const runId = randomUUID();
const report = {
  runId,
  startedAt: new Date().toISOString(),
  passed: false,
  scope: "hosted preview logical restore; no traffic cutover",
};
const clients = [];
let stage = "configuration";
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalized = (host) => host.toLowerCase().replace("-pooler.", ".");
const reportPath = join(root, "reports", `hosted-recovery-${runId}.json`);

function tool(executable, args, url, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: {
        ...process.env,
        PGHOST: url.hostname,
        PGPORT: url.port || "5432",
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
        PGSSLMODE: "require",
        PGCONNECT_TIMEOUT: "15",
        PGAPPNAME: "isotrack-hosted-recovery",
        PGOPTIONS: "-c statement_timeout=120000 -c lock_timeout=10000",
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0,
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, 150000);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        failed = true;
        child.kill();
      } else chunks.push(chunk);
    });
    // Never print provider stderr: it may contain credentials or record values.
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 65536) stderr += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("PostgreSQL tool could not start"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error("PostgreSQL tool failed"));
      else
        resolve({ bytes: Buffer.concat(chunks), warning: stderr.length > 0 });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function connect(url) {
  // Explicit certificate validation rather than relying on pg's require alias.
  const tlsUrl = new URL(url);
  tlsUrl.searchParams.set("sslmode", "verify-full");
  const client = new pg.Client({
    connectionString: tlsUrl.href,
    connectionTimeoutMillis: 30000,
    statement_timeout: 120000,
    application_name: "isotrack-hosted-recovery",
  });
  clients.push(client);
  await client.connect();
  return client;
}

async function empty(client) {
  const { rows } = await client.query(
    "select count(*)::int count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg_%' and n.nspname<>'information_schema'",
  );
  assert.equal(rows[0].count, 0, "Recovery target is not empty");
  const routines = await client.query(
    "select count(*)::int count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not like 'pg_%' and n.nspname<>'information_schema'",
  );
  assert.equal(
    routines.rows[0].count,
    0,
    "Recovery target has existing routines",
  );
}

async function snapshot(client) {
  const tables = (
    await client.query(
      "select schemaname,tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1,2",
    )
  ).rows;
  assert(tables.length > 0 && tables.length <= 100);
  const result = {};
  for (const { schemaname, tablename } of tables) {
    assert(["public", "drizzle"].includes(schemaname), "Unexpected schema");
    const rows = (
      await client.query(
        `select count(*)::int count, coalesce(jsonb_agg(row order by row::text),'[]'::jsonb)::text content from (select to_jsonb(t) row from ${quote(schemaname)}.${quote(tablename)} t) records`,
      )
    ).rows[0];
    assert(
      Buffer.byteLength(rows.content) <= 16 * 1024 * 1024,
      "Fixture exceeds bounded comparison size",
    );
    result[`${schemaname}.${tablename}`] = {
      count: rows.count,
      sha256: hash(rows.content),
    };
  }
  return result;
}

async function constraints(client) {
  return (
    await client.query(
      "select n.nspname schema,c.relname table_name,k.conname name,k.contype type,k.convalidated validated,pg_get_constraintdef(k.oid) definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') order by 1,2,3",
    )
  ).rows;
}

try {
  assert(["check", "restore"].includes(mode));
  await mkdir(join(root, "reports"), { recursive: true });
  const config = parseEnv(
    await readFile(join(root, ".env.recovery-hosted"), "utf8"),
  );
  const preview = parseEnv(await readFile(join(root, ".env.preview"), "utf8"));
  const sourceUrl = new URL(config.RECOVERY_SOURCE_DATABASE_URL);
  const targetUrl = new URL(config.RECOVERY_TARGET_DATABASE_URL);
  const expected = new URL(preview.DATABASE_URL);
  for (const url of [sourceUrl, targetUrl]) {
    assert(["postgres:", "postgresql:"].includes(url.protocol));
    assert(
      url.hostname.endsWith(".neon.tech") && !url.hostname.includes("-pooler."),
    );
    assert(
      ["require", "verify-full"].includes(url.searchParams.get("sslmode")),
    );
  }
  assert.equal(normalized(sourceUrl.hostname), normalized(expected.hostname));
  assert.equal(sourceUrl.pathname, expected.pathname);
  assert(preview.LIVE_DATABASE_HOST);
  assert.notEqual(
    normalized(sourceUrl.hostname),
    normalized(preview.LIVE_DATABASE_HOST),
  );
  assert.notEqual(
    normalized(targetUrl.hostname),
    normalized(preview.LIVE_DATABASE_HOST),
  );
  assert.notEqual(
    normalized(sourceUrl.hostname),
    normalized(targetUrl.hostname),
  );
  assert.equal(targetUrl.pathname, "/isotrack_recovery");
  stage = "database preflight";
  stage = "source connection";
  const source = await connect(sourceUrl);
  stage = "target connection";
  const target = await connect(targetUrl);
  stage = "database versions and empty target";
  const version = async (client) =>
    Number(
      (await client.query("show server_version_num")).rows[0]
        .server_version_num,
    );
  report.sourceVersion = await version(source);
  report.targetVersion = await version(target);
  assert.equal(Math.floor(report.sourceVersion / 10000), 17);
  assert.equal(Math.floor(report.targetVersion / 10000), 17);
  await empty(target);
  if (mode === "check") {
    report.passed = true;
    report.status = "empty_target_and_isolation_verified";
  } else {
    const bin =
      process.env.RECOVERY_PG_BIN ??
      (process.platform === "win32"
        ? "C:/Program Files/PostgreSQL/17/bin"
        : "/usr/bin");
    const executable = (name) =>
      join(bin, name + (process.platform === "win32" ? ".exe" : ""));
    stage = "consistent read-only snapshot";
    await source.query("begin isolation level repeatable read read only");
    const snapshotId = (await source.query("select pg_export_snapshot() id"))
      .rows[0].id;
    report.snapshotAt = new Date().toISOString();
    report.tables = await snapshot(source);
    const beforeConstraints = await constraints(source);
    stage = "backup";
    const backupStart = performance.now();
    const dump = await tool(
      executable("pg_dump"),
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--lock-wait-timeout=10000",
        `--snapshot=${snapshotId}`,
      ],
      sourceUrl,
    );
    assert(!dump.warning, "Backup emitted warnings");
    assert(dump.bytes.subarray(0, 5).equals(Buffer.from("PGDMP")));
    report.backupMs = Math.round(performance.now() - backupStart);
    report.archiveBytes = dump.bytes.length;
    report.archiveSha256 = hash(dump.bytes);
    await source.query("rollback");
    // Retain encrypted archive and separate private key; neither enters Git.
    stage = "encrypted archive retention";
    const key = randomBytes(32),
      iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      iv,
      cipher.update(dump.bytes),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    await writeFile(join(root, ".verification", `recovery-${runId}.key`), key, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(
      join(root, ".verification", `recovery-${runId}.dump.aes`),
      encrypted,
      { flag: "wx", mode: 0o600 },
    );
    report.encryptedArchiveSha256 = hash(encrypted);
    stage = "read saved encrypted archive";
    const saved = await readFile(
      join(root, ".verification", `recovery-${runId}.dump.aes`),
    );
    const savedKey = await readFile(
      join(root, ".verification", `recovery-${runId}.key`),
    );
    assert.equal(hash(saved), report.encryptedArchiveSha256);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      savedKey,
      saved.subarray(0, 12),
    );
    decipher.setAuthTag(saved.subarray(-16));
    const restoredArchive = Buffer.concat([
      decipher.update(saved.subarray(12, -16)),
      decipher.final(),
    ]);
    assert.equal(hash(restoredArchive), report.archiveSha256);
    dump.bytes.fill(0);
    stage = "empty-target recheck";
    await empty(target);
    stage = "atomic restore";
    const recoveryStart = performance.now();
    await tool(
      executable("pg_restore"),
      [
        "--dbname=" + decodeURIComponent(targetUrl.pathname.slice(1)),
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
      ],
      targetUrl,
      restoredArchive,
    );
    report.restoreMs = Math.round(performance.now() - recoveryStart);
    stage = "restored content and constraints";
    const validationStart = performance.now();
    await target.query("begin isolation level repeatable read read only");
    assert.deepEqual(await snapshot(target), report.tables);
    const restoredConstraints = await constraints(target);
    assert.deepEqual(restoredConstraints, beforeConstraints);
    report.constraintCount = restoredConstraints.length;
    report.unvalidatedConstraints = restoredConstraints
      .filter((c) => !c.validated)
      .map((c) => ({ table: c.table_name, name: c.name }));
    stage = "foreign-key row validation";
    // Check existing rows even for historical NOT VALID foreign keys.
    const fks = (
      await target.query(
        "select k.conname name,n.nspname schema,c.relname table_name,rn.nspname ref_schema,r.relname ref_table,array(select a.attname::text from unnest(k.conkey) with ordinality x(num,ord) join pg_attribute a on a.attrelid=k.conrelid and a.attnum=x.num order by x.ord) cols,array(select a.attname::text from unnest(k.confkey) with ordinality x(num,ord) join pg_attribute a on a.attrelid=k.confrelid and a.attnum=x.num order by x.ord) ref_cols from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_class r on r.oid=k.confrelid join pg_namespace rn on rn.oid=r.relnamespace where k.contype='f' and n.nspname in ('public','drizzle')",
      )
    ).rows;
    for (const fk of fks) {
      const present = fk.cols
        .map((c) => `s.${quote(c)} is not null`)
        .join(" and ");
      const match = fk.cols
        .map((c, i) => `s.${quote(c)}=r.${quote(fk.ref_cols[i])}`)
        .join(" and ");
      const violations = await target.query(
        `select count(*)::int count from ${quote(fk.schema)}.${quote(fk.table_name)} s where ${present} and not exists(select 1 from ${quote(fk.ref_schema)}.${quote(fk.ref_table)} r where ${match})`,
      );
      assert.equal(
        violations.rows[0].count,
        0,
        "Restored foreign key violation",
      );
    }
    report.foreignKeysChecked = fks.length;
    stage = "migration journal validation";
    const ledger = (
      await target.query(
        "select hash,created_at::text from drizzle.__drizzle_migrations order by id",
      )
    ).rows;
    const journal = JSON.parse(
      await readFile(join(root, "drizzle/meta/_journal.json"), "utf8"),
    );
    const migrations = [];
    for (const entry of journal.entries) {
      const text = await readFile(
        join(root, "drizzle", entry.tag + ".sql"),
        "utf8",
      );
      migrations.push({
        hash: hash(text.replaceAll("\r\n", "\n")),
        folderMillis: entry.when,
      });
    }
    report.journalComparison =
      "Exact restored ledger content plus LF-normalized repository SQL hashes; no ledger edits";
    assert.equal(ledger.length, migrations.length);
    for (let i = 0; i < ledger.length; i++) {
      assert.equal(ledger[i].hash, migrations[i].hash);
      assert.equal(ledger[i].created_at, String(migrations[i].folderMillis));
    }
    report.migrationCount = ledger.length;
    stage = "restored credential validation";
    const owner = (
      await target.query(
        "select u.password_hash,u.is_active from users u join businesses b on b.user_id=u.id where u.id='preview-owner' and u.email='preview-owner@example.invalid'",
      )
    ).rows;
    assert.equal(owner.length, 1);
    assert(owner[0].is_active);
    assert(
      await bcrypt.compare(
        preview.PREVIEW_FIXTURE_PASSWORD,
        owner[0].password_hash,
      ),
    );
    report.restoredCredentialVerified = true;
    stage = "restored payment invariants";
    const paymentChecks = (
      await target.query(`select
      (select count(*)::int from shipment_payment_receipts r join payments p on p.id=r.payment_id join shipments s on s.id=r.shipment_id
        where p.shipment_id<>r.shipment_id or p.status<>'success' or not s.is_paid) invalid_receipts,
      (select count(*)::int from payments p where p.status='refunded' and
        (p.refund_id is null or p.refund_recorded_at is null or p.refund_recorded_by is null)) invalid_refunds,
      (select count(*)::int from payment_checkout_guards g join payments p on p.id=g.payment_id where p.status='refunded') refunded_guards
    `)
    ).rows[0];
    assert.equal(paymentChecks.invalid_receipts, 0);
    assert.equal(paymentChecks.invalid_refunds, 0);
    assert.equal(paymentChecks.refunded_guards, 0);
    report.paymentChecks = paymentChecks;
    await target.query("rollback");
    report.validationMs = Math.round(performance.now() - validationStart);
    report.recoveryAndValidationMs = Math.round(
      performance.now() - recoveryStart,
    );
    report.status = "hosted_snapshot_restore_verified";
    report.passed = true;
  }
} catch (error) {
  report.failedStage = stage;
  if (/^[A-Z0-9_]{3,40}$/.test(error.code ?? "")) report.errorCode = error.code;
  report.status = "failed";
  process.exitCode = 1;
} finally {
  for (const client of clients) await client.end().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      passed: report.passed,
      status: report.status,
      failedStage: report.failedStage,
      tableCount: report.tables && Object.keys(report.tables).length,
      archiveBytes: report.archiveBytes,
      recoveryAndValidationMs: report.recoveryAndValidationMs,
      report: reportPath,
    }),
  );
}
