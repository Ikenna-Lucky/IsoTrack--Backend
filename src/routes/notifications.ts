import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { authenticate } from "@/middleware/auth";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { success, error } from "@/lib/response";

export const notificationsRouter = new Hono();

notificationsRouter.use("*", authenticate);

// GET /notifications — current user's notifications, newest first (max 50)
notificationsRouter.get("/", async (c) => {
  const userId = c.get("userId" as never) as string;

  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(50);

  return success(c, { data: rows });
});

// PATCH /notifications/read-all — mark every unread notification as read
notificationsRouter.patch("/read-all", async (c) => {
  const userId = c.get("userId" as never) as string;

  await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

  return success(c, { data: null, message: "All notifications marked as read" });
});

// PATCH /notifications/:id/read — mark a single notification as read
notificationsRouter.patch("/:id/read", async (c) => {
  const userId = c.get("userId" as never) as string;
  const { id }  = c.req.param();

  const [existing] = await db
    .select({ id: notifications.id, userId: notifications.userId })
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1);

  if (!existing)            return error(c, "Notification not found", 404);
  if (existing.userId !== userId) return error(c, "Forbidden", 403);

  const [updated] = await db
    .update(notifications)
    .set({ isRead: true })
    .where(eq(notifications.id, id))
    .returning();

  return success(c, { data: updated });
});

// DELETE /notifications/:id — remove a single notification
notificationsRouter.delete("/:id", async (c) => {
  const userId = c.get("userId" as never) as string;
  const { id }  = c.req.param();

  const [existing] = await db
    .select({ id: notifications.id, userId: notifications.userId })
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1);

  if (!existing)            return error(c, "Notification not found", 404);
  if (existing.userId !== userId) return error(c, "Forbidden", 403);

  await db.delete(notifications).where(eq(notifications.id, id));
  return success(c, { data: null, message: "Notification deleted" });
});
