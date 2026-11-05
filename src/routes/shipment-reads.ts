import { Hono } from "hono";
import {
  businessAnalyticsStatement,
  shipmentDetailStatement,
  shipmentEventsStatement,
} from "../db/queries/shipment-reads.ts";
import { WriteError, type WriteStore } from "../lib/idempotency.ts";
import {
  parseShipmentEventPage,
  shipmentCursor,
} from "../lib/shipment-page.ts";
import { z } from "zod";

const historySchema = z.object({
  events: z.array(
    z.object({
      event: z.object({ id: z.string() }).passthrough(),
      time: z.string(),
    }),
  ),
});

export function createShipmentDetailRouter(store: WriteStore) {
  const router = new Hono();
  router.get("/:id/events", async (c) => {
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
    try {
      const actor = { userId, role };
      const page = parseShipmentEventPage(
        new URL(c.req.url).searchParams,
        actor,
        c.req.param("id"),
      );
      const [row] = await store.execute(
        shipmentEventsStatement(actor, c.req.param("id"), page),
      );
      if (!row)
        return c.json({ success: false, message: "Shipment not found" }, 404);
      const rows = historySchema.parse(row).events;
      const hasMore = rows.length > page.limit;
      const visible = rows.slice(0, page.limit);
      const last = visible.at(-1);
      return c.json({
        success: true,
        data: visible.map((row) => row.event),
        pagination: {
          limit: page.limit,
          hasMore,
          nextCursor:
            hasMore && last
              ? shipmentCursor(page.scope, last.time, last.event.id)
              : null,
        },
      });
    } catch (error) {
      if (error instanceof WriteError)
        return c.json(
          { success: false, error: error.code, message: error.message },
          error.status,
        );
      throw error;
    }
  });
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
