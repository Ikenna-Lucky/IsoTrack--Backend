import { Hono } from "hono";

export const businessRouter = new Hono();

businessRouter.get("/profile", async (c) =>
  c.json({ message: "GET /business/profile (Phase 5)" }, 501),
);
businessRouter.patch("/profile", async (c) =>
  c.json({ message: "PATCH /business/profile (Phase 5)" }, 501),
);
businessRouter.get("/analytics", async (c) =>
  c.json({ message: "GET /business/analytics (Phase 5)" }, 501),
);
