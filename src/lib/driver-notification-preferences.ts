export const DRIVER_NOTIFICATION_DEFAULTS = {
  newDelivery: { push: true, email: true },
  pickupReminder: { push: true, email: false },
  deliveryComplete: { push: true, email: true },
  deliveryFailed: { push: true, email: true },
  customerMessage: { push: true, email: false },
  ratingReceived: { push: true, email: false },
  payoutProcessed: { push: true, email: true },
  weeklyReport: { push: false, email: true },
};
const shipmentEvents = {
  assigned: "newDelivery",
  delivered: "deliveryComplete",
  failed: "deliveryFailed",
} as const;
/** The legacy push field controls dashboard inbox delivery, not browser push. */
export function driverShipmentNotificationEnabled(
  status: string,
  channel: "in_app" | "email",
  preferences: unknown,
) {
  if (!Object.hasOwn(shipmentEvents, status)) return false;
  const event = shipmentEvents[status as keyof typeof shipmentEvents];
  const field = channel === "in_app" ? "push" : "email";
  const value =
    preferences && typeof preferences === "object"
      ? (preferences as Record<string, unknown>)[event]
      : undefined;
  const choice =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)[field]
      : undefined;
  return typeof choice === "boolean"
    ? choice
    : DRIVER_NOTIFICATION_DEFAULTS[event][field];
}
