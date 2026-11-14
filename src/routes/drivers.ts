import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { DRIVER_NOTIFICATION_DEFAULTS as DEFAULT_NOTIF_PREFS } from "../lib/driver-notification-preferences";
import { eq, sql } from "drizzle-orm";
import { authenticate, requireRole } from "@/middleware/auth";
import {
  findDriverById,
  findDriverByUserId,
  updateDriverStatus,
  updateDriverLocation,
} from "@/db/queries/drivers";
import { db } from "@/db";
import { drivers } from "@/db/schema";
import { sanitizeUser } from "@/db/queries/users";
import { success, error } from "@/lib/response";
import { createCollectionRouter } from "./collections";
import { writeStore } from "../services/write-store";

export const driversRouter = new Hono();

driversRouter.use("*", authenticate);

const statusSchema = z.object({
  status: z.enum(["available", "on_delivery", "offline"]),
});

const locationSchema = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
  })
  .strict();

const vehicleSchema = z.object({
  vehicleType: z.enum(["bike", "car", "van", "truck"]).optional(),
  vehiclePlate: z.string().min(3).max(20).optional(),
  vehicleModel: z.string().max(60).optional().or(z.literal("")).or(z.null()),
  vehicleColor: z.string().max(30).optional().or(z.literal("")).or(z.null()),
  vehicleYear: z.string().max(4).optional().or(z.literal("")).or(z.null()),
  vehicleInsurance: z
    .string()
    .max(60)
    .optional()
    .or(z.literal(""))
    .or(z.null()),
});

const notifPrefsSchema = z.object({
  newDelivery: z.object({ push: z.boolean(), email: z.boolean() }).optional(),
  pickupReminder: z
    .object({ push: z.boolean(), email: z.boolean() })
    .optional(),
  deliveryComplete: z
    .object({ push: z.boolean(), email: z.boolean() })
    .optional(),
  deliveryFailed: z
    .object({ push: z.boolean(), email: z.boolean() })
    .optional(),
  customerMessage: z
    .object({ push: z.boolean(), email: z.boolean() })
    .optional(),
  ratingReceived: z
    .object({ push: z.boolean(), email: z.boolean() })
    .optional(),
  payoutProcessed: z
    .object({ push: z.boolean(), email: z.boolean() })
    .optional(),
  weeklyReport: z.object({ push: z.boolean(), email: z.boolean() }).optional(),
});

driversRouter.route("/", createCollectionRouter(writeStore, "drivers"));

driversRouter.get("/me", requireRole("driver"), async (c) => {
  const userId = c.get("userId" as never) as string;
  const driver = await findDriverByUserId(userId);
  if (!driver) return error(c, "Driver profile not found", 404);

  return success(c, { data: { ...driver, user: sanitizeUser(driver.user) } });
});

driversRouter.patch(
  "/me",
  requireRole("driver"),
  zValidator("json", vehicleSchema),
  async (c) => {
    const userId = c.get("userId" as never) as string;
    const body = c.req.valid("json");

    const driver = await findDriverByUserId(userId);
    if (!driver) return error(c, "Driver profile not found", 404);

    const [updated] = await db
      .update(drivers)
      .set({
        ...(body.vehicleType ? { vehicleType: body.vehicleType } : {}),
        ...(body.vehiclePlate ? { vehiclePlate: body.vehiclePlate } : {}),
        ...(body.vehicleModel !== undefined
          ? { vehicleModel: body.vehicleModel || null }
          : {}),
        ...(body.vehicleColor !== undefined
          ? { vehicleColor: body.vehicleColor || null }
          : {}),
        ...(body.vehicleYear !== undefined
          ? { vehicleYear: body.vehicleYear || null }
          : {}),
        ...(body.vehicleInsurance !== undefined
          ? { vehicleInsurance: body.vehicleInsurance || null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(drivers.id, driver.id))
      .returning();

    return success(c, { data: updated, message: "Vehicle updated" });
  },
);

driversRouter.get("/me/notifications", requireRole("driver"), async (c) => {
  const userId = c.get("userId" as never) as string;
  const driver = await findDriverByUserId(userId);
  if (!driver) return error(c, "Driver profile not found", 404);

  const prefs =
    (driver.notificationPreferences as Record<string, unknown>) ??
    DEFAULT_NOTIF_PREFS;
  return success(c, { data: { ...DEFAULT_NOTIF_PREFS, ...prefs } });
});

driversRouter.patch(
  "/me/notifications",
  requireRole("driver"),
  zValidator("json", notifPrefsSchema),
  async (c) => {
    const userId = c.get("userId" as never) as string;
    const body = c.req.valid("json");

    const driver = await findDriverByUserId(userId);
    if (!driver) return error(c, "Driver profile not found", 404);

    const [updated] = await db
      .update(drivers)
      .set({
        notificationPreferences: sql`coalesce(${drivers.notificationPreferences}, '{}'::jsonb) || ${JSON.stringify(body)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(drivers.id, driver.id))
      .returning();

    if (!updated)
      return error(c, "Failed to save notification preferences", 500);
    return success(c, {
      data: {
        ...DEFAULT_NOTIF_PREFS,
        ...((updated.notificationPreferences as object) ?? {}),
      },
      message: "Notification preferences saved",
    });
  },
);

driversRouter.patch(
  "/me/status",
  requireRole("driver"),
  zValidator("json", statusSchema),
  async (c) => {
    const userId = c.get("userId" as never) as string;
    const { status } = c.req.valid("json");

    const driver = await findDriverByUserId(userId);
    if (!driver) return error(c, "Driver profile not found", 404);

    if (!driver.businessId && status !== "offline")
      return error(c, "Join a business fleet before going online", 403);
    const updated = await updateDriverStatus(driver.id, status);
    return success(c, { data: updated, message: `Status set to ${status}` });
  },
);

driversRouter.patch(
  "/me/location",
  requireRole("driver"),
  zValidator("json", locationSchema),
  async (c) => {
    const userId = c.get("userId" as never) as string;
    const { lat, lng } = c.req.valid("json");

    const driver = await findDriverByUserId(userId);
    if (!driver) return error(c, "Driver profile not found", 404);

    await updateDriverLocation(driver.id, { lat, lng });
    return success(c, { data: null, message: "Location updated" });
  },
);

driversRouter.route(
  "/",
  createCollectionRouter(writeStore, "available-drivers"),
);

driversRouter.get("/:id", requireRole("business"), async (c) => {
  const id = c.req.param("id")!;
  const driver = await findDriverById(id, c.get("userId"));
  if (!driver) return error(c, "Driver not found", 404);
  return success(c, { data: { ...driver, user: sanitizeUser(driver.user) } });
});
