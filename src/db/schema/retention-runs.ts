import { pgTable, text, timestamp, integer, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
export const retentionRuns = pgTable(
  "retention_runs",
  {
    task: text("task").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastAffected: integer("last_affected").notNull().default(0),
  },
  (t) => [
    check(
      "retention_runs_last_affected_check",
      sql`${t.lastAffected} between 0 and 500`,
    ),
  ],
);
