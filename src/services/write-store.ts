import { PgDialect } from "drizzle-orm/pg-core";
import { database } from "@/db";
import type { WriteStore } from "@/lib/idempotency";

const dialect = new PgDialect();
export const writeStore: WriteStore = {
  execute: async (statement) => {
    const query = dialect.sqlToQuery(statement);
    const result = await database.query(query.sql, query.params, {
      signal: AbortSignal.timeout(5000),
    });
    return result.map((row) => row.result as Record<string, unknown>);
  },
};
