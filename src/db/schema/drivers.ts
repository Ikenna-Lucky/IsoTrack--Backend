import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  jsonb,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { vehicleTypeEnum, driverStatusEnum } from "./enums";
import { users } from "./users";
import { businesses } from "./businesses";
import { shipments } from "./shipments";

export const drivers = pgTable(
  "drivers",
  {
    id: text("id").primaryKey(),
    // Null is reserved for legacy accounts awaiting explicit fleet onboarding.
    businessId: text("business_id").references(() => businesses.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vehicleType: vehicleTypeEnum("vehicle_type").notNull(),
    vehiclePlate: text("vehicle_plate").notNull(),
    vehicleModel: text("vehicle_model"),
    vehicleColor: text("vehicle_color"),
    vehicleYear: text("vehicle_year"),
    vehicleInsurance: text("vehicle_insurance"),
    notificationPreferences: jsonb("notification_preferences"),
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
  },
  (t) => [
    uniqueIndex("drivers_user_id_unique").on(t.userId),
    unique("drivers_id_business_unique").on(t.id, t.businessId),
    index("drivers_business_status_idx").on(t.businessId, t.status),
    index("drivers_user_id_idx").on(t.userId),
    index("drivers_status_idx").on(t.status),
    index("drivers_vehicle_type_idx").on(t.vehicleType),
  ],
);

export const driversRelations = relations(drivers, ({ one, many }) => ({
  user: one(users, {
    fields: [drivers.userId],
    references: [users.id],
  }),
  shipments: many(shipments),
}));

export type Driver = typeof drivers.$inferSelect;
export type NewDriver = typeof drivers.$inferInsert;
