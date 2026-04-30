import { Hono } from "hono";

export const shipmentsRouter = new Hono();

shipmentsRouter.get("/", async (c) =>
  c.json({ message: "GET /shipments (Phase 5)" }, 501),
);
shipmentsRouter.post("/", async (c) =>
  c.json({ message: "POST /shipments (Phase 5)" }, 501),
);
shipmentsRouter.get("/:id", async (c) =>
  c.json({ message: "GET /shipments/:id (Phase 5)" }, 501),
);
shipmentsRouter.patch("/:id/status", async (c) =>
  c.json({ message: "PATCH /shipments/:id/status (Phase 5)" }, 501),
);
shipmentsRouter.patch("/:id/assign", async (c) =>
  c.json({ message: "PATCH /shipments/:id/assign (Phase 5)" }, 501),
);
shipmentsRouter.delete("/:id", async (c) =>
  c.json({ message: "DELETE /shipments/:id (Phase 5)" }, 501),
);
