const events = {
  pending: ["shipmentCreated", true], assigned: ["driverAssigned", true],
  picked_up: ["pickedUp", false], out_for_delivery: ["outForDelivery", true],
  delivered: ["delivered", true], failed: ["failed", true],
} as const;

/** Match the defaults returned by GET /business/notifications; unknown events are separate flows. */
export function businessShipmentEmailEnabled(status: string, preferences: unknown): boolean {
  if (!(Object.hasOwn(events, status))) return false;
  const [event, fallback] = events[status as keyof typeof events];
  const value = preferences && typeof preferences === "object"
    ? (preferences as Record<string, unknown>)[event] : undefined;
  const email = value && typeof value === "object" ? (value as Record<string, unknown>).email : undefined;
  return typeof email === "boolean" ? email : fallback;
}
