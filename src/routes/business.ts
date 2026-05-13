import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { authenticate, requireRole } from "@/middleware/auth";
import { db } from "@/db";
import { businesses, shipments } from "@/db/schema";
import { getBusinessShipmentStats } from "@/db/queries/shipments";
import { sanitizeUser } from "@/db/queries/users";
import { success, error } from "@/lib/response";

export const businessRouter = new Hono();

businessRouter.use("*", authenticate, requireRole("business"));

// ─── Schemas ──────────────────────────────────────────────────────────────────

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

// ─── GET /business/profile ────────────────────────────────────────────────────

businessRouter.get("/profile", async (c) => {
  const userId = c.get("userId");

  const biz = await db.query.businesses.findFirst({
    where: eq(businesses.userId, userId),
    with: { user: true },
  });

  if (!biz) return error(c, "Business profile not found", 404);

  return success(c, {
    data: { ...biz, user: sanitizeUser(biz.user) },
  });
});

// ─── PATCH /business/profile ──────────────────────────────────────────────────

businessRouter.patch(
  "/profile",
  zValidator("json", updateProfileSchema),
  async (c) => {
    const userId = c.get("userId");
    const body = c.req.valid("json");

    const [biz] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.userId, userId))
      .limit(1);

    if (!biz) return error(c, "Business profile not found", 404);

    const [updated] = await db
      .update(businesses)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(businesses.id, biz.id))
      .returning();

    return success(c, { data: updated, message: "Profile updated" });
  },
);

// ─── GET /business/analytics ──────────────────────────────────────────────────

businessRouter.get("/analytics", async (c) => {
  const userId = c.get("userId");

  const [biz] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.userId, userId))
    .limit(1);

  if (!biz) return error(c, "Business profile not found", 404);

  // Shipment status breakdown
  const statusStats = await getBusinessShipmentStats(biz.id);

  // Revenue (sum of delivered shipments in kobo)
  const revenueRows = await db
    .select({ priceKobo: shipments.priceKobo })
    .from(shipments)
    .where(eq(shipments.businessId, biz.id));

  const totalRevenueKobo = revenueRows.reduce(
    (sum, s) => sum + s.priceKobo,
    0,
  );

  // Last 5 recent shipments
  const recentShipments = await db.query.shipments.findMany({
    where: eq(shipments.businessId, biz.id),
    with: { driver: { with: { user: true } }, customer: true },
    orderBy: desc(shipments.createdAt),
    limit: 5,
  });

  return success(c, {
    data: {
      statusBreakdown: statusStats,
      totalShipments: Object.values(statusStats).reduce((a, b) => a + b, 0),
      totalRevenueKobo,
      recentShipments,
    },
  });
});
