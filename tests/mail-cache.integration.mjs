import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { postgresFixture } from "./helpers/postgres.mjs";
import { createMailCacheStore } from "../src/db/mail-cache-store.ts";
const postgres = postgresFixture({ prefix: "mail-cache" });
const database = {
  query: async (text, params = []) => {
    const statement = sql.join(
      text
        .split(/(\$\d+)/)
        .map((part) =>
          /^\$\d+$/.test(part)
            ? sql`${params[Number(part.slice(1)) - 1]}`
            : sql.raw(part),
        ),
      sql``,
    );
    return JSON.parse(
      await postgres.query(
        sql`with result as (${statement}) select coalesce(json_agg(result),'[]') from result`,
        { prepared: true },
      ),
    );
  },
};
before(async () => {
  await postgres.start();
  await postgres.query(
    sql.raw(
      await readFile(
        new URL("../drizzle/0019_microsoft_mail_cache.sql", import.meta.url),
        "utf8",
      ),
    ),
  );
});
after(async () => postgres.stop());
test("encrypted cache survives restart, serializes refresh and releases failed operations", async () => {
  const store = createMailCacheStore(database, "sender", "ab".repeat(32));
  await store.use(async (previous) => {
    assert.equal(previous, null);
    return { cache: "refresh-v1", value: undefined };
  });
  const persisted = await postgres.query(
    sql`select encrypted_cache from microsoft_mail_cache where id='sender'`,
  );
  assert.ok(!persisted.includes("refresh-v1"));
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const first = store.use(async (previous) => {
    assert.equal(previous, "refresh-v1");
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
    return { cache: "refresh-v2", value: "token" };
  });
  await ready;
  const restarted = createMailCacheStore(database, "sender", "ab".repeat(32));
  await assert.rejects(
    restarted.use(async () => {
      throw new Error("must not run");
    }),
    /busy/,
  );
  release();
  assert.equal(await first, "token");
  await assert.rejects(
    restarted.use(async (previous) => {
      assert.equal(previous, "refresh-v2");
      throw new Error("provider failed");
    }),
    /provider failed/,
  );
  assert.equal(
    await restarted.use(async (previous) => ({
      cache: previous,
      value: "recovered",
    })),
    "recovered",
  );
});
test("expired refresh owner cannot overwrite a newer credential cache", async () => {
  const store = createMailCacheStore(database, "fenced", "ab".repeat(32));
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const first = store.use(async () => {
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
    return { cache: "old", value: null };
  });
  const rejected = assert.rejects(first, /lease expired/);
  await ready;
  await postgres.query(
    sql`update microsoft_mail_cache set lease_until=now()-interval '1 second' where id='fenced'`,
  );
  await store.use(async () => ({ cache: "new", value: null }));
  release();
  await rejected;
  await store.use(async (previous) => {
    assert.equal(previous, "new");
    return { cache: previous, value: null };
  });
});
