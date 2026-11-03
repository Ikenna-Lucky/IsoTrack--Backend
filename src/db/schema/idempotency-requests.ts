import {
  pgTable,
  text,
  jsonb,
  timestamp,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

export const idempotencyRequests = pgTable(
  "idempotency_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    keyHash: text("key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    parameters: jsonb("parameters"),
    resourceId: text("resource_id").notNull(),
    response: jsonb("response"),
    state: text("state").notNull().default("pending"),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now()+interval '24 hours'`),
    scrubbedAt: timestamp("scrubbed_at", { withTimezone: true }),
  },
  (t) => [
    unique("idempotency_requests_scope").on(t.userId, t.operation, t.keyHash),
    index("idempotency_requests_resource_idx").on(t.resourceId),
    index("idempotency_requests_cleanup_idx")
      .on(t.createdAt)
      .where(sql`${t.scrubbedAt} is null`),
    check(
      "idempotency_requests_operation_check",
      sql`${t.operation} in ('shipments.create','payments.initialize')`,
    ),
    check(
      "idempotency_requests_state_check",
      sql`${t.state} in ('pending','completed')`,
    ),
    check(
      "idempotency_requests_hashes",
      sql`length(${t.keyHash})=64 and length(${t.requestHash})=64`,
    ),
    check(
      "idempotency_requests_lease",
      sql`(${t.leaseToken} is null and ${t.leaseUntil} is null) or (${t.state}='pending' and ${t.leaseToken} is not null and ${t.leaseUntil} is not null)`,
    ),
    check(
      "idempotency_requests_response",
      sql`(${t.state}='completed' and (${t.response} is not null or ${t.scrubbedAt} is not null)) or (${t.state}='pending' and ${t.response} is null)`,
    ),
    check("idempotency_requests_expiry", sql`${t.expiresAt}>${t.createdAt}`),
  ],
);
