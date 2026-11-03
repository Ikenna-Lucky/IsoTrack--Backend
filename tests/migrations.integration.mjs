import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { postgresFixture } from "./helpers/postgres.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";

const postgres = postgresFixture({ prefix: "migration" });
const folder = fileURLToPath(new URL("../drizzle", import.meta.url));
const migrations = readMigrationFiles({ migrationsFolder: folder });
const temporary = [];
const store = {
  execute: async (statement) =>
    JSON.parse(
      await postgres.query(
        sql`select coalesce(json_agg(r), '[]') from (${statement}) r`,
      ),
    ),
  transaction: async (statements) => {
    await postgres.query(
      sql.join(
        [sql.raw("begin"), ...statements, sql.raw("commit")],
        sql.raw(";\n"),
      ),
    );
  },
};
const query = (text) => postgres.query(sql.raw(text));
async function copyJournal(count, extra = false) {
  const directory = await mkdtemp(join(tmpdir(), "isotrack-migrations-"));
  temporary.push(directory);
  await mkdir(join(directory, "meta"));
  const journal = JSON.parse(
    await readFile(join(folder, "meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.slice(0, count);
  for (const entry of journal.entries) {
    await writeFile(
      join(directory, `${entry.tag}.sql`),
      await readFile(join(folder, `${entry.tag}.sql`)),
    );
  }
  if (extra) {
    journal.entries.push({
      idx: count,
      version: "7",
      when: Math.max(...migrations.map((entry) => entry.folderMillis)) + 1,
      tag: "failure",
      breakpoints: true,
    });
    await writeFile(
      join(directory, "failure.sql"),
      "create table must_rollback(id int); select 1/0;",
    );
  }
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  return directory;
}
before(() => postgres.start());
after(async () => {
  await postgres.stop();
  for (const directory of temporary) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("isotrack-migrations-")
    ) {
      throw new Error(
        "Refusing cleanup outside the migration fixture directory",
      );
    }
    await rm(directory, { recursive: true, force: true });
  }
});
beforeEach(async () => {
  await query(
    "drop schema public cascade; create schema public; drop schema if exists drizzle cascade",
  );
});

test("fresh install runs every migration and repeated runs preserve history", async () => {
  assert.equal(await runMigrations(store, folder), migrations.length);
  assert.equal(
    await query("select count(*) from drizzle.__drizzle_migrations"),
    String(migrations.length),
  );
  assert.equal(await runMigrations(store, folder), 0);
  assert.equal(
    await query("select count(*) from drizzle.__drizzle_migrations"),
    String(migrations.length),
  );
  assert.equal(
    await query("select to_regclass('public.idempotency_requests')"),
    "idempotency_requests",
  );
  assert.equal(
    await query(
      "select count(*) from pg_trigger where not tgisinternal and tgrelid='users'::regclass",
    ),
    "1",
  );
});

test("upgrade preserves existing accounts and installs later schema", async () => {
  await runMigrations(store, await copyJournal(1));
  await query(
    "insert into users(id,email,password_hash,name,role) values('existing','old@example.test','hash','Existing','customer')",
  );
  assert.equal(await runMigrations(store, folder), migrations.length - 1);
  assert.equal(
    await query(
      "select name || ':' || credential_version from users where id='existing'",
    ),
    "Existing:0",
  );
  assert.equal(
    await query("select to_regclass('public.notification_outbox')"),
    "notification_outbox",
  );
});

test("repairs historical settings omission without timestamp reordering", async () => {
  await runMigrations(store, folder);
  await query(
    `delete from drizzle.__drizzle_migrations where created_at=${migrations[1].folderMillis}; alter table users drop column emergency_contact`,
  );
  assert.equal(await runMigrations(store, folder), 1);
  assert.equal(
    await query(
      "select count(*) from information_schema.columns where table_name='users' and column_name='emergency_contact'",
    ),
    "1",
  );
  assert.equal(await runMigrations(store, folder), 0);
});

test("failure rolls back all pending schema, data and history, then retry succeeds", async () => {
  await runMigrations(store, await copyJournal(1));
  await assert.rejects(
    runMigrations(store, await copyJournal(migrations.length, true)),
    /division by zero/,
  );
  assert.equal(
    await query("select count(*) from drizzle.__drizzle_migrations"),
    "1",
  );
  assert.equal(
    await query(
      "select to_regclass('public.must_rollback') is null and to_regclass('public.auth_sessions') is null",
    ),
    "t",
  );
  assert.equal(await runMigrations(store, folder), migrations.length - 1);
});

test("changed files, unknown history, duplicate history and gaps fail closed", async () => {
  await runMigrations(store, folder);
  const changed = await copyJournal(migrations.length);
  const first = join(changed, "0000_graceful_the_enforcers.sql");
  await writeFile(first, `${await readFile(first, "utf8")}\n-- edited\n`);
  await assert.rejects(
    runMigrations(store, changed),
    /Unknown, changed or duplicate/,
  );
  await query(
    "insert into drizzle.__drizzle_migrations(hash,created_at) values('unknown',999)",
  );
  await assert.rejects(
    runMigrations(store, folder),
    /Unknown, changed or duplicate/,
  );
  await query(
    "delete from drizzle.__drizzle_migrations where hash='unknown'; insert into drizzle.__drizzle_migrations(hash,created_at) select hash,created_at from drizzle.__drizzle_migrations limit 1",
  );
  await assert.rejects(
    runMigrations(store, folder),
    /Unknown, changed or duplicate/,
  );
  await query(
    "delete from drizzle.__drizzle_migrations where id=(select max(id) from drizzle.__drizzle_migrations)",
  );
  await query(
    `delete from drizzle.__drizzle_migrations where created_at=${migrations[3].folderMillis}`,
  );
  await assert.rejects(runMigrations(store, folder), /history contains a gap/);
  assert.equal(
    await query("select count(*) from drizzle.__drizzle_migrations"),
    String(migrations.length - 1),
  );
});

test("concurrent runners cannot apply the same pending migration twice", async () => {
  // Barrier ensures both runners plan from the same ledger, rather than relying on timing.
  let reads = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const synchronized = {
    ...store,
    execute: async (statement) => {
      const result = await store.execute(statement);
      if (++reads === 2) release();
      await ready;
      return result;
    },
  };
  const results = await Promise.allSettled([
    runMigrations(synchronized, folder),
    runMigrations(synchronized, folder),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.match(
    results.find((result) => result.status === "rejected").reason.message,
    /history changed concurrently/,
  );
  assert.equal(
    await query("select count(*) from drizzle.__drizzle_migrations"),
    String(migrations.length),
  );
  assert.equal(await runMigrations(store, folder), 0);
});

test("lost commit acknowledgement is recovered by reading durable history", async () => {
  let calls = 0;
  const interrupted = {
    ...store,
    transaction: async (statements) => {
      await store.transaction(statements);
      if (++calls === 2) throw new Error("Injected lost acknowledgement");
    },
  };
  await assert.rejects(
    runMigrations(interrupted, folder),
    /lost acknowledgement/,
  );
  assert.equal(await runMigrations(store, folder), 0);
  assert.equal(
    await query("select count(*) from drizzle.__drizzle_migrations"),
    String(migrations.length),
  );
});
