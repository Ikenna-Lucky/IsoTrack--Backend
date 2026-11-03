import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

export const accountActions = pgTable(
  "account_actions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    email: text("email").notNull(),
    credentialVersion: integer("credential_version").notNull(),
    tokenHash: text("token_hash"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveryState: text("delivery_state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
  },
  (t) => [
    index("account_actions_user_idx").on(t.userId),
    index("account_actions_due_idx")
      .on(t.availableAt)
      .where(sql`${t.deliveryState}='pending'`),
    index("account_actions_lease_idx")
      .on(t.leaseUntil)
      .where(sql`${t.deliveryState}='processing'`),
    index("account_actions_expiry_idx").on(t.expiresAt),
    check(
      "account_actions_purpose_check",
      sql`${t.purpose} in ('reset_password','verify_email','password_changed')`,
    ),
    check(
      "account_actions_delivery_state_check",
      sql`${t.deliveryState} in ('pending','processing','sent','skipped','dead')`,
    ),
    check("account_actions_attempts_check", sql`${t.attempts} between 0 and 5`),
    check("account_action_expiry", sql`${t.expiresAt}>${t.createdAt}`),
    check(
      "account_action_token",
      sql`(${t.purpose}='password_changed' and ${t.tokenHash} is null) or (${t.purpose}<>'password_changed' and ${t.tokenHash} is not null and length(${t.tokenHash})=64)`,
    ),
    check(
      "account_action_lease",
      sql`(${t.deliveryState}='processing' and ${t.leaseToken} is not null and ${t.leaseUntil} is not null) or (${t.deliveryState}<>'processing' and ${t.leaseToken} is null and ${t.leaseUntil} is null)`,
    ),
  ],
);
export const accountActionLimits = pgTable(
  "account_action_limits",
  {
    key: text("key").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("account_action_limits_count_check", sql`${t.count}>0`),
    index("account_action_limits_cleanup_idx").on(t.windowStart),
  ],
);
