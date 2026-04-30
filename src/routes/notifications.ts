import { Hono } from "hono";

export const notificationsRouter = new Hono();

notificationsRouter.get("/", async (c) =>
  c.json({ message: "GET /notifications (Phase 7)" }, 501),
);
notificationsRouter.patch("/:id/read", async (c) =>
  c.json({ message: "PATCH /notifications/:id/read (Phase 7)" }, 501),
);
notificationsRouter.patch("/read-all", async (c) =>
  c.json({ message: "PATCH /notifications/read-all (Phase 7)" }, 501),
);
