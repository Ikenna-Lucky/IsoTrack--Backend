import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { authenticate, requireRole } from "@/middleware/auth";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { createBusinessAnalyticsRouter } from "./shipment-reads";
import { writeStore } from "@/services/write-store";
import { sanitizeUser } from "@/db/queries/users";
import { success, error } from "@/lib/response";

export const businessRouter = new Hono();

businessRouter.use("*", authenticate, requireRole("business"));

// Registration creates the profile atomically. Legacy inconsistencies require
// explicit repair, rather than writes or arbitrary profile selection during GET.
async function ensureBusiness(userId: string) {
  const rows = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.userId, userId))
    .limit(2);
  if (rows.length !== 1)
    throw new HTTPException(409, {
      message: "Business profile needs operator reconciliation",
    });
  return rows[0]!;
}
const updateProfileSchema = z.object({
  businessName: z.string().min(2).max(100).optional(),
  address: z
    .object({
      street: z.string(),
      city: z.string(),
      state: z.string(),
    })
    .optional(),
});

// GET /business/profile
businessRouter.get("/profile", async (c) => {
  const userId = c.get("userId" as never) as string;
  const biz = await ensureBusiness(userId);

  const full = await db.query.businesses.findFirst({
    where: eq(businesses.id, biz.id),
    with: { user: true },
  });

  if (!full) return error(c, "Business profile not found", 404);

  return success(c, { data: { ...full, user: sanitizeUser(full.user) } });
});

// PATCH /business/profile
businessRouter.patch(
  "/profile",
  zValidator("json", updateProfileSchema),
  async (c) => {
    const userId = c.get("userId" as never) as string;
    const body = c.req.valid("json");

    const biz = await ensureBusiness(userId);

    const [updated] = await db
      .update(businesses)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(businesses.id, biz.id))
      .returning();

    return success(c, { data: updated, message: "Profile updated" });
  },
);

// GET /business/analytics
businessRouter.route("/", createBusinessAnalyticsRouter(writeStore));

const notifPrefsSchema = z.object({
  shipmentCreated: z
    .object({ email: z.boolean(), sms: z.boolean() })
    .optional(),
  driverAssigned: z.object({ email: z.boolean(), sms: z.boolean() }).optional(),
  pickedUp: z.object({ email: z.boolean(), sms: z.boolean() }).optional(),
  outForDelivery: z.object({ email: z.boolean(), sms: z.boolean() }).optional(),
  delivered: z.object({ email: z.boolean(), sms: z.boolean() }).optional(),
  failed: z.object({ email: z.boolean(), sms: z.boolean() }).optional(),
  driverOnline: z.object({ email: z.boolean(), sms: z.boolean() }).optional(),
  weeklyReport: z.object({ email: z.boolean(), sms: z.boolean() }).optional(),
});

// GET /business/notifications
businessRouter.get("/notifications", async (c) => {
  const userId = c.get("userId" as never) as string;
  const biz = await ensureBusiness(userId);

  const full = await db.query.businesses.findFirst({
    where: eq(businesses.id, biz.id),
    columns: { notificationPreferences: true },
  });

  const defaults = {
    shipmentCreated: { email: true, sms: false },
    driverAssigned: { email: true, sms: true },
    pickedUp: { email: false, sms: true },
    outForDelivery: { email: true, sms: true },
    delivered: { email: true, sms: true },
    failed: { email: true, sms: true },
    driverOnline: { email: false, sms: false },
    weeklyReport: { email: true, sms: false },
  };

  return success(c, {
    data: { ...defaults, ...((full?.notificationPreferences as object) ?? {}) },
  });
});

// PATCH /business/notifications
businessRouter.patch(
  "/notifications",
  zValidator("json", notifPrefsSchema),
  async (c) => {
    const userId = c.get("userId" as never) as string;
    const body = c.req.valid("json");
    const biz = await ensureBusiness(userId);

    const [updated] = await db
      .update(businesses)
      .set({
        notificationPreferences: sql`coalesce(${businesses.notificationPreferences}, '{}'::jsonb) || ${JSON.stringify(body)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(businesses.id, biz.id))
      .returning({
        notificationPreferences: businesses.notificationPreferences,
      });

    if (!updated)
      return error(c, "Failed to save notification preferences", 500);
    return success(c, {
      data: updated.notificationPreferences,
      message: "Notification preferences saved",
    });
  },
);

// ─── Preferences ──────────────────────────────────────────────────────────────

const preferencesSchema = z.object({
  timezone: z.string().optional(),
  currency: z.string().optional(),
  language: z.string().optional(),
  dateFormat: z.string().optional(),
  compactView: z.boolean().optional(),
  autoRefresh: z.boolean().optional(),
});

// GET /business/preferences
businessRouter.get("/preferences", async (c) => {
  const userId = c.get("userId" as never) as string;
  const biz = await ensureBusiness(userId);

  const full = await db.query.businesses.findFirst({
    where: eq(businesses.id, biz.id),
    columns: { preferences: true },
  });

  const defaults = {
    timezone: "Africa/Lagos",
    currency: "NGN",
    language: "en",
    dateFormat: "DD/MM/YYYY",
    compactView: false,
    autoRefresh: true,
  };

  return success(c, {
    data: { ...defaults, ...((full?.preferences as object) ?? {}) },
  });
});

// PATCH /business/preferences
businessRouter.patch(
  "/preferences",
  zValidator("json", preferencesSchema),
  async (c) => {
    const userId = c.get("userId" as never) as string;
    const body = c.req.valid("json");
    const biz = await ensureBusiness(userId);

    const [updated] = await db
      .update(businesses)
      .set({
        preferences: sql`coalesce(${businesses.preferences}, '{}'::jsonb) || ${JSON.stringify(body)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(businesses.id, biz.id))
      .returning({ preferences: businesses.preferences });

    if (!updated) return error(c, "Failed to save preferences", 500);
    return success(c, {
      data: updated.preferences,
      message: "Preferences saved",
    });
  },
);
