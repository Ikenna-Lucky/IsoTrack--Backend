import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { shipments, shipmentStatusEnum } from "./shipments";

export const shipmentEvents = pgTable("shipment_events", {
  id: text("id").primaryKey(),
  shipmentId: text("shipment_id")
    .notNull()
    .references(() => shipments.id, { onDelete: "cascade" }),
  status: shipmentStatusEnum("status").notNull(),
  message: text("message").notNull(),
  location: jsonb("location"), // { lat, lng }
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const shipmentEventsRelations = relations(shipmentEvents, ({ one }) => ({
  shipment: one(shipments, {
    fields: [shipmentEvents.shipmentId],
    references: [shipments.id],
  }),
}));

export type ShipmentEvent = typeof shipmentEvents.$inferSelect;
export type NewShipmentEvent = typeof shipmentEvents.$inferInsert;
