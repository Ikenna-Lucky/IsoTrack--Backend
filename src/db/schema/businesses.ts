import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users";
import { shipments } from "./shipments";

export const businesses = pgTable("businesses", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  businessName: text("business_name").notNull(),
  logo: text("logo"),
  address: jsonb("address"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const businessesRelations = relations(businesses, ({ one, many }) => ({
  user: one(users, {
    fields: [businesses.userId],
    references: [users.id],
  }),
  shipments: many(shipments),
}));

export type Business = typeof businesses.$inferSelect;
export type NewBusiness = typeof businesses.$inferInsert;
