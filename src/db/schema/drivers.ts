import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  integer,
  real,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users";
import { shipments } from "./shipments";

export const vehicleTypeEnum = pgEnum("vehicle_type", [
  "bike",
  "car",
  "van",
  "truck",
]);
export const driverStatusEnum = pgEnum("driver_status", [
  "available",
  "on_delivery",
  "offline",
]);

export const drivers = pgTable("drivers", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  vehicleType: vehicleTypeEnum("vehicle_type").notNull(),
  vehiclePlate: text("vehicle_plate").notNull(),
  status: driverStatusEnum("status").default("offline").notNull(),
  currentLocation: jsonb("current_location"), // { lat, lng }
  rating: real("rating").default(5.0).notNull(),
  totalDeliveries: integer("total_deliveries").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const driversRelations = relations(drivers, ({ one, many }) => ({
  user: one(users, {
    fields: [drivers.userId],
    references: [users.id],
  }),
  shipments: many(shipments),
}));

export type Driver = typeof drivers.$inferSelect;
export type NewDriver = typeof drivers.$inferInsert;
