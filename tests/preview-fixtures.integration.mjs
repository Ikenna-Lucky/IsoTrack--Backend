import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { postgresFixture } from "./helpers/postgres.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import { previewFixtureStatements } from "../src/db/preview-fixtures.ts";
import { assertPreviewBaseline } from "../src/db/preview-baseline.ts";
const pg = postgresFixture({ prefix: "preview-fixtures" });
const store = {
  execute: async (s) =>
    JSON.parse(
      await pg.query(sql`select coalesce(json_agg(r),'[]') from (${s})r`),
    ),
};
const transaction = (statements) =>
  pg.query(
    sql.join(
      [sql.raw("begin"), ...statements, sql.raw("commit")],
      sql.raw(";"),
    ),
  );
before(async () => {
  await pg.start();
  await assertPreviewBaseline(store);
  await runMigrations(
    {
      execute: async (s) =>
        JSON.parse(
          await pg.query(sql`select coalesce(json_agg(r),'[]') from (${s})r`),
        ),
      transaction,
    },
    fileURLToPath(new URL("../drizzle", import.meta.url)),
  );
});
after(() => pg.stop());
beforeEach(async () => {
  await pg.query(sql`truncate users cascade`);
  await transaction(previewFixtureStatements("fixture-hash"));
});
test("preview fixtures satisfy current migrations, private-fleet constraints and tenant ownership", async () => {
  assert.equal(
    await pg.query(
      sql`select count(*) from users where email like '%@example.invalid'`,
    ),
    "4",
  );
  assert.equal(
    await pg.query(
      sql`select business_id from drivers where id='preview-driver-profile'`,
    ),
    "preview-biz",
  );
  assert.equal(
    await pg.query(
      sql`select customer_id from shipments where id='preview-shipment'`,
    ),
    "preview-customer",
  );
  assert.equal(
    await pg.query(
      sql`select business_id from shipments where id='preview-foreign-shipment'`,
    ),
    "preview-other-biz",
  );
});
test("duplicate fixture insertion fails atomically rather than overwriting existing accounts or shipments", async () => {
  await assert.rejects(() =>
    transaction(previewFixtureStatements("different-hash")),
  );
  assert.equal(await pg.query(sql`select count(*) from users`), "4");
  assert.equal(
    await pg.query(
      sql`select password_hash from users where id='preview-owner'`,
    ),
    "fixture-hash",
  );
  assert.equal(await pg.query(sql`select count(*) from shipments`), "2");
});

test("a migrated preview passes baseline inspection without changing history", async () => {
  const before = await pg.query(
    sql`select count(*) from drizzle.__drizzle_migrations`,
  );
  await assertPreviewBaseline(store);
  assert.equal(
    await pg.query(sql`select count(*) from drizzle.__drizzle_migrations`),
    before,
  );
});

test("a schema-only copy with no ledger is rejected without creating one or changing data", async () => {
  await pg.query(
    sql`alter table drizzle.__drizzle_migrations rename to preview_saved_ledger`,
  );
  try {
    await assert.rejects(
      () => assertPreviewBaseline(store),
      /no migration history/,
    );
    assert.equal(
      await pg.query(
        sql`select to_regclass('drizzle.__drizzle_migrations') is null`,
      ),
      "t",
    );
    assert.equal(await pg.query(sql`select count(*) from users`), "4");
  } finally {
    await pg.query(
      sql`alter table drizzle.preview_saved_ledger rename to __drizzle_migrations`,
    );
  }
});

test("a schema-only copy with an empty ledger is rejected without inventing applied migrations", async () => {
  await pg.query(
    sql`create table drizzle.preview_saved_history as table drizzle.__drizzle_migrations; truncate drizzle.__drizzle_migrations`,
  );
  try {
    await assert.rejects(
      () => assertPreviewBaseline(store),
      /empty migration history/,
    );
    assert.equal(
      await pg.query(sql`select count(*) from drizzle.__drizzle_migrations`),
      "0",
    );
  } finally {
    await pg.query(
      sql`insert into drizzle.__drizzle_migrations select * from drizzle.preview_saved_history; drop table drizzle.preview_saved_history`,
    );
  }
});
