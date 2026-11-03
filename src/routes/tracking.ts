import { Hono } from "hono";
import { findShipmentByTrackingId } from "@/db/queries/shipments";
import { success, error } from "@/lib/response";
import { publicTrackingView } from "@/lib/public-tracking";

export const trackingRouter = new Hono();

// ─── GET /track/:trackingId — public shipment tracking ────────────────────────
// No auth required — customers track via the link in their email

trackingRouter.get("/:trackingId", async (c) => {
  const { trackingId } = c.req.param();

  const shipment = await findShipmentByTrackingId(trackingId);
  if (!shipment) return error(c, "Shipment not found", 404);

  c.header("Cache-Control", "no-store");
  return success(c, { data: publicTrackingView(shipment) });
});
