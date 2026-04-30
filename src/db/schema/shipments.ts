import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  integer,
  real,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users";
import { businesses } from "./businesses";
import { drivers } from "./drivers";
import { shipmentEvents } from "./shipment-events";
import { payments } from "./payments";

export const shipmentStatusEnum = pgEnum("shipment_status", [
  "pending",
  "assigned",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "failed",
  "cancelled",
]);

export const shipments = pgTable("shipments", {
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

  // Locations (stored as JSONB for flexibility)
  pickupAddress: jsonb("pickup_address").notNull(),
  deliveryAddress: jsonb("delivery_address").notNull(),
  currentLocation: jsonb("current_location"), // { lat, lng } — updated in real time

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
});

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
