import {
  pgTable,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { shipments } from "./shipments";
import { users } from "./users";

export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: text("id").primaryKey(),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("notification_outbox_due_idx").on(t.state, t.availableAt),
    index("notification_outbox_lease_idx").on(t.state, t.leaseUntil),
    index("notification_outbox_completed_idx").on(t.completedAt),
    index("notification_outbox_shipment_idx").on(t.shipmentId),
    index("notification_outbox_recipient_idx").on(t.recipientId),
    check(
      "notification_outbox_channel_check",
      sql`${t.channel} in ('in_app','email')`,
    ),
    check(
      "notification_outbox_kind_check",
      sql`${t.kind} in ('shipment_status','payment_confirmed')`,
    ),
    check(
      "notification_outbox_state_check",
      sql`${t.state} in ('pending','processing','delivered','skipped','dead')`,
    ),
    check(
      "notification_outbox_attempts_check",
      sql`${t.attempts} >= 0 and ${t.attempts} <= 5`,
    ),
    check(
      "notification_outbox_lease",
      sql`(${t.state} = 'processing' and ${t.leaseToken} is not null and ${t.leaseUntil} is not null) or (${t.state} <> 'processing' and ${t.leaseToken} is null and ${t.leaseUntil} is null)`,
    ),
  ],
);
