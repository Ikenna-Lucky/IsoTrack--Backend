import { neon } from "@neondatabase/serverless";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migration-runner.ts";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const client = neon(url);
  const dialect = new PgDialect();
  const store = {
    execute: async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      return client(query.sql, query.params, {
        fetchOptions: { signal: AbortSignal.timeout(120_000) },
      });
    },
    transaction: async (statements: SQL[]) => {
      await client.transaction(
        statements.map((statement) => {
          const query = dialect.sqlToQuery(statement);
          return client(query.sql, query.params);
        }),
        { fetchOptions: { signal: AbortSignal.timeout(120_000) } },
      );
    },
  };
  const count = await runMigrations(
    store,
    fileURLToPath(new URL("../../drizzle", import.meta.url)),
  );
  console.log(`Database migrations complete: ${count} applied.`);
}

main().catch(() => {
  // Driver errors may contain connection strings or SQL containing application data.
  console.error(
    "Database migration failed. Inspect database history before retrying. See docs/migrations.md.",
  );
  process.exitCode = 1;
});
