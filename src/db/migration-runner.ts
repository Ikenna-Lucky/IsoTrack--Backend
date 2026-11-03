import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql, type SQL } from "drizzle-orm";

export interface MigrationStore {
  execute(statement: SQL): Promise<Record<string, unknown>[]>;
  transaction(statements: SQL[]): Promise<void>;
}

const history = sql`select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
const lock = sql`select pg_advisory_xact_lock(721684302119::bigint)`;
const limits = [
  sql`set local lock_timeout = '10s'`,
  sql`set local statement_timeout = '90s'`,
];
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** One atomic batch, including its ledger. No application environment is loaded here. */
export async function runMigrations(
  store: MigrationStore,
  folder: string,
): Promise<number> {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  if (migrations.length === 0) throw new Error("No migrations found");
  const identities = new Set<string>();
  const times = new Set<number>();
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.folderMillis) ||
      identities.has(migration.hash) ||
      times.has(migration.folderMillis)
    ) {
      throw new Error("Ambiguous migration journal");
    }
    identities.add(migration.hash);
    times.add(migration.folderMillis);
  }
  await store.transaction([
    ...limits,
    lock,
    sql`create schema if not exists drizzle`,
    sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
  ]);
  const rows = await store.execute(history);
  const applied = new Set<string>();
  for (const row of rows) {
    const migration = migrations.find(
      (entry) =>
        entry.hash === row.hash &&
        String(entry.folderMillis) === row.created_at,
    );
    if (!migration || applied.has(migration.hash))
      throw new Error("Unknown, changed or duplicate migration history");
    applied.add(migration.hash);
  }
  // Historical settings migration predates 0000; old timestamp-based runs may
  // omit it. Its ADD COLUMN IF NOT EXISTS statements safely repair that gap.
  let missing = false;
  for (const [index, migration] of migrations.entries()) {
    if (!applied.has(migration.hash)) {
      if (index !== 1 || migration.folderMillis !== 1747134000000)
        missing = true;
    } else if (missing) throw new Error("Migration history contains a gap");
  }
  const pending = migrations.filter(
    (migration) => !applied.has(migration.hash),
  );
  if (pending.length === 0) return 0;
  const snapshot = JSON.stringify(
    rows.map((row) => [row.hash, row.created_at]),
  );
  const guard = sql.raw(`DO $guard$ BEGIN
    IF (SELECT coalesce(jsonb_agg(jsonb_build_array(hash, created_at::text) ORDER BY id), '[]'::jsonb)
        FROM drizzle.__drizzle_migrations) IS DISTINCT FROM ${literal(snapshot)}::jsonb THEN
      RAISE EXCEPTION 'Migration history changed concurrently; rerun migrations';
    END IF;
  END $guard$;`);
  const statements: SQL[] = [...limits, lock, guard];
  for (const migration of pending) {
    // EXECUTE supports historical files without statement breakpoints, preserving function bodies.
    statements.push(
      sql.raw(
        `DO $migration$ BEGIN EXECUTE ${literal(migration.sql.join("\n"))}; END $migration$;`,
      ),
    );
    statements.push(
      sql`insert into drizzle.__drizzle_migrations(hash, created_at) values (${migration.hash}, ${migration.folderMillis})`,
    );
  }
  await store.transaction(statements);
  return pending.length;
}
