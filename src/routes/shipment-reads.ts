import { Hono } from "hono";
import {
  businessAnalyticsStatement,
  shipmentDetailStatement,
} from "../db/queries/shipment-reads.ts";
import type { WriteStore } from "../lib/idempotency.ts";

export function createShipmentDetailRouter(store: WriteStore) {
  const router = new Hono();
  router.get("/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const userId = c.get("userId"),
      role = c.get("userRole");
    if (!userId)
      return c.json(
        { success: false, message: "Authentication required" },
        401,
      );
    if (!["business", "driver", "customer"].includes(role))
      return c.json({ success: false, message: "Forbidden" }, 403);
    const [data] = await store.execute(
      shipmentDetailStatement({ userId, role }, c.req.param("id")),
    );
    if (!data)
      return c.json({ success: false, message: "Shipment not found" }, 404);
    return c.json({ success: true, data });
  });
  return router;
}
export function createBusinessAnalyticsRouter(store: WriteStore) {
  const router = new Hono();
  router.get("/analytics", async (c) => {
    c.header("Cache-Control", "no-store");
    const userId = c.get("userId"),
      role = c.get("userRole");
    if (!userId)
      return c.json(
        { success: false, message: "Authentication required" },
        401,
      );
    if (role !== "business")
      return c.json({ success: false, message: "Forbidden" }, 403);
    const [data] = await store.execute(
      businessAnalyticsStatement({ userId, role }),
    );
    if (!data) return c.json({ success: false, message: "Forbidden" }, 403);
    // PostgreSQL sums are strings until checked; never silently round money.
    for (const key of ["totalShipments", "totalRevenueKobo"]) {
      const value = Number(data[key]);
      if (!Number.isSafeInteger(value))
        throw new Error("Analytics total exceeds safe integer range");
      data[key] = value;
    }
    return c.json({ success: true, data });
  });
  return router;
}
