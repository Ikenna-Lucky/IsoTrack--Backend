import type { findShipmentByTrackingId } from "@/db/queries/shipments";

type TrackedShipment = NonNullable<
  Awaited<ReturnType<typeof findShipmentByTrackingId>>
>;

export function publicTrackingView(shipment: TrackedShipment) {
  return {
    trackingId: shipment.trackingId,
    status: shipment.status,
    description: shipment.description,
    pickupAddress: shipment.pickupAddress,
    deliveryAddress: shipment.deliveryAddress,
    // Public links retain their response shape, without exposing live GPS.
    currentLocation: null,
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
          currentLocation: null,
        }
      : null,
  };
}
