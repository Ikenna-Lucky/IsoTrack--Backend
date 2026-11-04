import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { shipments } from "./shipments";
import { drivers } from "./drivers";
export const deliveryConfirmations = pgTable(
  "delivery_confirmations",
  {
    id: text("id").primaryKey(),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    driverId: text("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "restrict" }),
    shipmentVersion: integer("shipment_version").notNull(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    failures: integer("failures").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
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
    index("delivery_confirmations_shipment_idx").on(
      t.shipmentId,
      t.createdAt.desc(),
    ),
    index("delivery_confirmations_due_idx")
      .on(t.availableAt)
      .where(sql`${t.deliveryState}='pending'`),
    index("delivery_confirmations_lease_idx")
      .on(t.leaseUntil)
      .where(sql`${t.deliveryState}='processing'`),
    index("delivery_confirmations_dead_idx")
      .on(t.availableAt)
      .where(sql`${t.deliveryState}='dead'`),
    index("delivery_confirmations_expiry_idx").on(t.expiresAt),
    uniqueIndex("delivery_confirmations_active_idx")
      .on(t.shipmentId)
      .where(sql`${t.consumedAt} is null and ${t.revokedAt} is null`),
    check(
      "delivery_confirmations_shipment_version_check",
      sql`${t.shipmentVersion}>=0`,
    ),
    check(
      "delivery_confirmations_code_hash_check",
      sql`length(${t.codeHash})=64`,
    ),
    check(
      "delivery_confirmations_failures_check",
      sql`${t.failures} between 0 and 5`,
    ),
    check(
      "delivery_confirmations_attempts_check",
      sql`${t.attempts} between 0 and 5`,
    ),
    check(
      "delivery_confirmations_delivery_state_check",
      sql`${t.deliveryState} in ('pending','processing','sent','skipped','dead')`,
    ),
    check("delivery_confirmation_expiry", sql`${t.expiresAt}>${t.createdAt}`),
    check(
      "delivery_confirmation_lease",
      sql`(${t.deliveryState}='processing' and ${t.leaseToken} is not null and ${t.leaseUntil} is not null) or (${t.deliveryState}<>'processing' and ${t.leaseToken} is null and ${t.leaseUntil} is null)`,
    ),
  ],
);
