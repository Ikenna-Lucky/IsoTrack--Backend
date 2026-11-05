import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  boolean,
  jsonb,
  index,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { shipmentStatusEnum } from "./enums";
import { users } from "./users";
import { businesses } from "./businesses";
import { drivers } from "./drivers";
import { shipmentEvents } from "./shipment-events";
import { payments } from "./payments";

export const shipments = pgTable(
  "shipments",
  {
    id: text("id").primaryKey(),
    trackingId: text("tracking_id").notNull().unique(),
    status: shipmentStatusEnum("status").default("pending").notNull(),
    version: integer("version").default(0).notNull(),
    recipientEmail: text("recipient_email"),
    failureReason: text("failure_reason"),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    attemptNumber: integer("attempt_number").notNull().default(1),
    returnState: text("return_state").notNull().default("none"),
    returnedAt: timestamp("returned_at", { withTimezone: true }),

    // Parties
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    driverId: text("driver_id").references(() => drivers.id, {
      onDelete: "set null",
    }),
    customerId: text("customer_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // Package info
    description: text("description").notNull(),
    weightKg: real("weight_kg").notNull(),
    dimensions: jsonb("dimensions"), // { length, width, height }

    // Locations
    pickupAddress: jsonb("pickup_address").notNull(),
    deliveryAddress: jsonb("delivery_address").notNull(),
    currentLocation: jsonb("current_location"), // { lat, lng } — live updated

    // Timestamps
    scheduledPickup: timestamp("scheduled_pickup", { withTimezone: true }),
    actualPickup: timestamp("actual_pickup", { withTimezone: true }),
    estimatedDelivery: timestamp("estimated_delivery", { withTimezone: true }),
    actualDelivery: timestamp("actual_delivery", { withTimezone: true }),

    // Financials (amounts in kobo — smallest NGN unit)
    priceKobo: integer("price_kobo").notNull(),
    isPaid: boolean("is_paid").default(false).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("shipments_gps_cleanup_idx")
      .on(
        sql`(case when ${t.status}='delivered' then ${t.actualDelivery}
      when ${t.status}='cancelled' then ${t.updatedAt} when ${t.status}='failed' and ${t.returnState}='received' then ${t.returnedAt} end)`,
        t.id,
      )
      .where(sql`${t.currentLocation} is not null`),
    check("shipments_version_check", sql`${t.version} >= 0`),
    check(
      "shipments_attempt_number_check",
      sql`${t.attemptNumber} between 1 and 3`,
    ),
    check(
      "shipments_return_state_check",
      sql`${t.returnState} in ('none','requested','in_transit','received')`,
    ),
    check(
      "shipments_failure_reason_check",
      sql`${t.failureReason} is null or ${t.failureReason} in ('recipient_unavailable','recipient_refused','address_incorrect','recipient_code_unavailable','package_damaged','vehicle_issue','other')`,
    ),
    check(
      "shipments_return_custody_check",
      sql`${t.returnState}='none' or (${t.status}='failed' and ${t.actualPickup} is not null)`,
    ),
    check(
      "shipments_return_receipt_check",
      sql`(${t.returnState}='received')=(${t.returnedAt} is not null)`,
    ),
    foreignKey({
      name: "shipments_driver_business_fk",
      columns: [t.driverId, t.businessId],
      foreignColumns: [drivers.id, drivers.businessId],
    }).onDelete("restrict"),
    index("shipments_tracking_id_idx").on(t.trackingId),
    index("shipments_business_id_idx").on(t.businessId),
    index("shipments_driver_id_idx").on(t.driverId),
    index("shipments_customer_id_idx").on(t.customerId),
    index("shipments_status_idx").on(t.status),
    index("shipments_created_at_idx").on(t.createdAt),
    index("shipments_held_packages_idx")
      .on(sql`coalesce(${t.failedAt},${t.createdAt})`)
      .where(
        sql`${t.status}='failed' and ${t.actualPickup} is not null and ${t.returnState}<>'received'`,
      ),
    index("shipments_business_page_idx").on(
      t.businessId,
      t.createdAt.desc(),
      sql`${t.id} collate "C" desc`,
    ),
    index("shipments_customer_page_idx").on(
      t.customerId,
      t.createdAt.desc(),
      sql`${t.id} collate "C" desc`,
    ),
    index("shipments_driver_page_idx").on(
      t.driverId,
      t.businessId,
      t.createdAt.desc(),
      sql`${t.id} collate "C" desc`,
    ),
    index("shipments_driver_active_page_idx")
      .on(
        t.driverId,
        t.businessId,
        t.createdAt.desc(),
        sql`${t.id} collate "C" desc`,
      )
      .where(
        sql`${t.status} not in ('delivered','failed','cancelled') or (${t.status}='failed' and ${t.actualPickup} is not null and ${t.returnState}<>'received')`,
      ),
  ],
);

export const shipmentsRelations = relations(shipments, ({ one, many }) => ({
  business: one(businesses, {
    fields: [shipments.businessId],
    references: [businesses.id],
  }),
  driver: one(drivers, {
    fields: [shipments.driverId],
    references: [drivers.id],
  }),
  customer: one(users, {
    fields: [shipments.customerId],
    references: [users.id],
  }),
  events: many(shipmentEvents),
  payment: one(payments, {
    fields: [shipments.id],
    references: [payments.shipmentId],
  }),
}));

export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;
