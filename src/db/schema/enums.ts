import { pgEnum } from "drizzle-orm/pg-core";

// ─── User ─────────────────────────────────────────────────────────────────────
export const userRoleEnum = pgEnum("user_role", [
  "business",
  "driver",
  "customer",
]);

// ─── Driver ───────────────────────────────────────────────────────────────────
export const vehicleTypeEnum = pgEnum("vehicle_type", [
  "bike",
  "car",
  "van",
  "truck",
]);
export const driverStatusEnum = pgEnum("driver_status", [
  "available",
  "on_delivery",
  "offline",
]);

// ─── Shipment ─────────────────────────────────────────────────────────────────
export const shipmentStatusEnum = pgEnum("shipment_status", [
  "pending",
  "assigned",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "failed",
  "cancelled",
]);

// ─── Notification ─────────────────────────────────────────────────────────────
export const notificationTypeEnum = pgEnum("notification_type", [
  "email",
  "sms",
  "push",
]);
export const notificationStatusEnum = pgEnum("notification_status", [
  "pending",
  "sent",
  "failed",
]);

// ─── Payment ──────────────────────────────────────────────────────────────────
export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "success",
  "failed",
  "refunded",
]);
