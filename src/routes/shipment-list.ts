import { Hono } from "hono";
import { z } from "zod";
import { WriteError, type WriteStore } from "../lib/idempotency.ts";
import { parseShipmentPage, shipmentCursor } from "../lib/shipment-page.ts";
import { shipmentPageStatement } from "../db/queries/shipment-page.ts";

const rowSchema = z.object({
  shipment: z.object({ id: z.string(), created_at: z.string() }).passthrough(),
  time: z.string(),
  customer: z.record(z.unknown()).nullable(),
  driver: z.record(z.unknown()).nullable(),
  events: z.array(z.record(z.unknown())),
});
function camel(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}
export function createShipmentListRouter(store: WriteStore) {
  const router = new Hono();
  router.get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const userId = c.get("userId"),
        role = c.get("userRole");
      if (!userId)
        throw new WriteError(401, "UNAUTHORIZED", "Authentication required");
      if (!["business", "driver", "customer"].includes(role))
        throw new WriteError(403, "FORBIDDEN", "Unsupported role");
      const actor = { userId, role };
      const page = parseShipmentPage(new URL(c.req.url).searchParams, actor);
      const rows = z
        .array(rowSchema)
        .parse(await store.execute(shipmentPageStatement(actor, page)));
      const hasMore = rows.length > page.limit;
      const visible = rows.slice(0, page.limit);
      const last = visible.at(-1);
      return c.json({
        success: true,
        data: visible.map((row) => ({
          ...camel(row.shipment),
          customer: row.customer,
          driver: row.driver,
          events: row.events.map(camel),
        })),
        pagination: {
          limit: page.limit,
          hasMore,
          nextCursor:
            hasMore && last
              ? shipmentCursor(page.scope, last.time, last.shipment.id)
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
  return router;
}
