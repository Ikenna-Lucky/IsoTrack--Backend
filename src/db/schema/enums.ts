import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
  "business",
  "driver",
  "customer",
]);

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

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "success",
  "failed",
  "refunded",
]);
