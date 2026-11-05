import { Hono } from "hono";
import type { WriteStore } from "../lib/idempotency.ts";
import { publicTrackingStatement } from "../db/queries/public-tracking.ts";
import { publicTrackingView } from "../lib/public-tracking.ts";

export function createPublicTrackingRouter(store: WriteStore) {
  const router = new Hono();
  router.get("/:trackingId", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    const trackingId = c.req.param("trackingId");
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(trackingId) ||
      new URL(c.req.url).searchParams.size
    ) {
      return c.json(
        { success: false, message: "Invalid tracking request" },
        400,
      );
    }
    const [row] = await store.execute(
      publicTrackingStatement(trackingId.toUpperCase()),
    );
    if (!row)
      return c.json({ success: false, message: "Shipment not found" }, 404);
    return c.json({ success: true, data: publicTrackingView(row) });
  });
  return router;
}
