import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
export const microsoftMailCache = pgTable("microsoft_mail_cache", {
  id: text("id").primaryKey(),
  encryptedCache: text("encrypted_cache"),
  leaseId: uuid("lease_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
