import { Hono } from "hono";

export const driversRouter = new Hono();

driversRouter.get("/", async (c) =>
  c.json({ message: "GET /drivers (Phase 5)" }, 501),
);
driversRouter.get("/available", async (c) =>
  c.json({ message: "GET /drivers/available (Phase 5)" }, 501),
);
driversRouter.get("/:id", async (c) =>
  c.json({ message: "GET /drivers/:id (Phase 5)" }, 501),
);
driversRouter.patch("/:id/status", async (c) =>
  c.json({ message: "PATCH /drivers/:id/status (Phase 6)" }, 501),
);
driversRouter.patch("/:id/location", async (c) =>
  c.json({ message: "PATCH /drivers/:id/location (Phase 6)" }, 501),
);
