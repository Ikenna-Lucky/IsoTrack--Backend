import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
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

// ─── Schemas ──────────────────────────────────────────────────────────────────

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

// ─── GET /drivers ─────────────────────────────────────────────────────────────
// Business: list drivers in its private fleet.

driversRouter.route("/", createCollectionRouter(writeStore, "drivers"));

// ─── GET /drivers/me ──────────────────────────────────────────────────────────
// Driver: get own profile.

driversRouter.get("/me", requireRole("driver"), async (c) => {
  const userId = c.get("userId" as never) as string;
  const driver = await findDriverByUserId(userId);
  if (!driver) return error(c, "Driver profile not found", 404);

  return success(c, { data: { ...driver, user: sanitizeUser(driver.user) } });
});

// ─── PATCH /drivers/me ────────────────────────────────────────────────────────
// Driver: update vehicle type and/or plate number.

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

// ─── GET /drivers/me/notifications ───────────────────────────────────────────
// Return the driver's stored notification preferences (or sensible defaults).

const DEFAULT_NOTIF_PREFS = {
  newDelivery: { push: true, email: true },
  pickupReminder: { push: true, email: false },
  deliveryComplete: { push: true, email: true },
  deliveryFailed: { push: true, email: true },
  customerMessage: { push: true, email: false },
  ratingReceived: { push: true, email: false },
  payoutProcessed: { push: true, email: true },
  weeklyReport: { push: false, email: true },
};

driversRouter.get("/me/notifications", requireRole("driver"), async (c) => {
  const userId = c.get("userId" as never) as string;
  const driver = await findDriverByUserId(userId);
  if (!driver) return error(c, "Driver profile not found", 404);

  const prefs =
    (driver.notificationPreferences as Record<string, unknown>) ??
    DEFAULT_NOTIF_PREFS;
  return success(c, { data: { ...DEFAULT_NOTIF_PREFS, ...prefs } });
});

// ─── PATCH /drivers/me/notifications ─────────────────────────────────────────
// Persist the driver's notification preferences.

driversRouter.patch(
  "/me/notifications",
  requireRole("driver"),
  zValidator("json", notifPrefsSchema),
  async (c) => {
    const userId = c.get("userId" as never) as string;
    const body = c.req.valid("json");

    const driver = await findDriverByUserId(userId);
    if (!driver) return error(c, "Driver profile not found", 404);

    // Merge with existing prefs so a partial PATCH doesn't wipe unrelated keys
    const existing =
      (driver.notificationPreferences as Record<string, unknown>) ?? {};
    const merged = { ...DEFAULT_NOTIF_PREFS, ...existing, ...body };

    const [updated] = await db
      .update(drivers)
      .set({ notificationPreferences: merged, updatedAt: new Date() })
      .where(eq(drivers.id, driver.id))
      .returning();

    return success(c, {
      data: updated?.notificationPreferences ?? merged,
      message: "Notification preferences saved",
    });
  },
);

// ─── PATCH /drivers/me/status ─────────────────────────────────────────────────
// Driver: toggle online/offline status.

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

// ─── PATCH /drivers/me/location ───────────────────────────────────────────────
// Driver: update GPS location.

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

// ─── GET /drivers/available ───────────────────────────────────────────────────
// Business: list only drivers whose status is "available".

driversRouter.route(
  "/",
  createCollectionRouter(writeStore, "available-drivers"),
);

// ─── GET /drivers/:id ─────────────────────────────────────────────────────────
// Business: get a specific driver by ID.

driversRouter.get("/:id", requireRole("business"), async (c) => {
  const id = c.req.param("id")!;
  const driver = await findDriverById(id, c.get("userId"));
  if (!driver) return error(c, "Driver not found", 404);
  return success(c, { data: { ...driver, user: sanitizeUser(driver.user) } });
});
