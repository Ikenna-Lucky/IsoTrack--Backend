import { createDatabaseTransport } from "./transport.ts";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migration-runner.ts";

async function main(): Promise<void> {
  const client = createDatabaseTransport(process.env);
  const dialect = new PgDialect();
  const store = {
    execute: async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      return client.query(query.sql, query.params, {
        timeoutMs: 120_000,
      });
    },
    transaction: async (statements: SQL[]) => {
      await client.transaction(
        statements.map((statement) => {
          const query = dialect.sqlToQuery(statement);
          return { text: query.sql, params: query.params };
        }),
        { timeoutMs: 120_000 },
      );
    },
  };
  try {
    const count = await runMigrations(
      store,
      fileURLToPath(new URL("../../drizzle", import.meta.url)),
    );
    console.log(`Database migrations complete: ${count} applied.`);
  } finally {
    await client.close();
  }
}

main().catch(() => {
  // Driver errors may contain connection strings or SQL containing application data.
  console.error(
    "Database migration failed. Inspect database history before retrying. See docs/migrations.md.",
  );
  process.exitCode = 1;
});
