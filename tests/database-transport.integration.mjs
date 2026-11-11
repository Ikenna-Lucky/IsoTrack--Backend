import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import { createDatabaseTransport } from "../src/db/transport.ts";
import { runMigrations } from "../src/db/migration-runner.ts";

const exec = promisify(execFile);
test(
  "Docker adapter applies migrations, preserves transactions, and discards cancelled connections",
  { timeout: 90000 },
  async () => {
    const container = `isotrack-adapter-test-${randomUUID()}`;
    const password = randomUUID();
    let started = false,
      transport;
    const docker = (...args) => exec("docker", args, { timeout: 60000 });
    try {
      await docker(
        "run",
        "--detach",
        "--rm",
        "--name",
        container,
        "-p",
        "127.0.0.1::5432",
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "postgres:17-alpine",
      );
      started = true;
      const port = (await docker("port", container, "5432/tcp")).stdout
        .trim()
        .split(":")
        .at(-1);
      transport = createDatabaseTransport({
        DATABASE_DRIVER: "postgres",
        DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
        NODE_ENV: "test",
      });
      const deadline = Date.now() + 30000;
      for (;;) {
        try {
          await transport.query("select 1");
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await delay(200);
        }
      }
      const dialect = new PgDialect();
      const compile = (statement) => {
        const query = dialect.sqlToQuery(statement);
        return { text: query.sql, params: query.params };
      };
      const store = {
        execute: (statement) => {
          const query = compile(statement);
          return transport.query(query.text, query.params);
        },
        transaction: (statements) =>
          transport.transaction(statements.map(compile), { timeoutMs: 120000 }),
      };
      const folder = fileURLToPath(new URL("../drizzle", import.meta.url));
      assert.equal(await runMigrations(store, folder), 18);
      assert.equal(await runMigrations(store, folder), 0);
      await transport.query(
        "create table adapter_probe(id integer primary key)",
      );
      await assert.rejects(
        transport.transaction([
          { text: "insert into adapter_probe values($1)", params: [1] },
          { text: "select 1/0" },
        ]),
      );
      assert.deepEqual(
        await transport.query("select * from adapter_probe"),
        [],
      );
      const result = await transport.transaction([
        {
          text: "insert into adapter_probe values($1) returning id",
          params: [2],
        },
        { text: "select * from adapter_probe" },
      ]);
      assert.deepEqual(result, [[{ id: 2 }], [{ id: 2 }]]);
      await assert.rejects(
        transport.query("select pg_sleep(3)", [], { timeoutMs: 40 }),
      );
      assert.deepEqual(await transport.query("select 1 as healthy"), [
        { healthy: 1 },
      ]);
      await assert.rejects(
        transport.transaction(
          [
            { text: "insert into adapter_probe values(3)" },
            { text: "select pg_sleep(3)" },
          ],
          { timeoutMs: 40 },
        ),
      );
      assert.deepEqual(
        await transport.query("select id from adapter_probe order by id"),
        [{ id: 2 }],
      );
    } finally {
      await transport?.close();
      if (started) await docker("stop", "--time", "1", container);
    }
  },
);
