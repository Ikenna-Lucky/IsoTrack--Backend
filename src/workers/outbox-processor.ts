import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { SQL } from "drizzle-orm";
import {
  claimOutboxStatement,
  outboxContextStatement,
  completeInAppStatement,
  completeOutboxStatement,
  failOutboxStatement,
} from "../db/queries/outbox.ts";

export interface OutboxStore {
  execute: (statement: SQL) => Promise<Record<string, unknown>[]>;
}
const contextSchema = z.object({
  name: z.string(),
  email: z.string(),
  kind: z.enum(["shipment_status", "payment_confirmed"]),
  channel: z.enum(["in_app", "email"]),
  payload: z.object({
    trackingId: z.string(),
    status: z.enum([
      "pending",
      "assigned",
      "picked_up",
      "in_transit",
      "out_for_delivery",
      "delivered",
      "failed",
      "cancelled",
      "paid",
      "delivery_retry",
      "return_requested",
      "return_in_transit",
      "return_received",
    ]),
    amountKobo: z.number().int().nonnegative(),
  }),
});
export interface NotificationEmail {
  eventId: string;
  to: string;
  name: string;
  trackingId: string;
  title: string;
  message: string;
}
const titles: Record<string, string> = {
  pending: "Shipment created",
  assigned: "Driver assigned",
  picked_up: "Package picked up",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Shipment delivered",
  failed: "Delivery failed",
  cancelled: "Shipment cancelled",
  paid: "Payment confirmed",
  delivery_retry: "Another delivery attempt authorized",
  return_requested: "Return to business requested",
  return_in_transit: "Package returning to business",
  return_received: "Business received returned package",
};

export function outboxJobId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export function createOutboxProcessor(
  store: OutboxStore,
  sendEmail: (email: NotificationEmail) => Promise<void>,
) {
  return async (id: string) => {
    const token = randomUUID();
    if (!(await store.execute(claimOutboxStatement(id, token))).length) return;
    try {
      const row = (await store.execute(outboxContextStatement(id, token)))[0];
      if (!row) {
        await store.execute(completeOutboxStatement(id, token, true));
        return;
      }
      const context = contextSchema.parse(row);
      const title = titles[context.payload.status]!;
      const amount = new Intl.NumberFormat("en-NG", {
        style: "currency",
        currency: "NGN",
      }).format(context.payload.amountKobo / 100);
      const message =
        context.kind === "payment_confirmed"
          ? `Payment of ${amount} for shipment ${context.payload.trackingId} has been confirmed.`
          : `Shipment ${context.payload.trackingId}: ${title.toLowerCase()}.`;
      if (context.channel === "in_app") {
        await store.execute(completeInAppStatement(id, token, title, message));
      } else {
        await sendEmail({
          eventId: id,
          to: z.string().email().parse(context.email),
          name: context.name,
          trackingId: context.payload.trackingId,
          title,
          message,
        });
        if (!(await store.execute(completeOutboxStatement(id, token))).length)
          throw new Error("Lease lost after delivery");
      }
    } catch {
      // Persist a stable diagnostic code; provider errors may contain addresses.
      await store.execute(failOutboxStatement(id, token));
      throw new Error("Notification delivery failed");
    }
  };
}
