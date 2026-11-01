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
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
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
