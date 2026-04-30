import { Hono } from "hono";

export const paymentsRouter = new Hono();

paymentsRouter.post("/initialize", async (c) =>
  c.json({ message: "POST /payments/initialize (Phase 8)" }, 501),
);
paymentsRouter.post("/webhook", async (c) =>
  c.json({ message: "POST /payments/webhook (Phase 8)" }, 501),
);
paymentsRouter.get("/verify/:reference", async (c) =>
  c.json({ message: "GET /payments/verify/:reference (Phase 8)" }, 501),
);
