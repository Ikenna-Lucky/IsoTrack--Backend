import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { authenticate, requireRole } from "@/middleware/auth";
import {
  findDriverById,
  findDriverByUserId,
  findAvailableDrivers,
  updateDriverStatus,
  updateDriverLocation,
} from "@/db/queries/drivers";
import { db } from "@/db";
import { drivers } from "@/db/schema";
import { sanitizeUser } from "@/db/queries/users";
import { success, error } from "@/lib/response";

export const driversRouter = new Hono();

driversRouter.use("*", authenticate);

// ─── Schemas ──────────────────────────────────────────────────────────────────

const updateStatusSchema = z.object({
  status: z.enum(["available", "on_delivery", "offline"]),
});

const updateLocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});

// ─── GET /drivers — all drivers (business only) ───────────────────────────────

driversRouter.get("/", requireRole("business"), async (c) => {
  const rows = await db.query.drivers.findMany({
    with: { user: true },
    orderBy: (d, { desc }) => [desc(d.createdAt)],
  });

  const data = rows.map((d) => ({ ...d, user: sanitizeUser(d.user) }));
  return success(c, { data });
});

// ─── GET /drivers/available — available drivers (business only) ───────────────
// NOTE: must be registered before /:id so Hono doesn't treat "available" as an id

driversRouter.get("/available", requireRole("business"), async (c) => {
  const rows = await findAvailableDrivers();
  const data = rows.map((d) => ({ ...d, user: sanitizeUser(d.user) }));
  return success(c, { data });
});

// ─── GET /drivers/me — logged-in driver's own profile ────────────────────────

driversRouter.get("/me", requireRole("driver"), async (c) => {
  const userId = c.get("userId");
  const driver = await findDriverByUserId(userId);
  if (!driver) return error(c, "Driver profile not found", 404);
  return success(c, { data: { ...driver, user: sanitizeUser(driver.user) } });
});

// ─── GET /drivers/:id — single driver ────────────────────────────────────────

driversRouter.get("/:id", async (c) => {
  const driver = await findDriverById(c.req.param("id"));
  if (!driver) return error(c, "Driver not found", 404);
  return success(c, { data: { ...driver, user: sanitizeUser(driver.user) } });
});

// ─── PATCH /drivers/:id/status ────────────────────────────────────────────────

driversRouter.patch(
  "/:id/status",
  requireRole("driver"),
  zValidator("json", updateStatusSchema),
  async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.param();
    const { status } = c.req.valid("json");

    // Drivers can only update their own record
    const [own] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.userId, userId))
      .limit(1);

    if (!own || own.id !== id) {
      return error(c, "You can only update your own status", 403);
    }

    const updated = await updateDriverStatus(id, status);
    if (!updated) return error(c, "Failed to update status", 500);

    return success(c, { data: updated, message: "Status updated" });
  },
);

// ─── PATCH /drivers/:id/location ─────────────────────────────────────────────

driversRouter.patch(
  "/:id/location",
  requireRole("driver"),
  zValidator("json", updateLocationSchema),
  async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.param();
    const { lat, lng } = c.req.valid("json");

    const [own] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.userId, userId))
      .limit(1);

    if (!own || own.id !== id) {
      return error(c, "You can only update your own location", 403);
    }

    const updated = await updateDriverLocation(id, { lat, lng });
    if (!updated) return error(c, "Failed to update location", 500);

    return success(c, { data: updated, message: "Location updated" });
  },
);
