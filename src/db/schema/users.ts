import { pgTable, text, timestamp, pgEnum, boolean } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { businesses } from "./businesses";
import { drivers } from "./drivers";
import { notifications } from "./notifications";

export const userRoleEnum = pgEnum("user_role", [
  "business",
  "driver",
  "customer",
]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: userRoleEnum("role").notNull(),
  phone: text("phone"),
  avatar: text("avatar"),
  isEmailVerified: boolean("is_email_verified").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  business: one(businesses, {
    fields: [users.id],
    references: [businesses.userId],
  }),
  driver: one(drivers, {
    fields: [users.id],
    references: [drivers.userId],
  }),
  notifications: many(notifications),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
