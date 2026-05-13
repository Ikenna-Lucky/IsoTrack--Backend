import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { authenticate } from "@/middleware/auth";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { success, error } from "@/lib/response";

export const notificationsRouter = new Hono();

notificationsRouter.use("*", authenticate);

// ─── GET /notifications — user's notifications ────────────────────────────────

notificationsRouter.get("/", async (c) => {
  const userId = c.get("userId");

  const data = await db.query.notifications.findMany({
    where: eq(notifications.userId, userId),
    orderBy: desc(notifications.createdAt),
    limit: 50,
  });

  return success(c, { data });
});

// ─── PATCH /notifications/read-all — mark all as read ────────────────────────
// NOTE: must be before /:id so "read-all" isn't treated as an id

notificationsRouter.patch("/read-all", async (c) => {
  const userId = c.get("userId");

  await db
    .update(notifications)
    .set({ isRead: true })
    .where(
      and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
    );

  return success(c, { data: null, message: "All notifications marked as read" });
});

// ─── PATCH /notifications/:id/read — mark one as read ────────────────────────

notificationsRouter.patch("/:id/read", async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.param();

  const [notification] = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .limit(1);

  if (!notification) return error(c, "Notification not found", 404);

  await db
    .update(notifications)
    .set({ isRead: true })
    .where(eq(notifications.id, id));

  return success(c, { data: null, message: "Notification marked as read" });
});
