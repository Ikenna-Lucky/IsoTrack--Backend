import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { authenticate, requireRole } from "@/middleware/auth";
import { db } from "@/db";
import { businesses, shipments } from "@/db/schema";
import { getBusinessShipmentStats } from "@/db/queries/shipments";
import { findUserById, sanitizeUser } from "@/db/queries/users";
import { success, error } from "@/lib/response";

export const businessRouter = new Hono();

businessRouter.use("*", authenticate, requireRole("business"));

// Resolve (or auto-create) the business row for a user.
// If a business-role user has no profile row (e.g. registered before the bug
// was fixed), we create one on the fly so the dashboard always loads.
async function ensureBusiness(userId: string) {
  const [existing] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.userId, userId))
    .limit(1);

  if (existing) return existing;

  const user = await findUserById(userId);
  const [created] = await db
    .insert(businesses)
    .values({
      id: nanoid(),
      userId,
      businessName: user?.name ?? "My Business",
    })
    .returning({ id: businesses.id });

  return created;
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
    const body   = c.req.valid("json");

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
businessRouter.get("/analytics", async (c) => {
  const userId = c.get("userId" as never) as string;
  const biz    = await ensureBusiness(userId);

  const statusStats = await getBusinessShipmentStats(biz.id);

  const revenueRows = await db
    .select({ priceKobo: shipments.priceKobo })
    .from(shipments)
    .where(eq(shipments.businessId, biz.id));

  const totalRevenueKobo = revenueRows.reduce((acc, s) => acc + s.priceKobo, 0);

  const recentShipments = await db.query.shipments.findMany({
    where: eq(shipments.businessId, biz.id),
    with: { driver: { with: { user: true } }, customer: true },
    orderBy: desc(shipments.createdAt),
    limit: 10,
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
