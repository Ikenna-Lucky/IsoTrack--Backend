import { nanoid } from "nanoid";
import { db } from "@/db";
import { notifications } from "@/db/schema";

export interface InAppNotificationPayload {
  userId: string;
  title: string;
  message: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Writes a single in-app (push) notification row to the DB.
 * Errors are swallowed — a failed notification must never break the main flow.
 */
export async function createInAppNotification(
  payload: InAppNotificationPayload,
): Promise<void> {
  try {
    await db.insert(notifications).values({
      id:       nanoid(),
      userId:   payload.userId,
      type:     "push",
      title:    payload.title,
      message:  payload.message,
      isRead:   false,
      status:   "sent",
      metadata: payload.metadata ? JSON.stringify(payload.metadata) : null,
    });
  } catch (err) {
    console.error("[Notification] Failed to create in-app notification:", err);
  }
}

/** Milestone → human-readable title + message helpers */
export function shipmentNotificationContent(
  milestone: string,
  trackingId: string,
  driverName?: string,
): { title: string; message: string } {
  const id = trackingId;
  switch (milestone) {
    case "pending":
      return { title: "Shipment created", message: `New shipment ${id} has been created and is awaiting a driver.` };
    case "assigned":
      return { title: "Driver assigned", message: `${driverName ? driverName + " has" : "A driver has"} been assigned to shipment ${id}.` };
    case "picked_up":
      return { title: "Package picked up", message: `Driver has picked up shipment ${id} and is heading to the destination.` };
    case "in_transit":
      return { title: "In transit", message: `Shipment ${id} is now in transit.` };
    case "out_for_delivery":
      return { title: "Out for delivery", message: `Shipment ${id} is out for final delivery.` };
    case "delivered":
      return { title: "Delivered ✓", message: `Shipment ${id} was delivered successfully.` };
    case "failed":
      return { title: "Delivery failed", message: `Delivery attempt for shipment ${id} was unsuccessful.` };
    case "cancelled":
      return { title: "Shipment cancelled", message: `Shipment ${id} has been cancelled.` };
    default:
      return { title: "Shipment updated", message: `Shipment ${id} status changed to ${milestone}.` };
  }
}
