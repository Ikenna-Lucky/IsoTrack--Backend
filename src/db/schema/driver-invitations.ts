import { pgTable, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { businesses } from "./businesses";

export const driverInvitations = pgTable(
  "driver_invitations",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("driver_invitations_business_created_idx").on(
      t.businessId,
      t.createdAt,
    ),
    index("driver_invitations_cleanup_idx")
      .on(t.expiresAt, t.id)
      .where(sql`${t.acceptedAt} is null`),
    check(
      "driver_invitations_terminal_state",
      sql`${t.acceptedAt} is null or ${t.revokedAt} is null`,
    ),
    check("driver_invitations_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
