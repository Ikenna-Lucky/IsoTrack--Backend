import { z } from "zod";

const publicStatusMessages = {
  pending: "Shipment created",
  assigned: "Driver assigned",
  picked_up: "Shipment picked up",
  in_transit: "Shipment in transit",
  out_for_delivery: "Shipment out for delivery",
  delivered: "Shipment delivered",
  failed: "Delivery attempt unsuccessful",
  cancelled: "Shipment cancelled",
} as const;
const status = z.enum([
  "pending",
  "assigned",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "failed",
  "cancelled",
]);
const publicRecord = z.object({
  trackingId: z.string(),
  status,
  scheduledPickup: z.string().nullable(),
  estimatedDelivery: z.string().nullable(),
  actualDelivery: z.string().nullable(),
  events: z.array(z.object({ status, createdAt: z.string() })).max(21),
});

export function publicTrackingView(input: unknown) {
  const shipment = publicRecord.parse(input);
  return {
    trackingId: shipment.trackingId,
    status: shipment.status,
    scheduledPickup: shipment.scheduledPickup,
    estimatedDelivery: shipment.estimatedDelivery,
    actualDelivery: shipment.actualDelivery,
    events: shipment.events
      .slice(0, 20)
      .map((event) => ({
        status: event.status,
        createdAt: event.createdAt,
        message: publicStatusMessages[event.status],
      })),
    eventsTruncated: shipment.events.length > 20,
  };
}
