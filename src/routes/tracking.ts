import { Hono } from "hono";
import { findShipmentByTrackingId } from "@/db/queries/shipments";
import { success, error } from "@/lib/response";

export const trackingRouter = new Hono();

// ─── GET /track/:trackingId — public shipment tracking ────────────────────────
// No auth required — customers track via the link in their email

trackingRouter.get("/:trackingId", async (c) => {
  const { trackingId } = c.req.param();

  const shipment = await findShipmentByTrackingId(trackingId);
  if (!shipment) return error(c, "Shipment not found", 404);

  // Return a safe, public-facing subset — no internal IDs or financials
  return success(c, {
    data: {
      trackingId: shipment.trackingId,
      status: shipment.status,
      description: shipment.description,
      pickupAddress: shipment.pickupAddress,
      deliveryAddress: shipment.deliveryAddress,
      currentLocation: shipment.currentLocation,
      scheduledPickup: shipment.scheduledPickup,
      estimatedDelivery: shipment.estimatedDelivery,
      actualDelivery: shipment.actualDelivery,
      events: shipment.events,
      driver: shipment.driver
        ? {
            name: shipment.driver.user?.name,
            vehicleType: shipment.driver.vehicleType,
            vehiclePlate: shipment.driver.vehiclePlate,
            rating: shipment.driver.rating,
            currentLocation: shipment.driver.currentLocation,
          }
        : null,
    },
  });
});
