import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { notificationTypeEnum, notificationStatusEnum } from "./enums";
import { users } from "./users";

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    isRead: boolean("is_read").default(false).notNull(),
    status: notificationStatusEnum("status").default("pending").notNull(),
    metadata: text("metadata"), // Extra context stored as a JSON string.
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("notifications_user_page_idx").on(
      t.userId,
      t.createdAt.desc(),
      sql`${t.id} collate "C" desc`,
    ),
    index("notifications_user_unread_idx")
      .on(t.userId, t.createdAt, sql`${t.id} collate "C"`)
      .where(sql`not ${t.isRead}`),
    index("notifications_user_id_idx").on(t.userId),
    index("notifications_is_read_idx").on(t.isRead),
    index("notifications_created_at_idx").on(t.createdAt),
    index("notifications_cleanup_idx")
      .on(t.createdAt, t.id)
      .where(sql`${t.isRead} and ${t.status}='sent'`),
  ],
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
