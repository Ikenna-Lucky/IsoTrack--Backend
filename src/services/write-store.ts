import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "@/db";
import type { WriteStore } from "@/lib/idempotency";

const dialect = new PgDialect();
export const writeStore: WriteStore = {
  execute: async (statement) => {
    const query = dialect.sqlToQuery(statement);
    const result = await db.$client(query.sql, query.params, {
      fullResults: true,
      arrayMode: false,
      fetchOptions: { signal: AbortSignal.timeout(5000) },
    });
    return result.rows.map((row) => row.result as Record<string, unknown>);
  },
};
