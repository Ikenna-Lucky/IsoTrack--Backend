import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { hash } from "bcryptjs";
import { nanoid } from "nanoid";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { businesses, driverInvitations } from "@/db/schema";
import { authenticate, requireRole } from "@/middleware/auth";
import {
  createInvitationToken,
  hashInvitationToken,
} from "@/lib/invitation-token";
import { acceptDriverInvitationStatement, acceptExistingDriverInvitationStatement } from "@/db/queries/accept-driver-invitation";
import { createExistingDriverInvitationRouter } from "./existing-driver-invitation";
import { success, error } from "@/lib/response";

const email = z.string().trim().toLowerCase().email().max(254);
const acceptanceSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    email,
    name: z.string().trim().min(2).max(100),
    password: z.string().min(8).max(72).regex(/[A-Z]/).regex(/[0-9]/),
    vehicleType: z.enum(["bike", "car", "van", "truck"]),
    vehiclePlate: z.string().trim().min(3).max(20),
  })
  .strict()
  .refine((body) => Buffer.byteLength(body.password, "utf8") <= 72, {
    message: "Password must not exceed 72 UTF-8 bytes",
    path: ["password"],
  });

export const driverInvitationsRouter = new Hono();
driverInvitationsRouter.use("*", bodyLimit({ maxSize: 8192 }));
driverInvitationsRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

// No login required: the secret is delivered by the owner to the intended driver.
driverInvitationsRouter.post(
  "/accept",
  zValidator("json", acceptanceSchema),
  async (c) => {
    const body = c.req.valid("json");
    const tokenHash = hashInvitationToken(body.token);
    const [invitation] = await db
      .select({ id: driverInvitations.id })
      .from(driverInvitations)
      .where(
        and(
          eq(driverInvitations.tokenHash, tokenHash),
          eq(driverInvitations.email, body.email),
          isNull(driverInvitations.acceptedAt),
          isNull(driverInvitations.revokedAt),
          gt(driverInvitations.expiresAt, sql`statement_timestamp()`),
        ),
      )
      .limit(1);
    if (!invitation)
      return error(c, "Invitation is invalid or unavailable", 404);

    const result = await db.execute(
      acceptDriverInvitationStatement({
        tokenHash,
        email: body.email,
        name: body.name,
        userId: nanoid(),
        driverId: nanoid(),
        passwordHash: await hash(body.password, 12),
        vehicleType: body.vehicleType,
        vehiclePlate: body.vehiclePlate,
      }),
    );
    if (!result.rows[0])
      return error(
        c,
        "Invitation could not be accepted; it may be unavailable or the account already exists",
        409,
      );
    // Login is a separate operation: issuing a session cannot partially complete enrollment.
    return success(c, {
      data: result.rows[0],
      message: "Fleet joined. Sign in to continue.",
      status: 201,
    });
  },
);

driverInvitationsRouter.route("/", createExistingDriverInvitationRouter({
  authenticate,
  accept: async (userId, token) => {
    const result = await db.execute(acceptExistingDriverInvitationStatement(userId, hashInvitationToken(token)));
    return result.rows[0] as { userId: string; driverId: string; businessId: string } | undefined;
  },
}));

driverInvitationsRouter.use("*", authenticate, requireRole("business"));

async function businessForOwner(userId: string) {
  const [business] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.userId, userId))
    .limit(1);
  return business;
}

driverInvitationsRouter.post(
  "/",
  zValidator("json", z.object({ email }).strict()),
  async (c) => {
    const business = await businessForOwner(c.get("userId"));
    if (!business) return error(c, "Business profile not found", 404);
    const { token, tokenHash } = createInvitationToken();
    const [invitation] = await db
      .insert(driverInvitations)
      .values({
        id: nanoid(),
        businessId: business.id,
        email: c.req.valid("json").email,
        tokenHash,
        expiresAt: sql`statement_timestamp() + interval '48 hours'`,
      })
      .returning({
        id: driverInvitations.id,
        email: driverInvitations.email,
        expiresAt: driverInvitations.expiresAt,
      });
    return success(c, {
      data: { ...invitation, token },
      status: 201,
      message:
        "Share this invitation token securely with the named recipient. It will not be shown again.",
    });
  },
);

driverInvitationsRouter.get("/", async (c) => {
  const business = await businessForOwner(c.get("userId"));
  if (!business) return error(c, "Business profile not found", 404);
  const rows = await db
    .select({
      id: driverInvitations.id,
      email: driverInvitations.email,
      expiresAt: driverInvitations.expiresAt,
      createdAt: driverInvitations.createdAt,
      acceptedAt: driverInvitations.acceptedAt,
      revokedAt: driverInvitations.revokedAt,
    })
    .from(driverInvitations)
    .where(eq(driverInvitations.businessId, business.id))
    .orderBy(desc(driverInvitations.createdAt))
    .limit(50);
  return success(c, { data: rows });
});

driverInvitationsRouter.delete("/:id", async (c) => {
  const business = await businessForOwner(c.get("userId"));
  if (!business) return error(c, "Business profile not found", 404);
  const [revoked] = await db
    .update(driverInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(driverInvitations.id, c.req.param("id")),
        eq(driverInvitations.businessId, business.id),
        isNull(driverInvitations.acceptedAt),
        isNull(driverInvitations.revokedAt),
      ),
    )
    .returning({ id: driverInvitations.id });
  if (!revoked)
    return error(c, "Invitation not found or no longer pending", 404);
  return success(c, { data: revoked, message: "Invitation revoked" });
});
