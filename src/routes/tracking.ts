import { Hono } from "hono";

export const trackingRouter = new Hono();

// Public route — no auth required
// GET /api/v1/track/:trackingId
trackingRouter.get("/:trackingId", async (c) => {
  return c.json({ message: "GET /track/:trackingId (Phase 6)" }, 501);
});
