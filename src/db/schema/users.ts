import { pgTable, text, timestamp, boolean, index, integer } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { userRoleEnum } from "./enums";
import { businesses } from "./businesses";
import { drivers } from "./drivers";
import { notifications } from "./notifications";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    credentialVersion: integer("credential_version").default(0).notNull(),
    name: text("name").notNull(),
    role: userRoleEnum("role").notNull(),
    phone: text("phone"),
    avatar: text("avatar"),
    emergencyContact: text("emergency_contact"),
    isEmailVerified: boolean("is_email_verified").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("users_email_idx").on(t.email),
    index("users_role_idx").on(t.role),
  ],
);

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
