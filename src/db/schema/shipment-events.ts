import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { shipmentStatusEnum } from "./enums";
import { shipments } from "./shipments";

export const shipmentEvents = pgTable(
  "shipment_events",
  {
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
  },
  (t) => [
    index("shipment_events_shipment_id_idx").on(t.shipmentId),
    index("shipment_events_created_at_idx").on(t.createdAt),
  ],
);

export const shipmentEventsRelations = relations(shipmentEvents, ({ one }) => ({
  shipment: one(shipments, {
    fields: [shipmentEvents.shipmentId],
    references: [shipments.id],
  }),
}));

export type ShipmentEvent = typeof shipmentEvents.$inferSelect;
export type NewShipmentEvent = typeof shipmentEvents.$inferInsert;
