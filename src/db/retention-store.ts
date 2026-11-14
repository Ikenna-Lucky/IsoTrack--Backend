import { PgDialect } from "drizzle-orm/pg-core";
import { database } from "./index";
import type { WriteStore } from "../lib/idempotency";
const dialect = new PgDialect();
export const retentionStore: WriteStore = {
  execute: async (statement) => {
    const query = dialect.sqlToQuery(statement);
    // Server deadlines remain effective even if the HTTP caller disconnects.
    const results = await database.transaction(
      [
        { text: "set local lock_timeout='1s'" },
        { text: "set local statement_timeout='5s'" },
        { text: query.sql, params: query.params },
      ],
      { signal: AbortSignal.timeout(8000) },
    );
    return results[2]!.map((row) => row.result as Record<string, unknown>);
  },
};
