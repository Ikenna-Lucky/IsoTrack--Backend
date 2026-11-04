import { createSessionRouter } from "./sessions";
import { createAccountActionRouter, accountPassword } from "./account-actions";
import { createPublicAuthRouter } from "./public-auth";
import { registerAccountStatement } from "@/db/queries/register-account";
import { requestPeer } from "@/middleware/request-peer";
import { writeStore } from "@/services/write-store";
import { Hono } from "hono";
import { logEvent } from "../observability/telemetry";
import { reportDependency } from "../observability/runtime";
import { zValidator } from "@hono/zod-validator";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import { hash, compare } from "bcryptjs";
import { nanoid } from "nanoid";

import { env } from "@/lib/env";
import { verifyRefreshToken } from "@/lib/jwt";
import { openSession, rotateSession, revokeSession } from "@/lib/sessions";
import { changePasswordStatement } from "@/db/queries/session-statements";
import { authenticate } from "@/middleware/auth";
import {
  findUserByEmail,
  findUserById,
  sanitizeUser,
} from "@/db/queries/users";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { updateUser } from "@/db/queries/users";
import { success, error } from "@/lib/response";

// ─── Constants ────────────────────────────────────────────────────────────────

const REFRESH_COOKIE = "iso_refresh_token";
const BCRYPT_ROUNDS = 12;

// ─── Cookie helpers ───────────────────────────────────────────────────────────

function clearRefreshCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, REFRESH_COOKIE, { path: "/" });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const authRouter = new Hono();
authRouter.route(
  "/",
  createAccountActionRouter({
    store: writeStore,
    key: env.ACCOUNT_ACTION_SECRET,
    peer: requestPeer,
    reportError: () => reportDependency("account_action"),
  }),
);

authRouter.route(
  "/",
  createPublicAuthRouter({
    store: writeStore,
    secret: env.JWT_SECRET,
    peer: requestPeer,
    findUser: findUserByEmail,
    register: async (input, passwordHash) => {
      const id = nanoid();
      const rows = await writeStore.execute(
        registerAccountStatement(id, nanoid(), input, passwordHash),
      );
      return rows.length ? findUserById(id) : null;
    },
    openSession,
    secureCookies: env.NODE_ENV === "production",
    record: (event) =>
      logEvent("authentication_attempt", {
        operation: event.operation,
        outcome: event.outcome,
        requestId: event.requestId,
      }),
  }),
);
// ─── POST /auth/refresh ───────────────────────────────────────────────────────

authRouter.route(
  "/",
  createSessionRouter({
    frontendOrigin: new URL(env.FRONTEND_URL).origin,
    secureCookies: env.NODE_ENV === "production",
    verify: verifyRefreshToken,
    findUser: findUserById,
    rotate: rotateSession,
    revoke: revokeSession,
    sanitize: sanitizeUser,
  }),
);
// ─── PATCH /auth/me ───────────────────────────────────────────────────────────
// Update the authenticated user's own profile (name, phone, avatar URL).

const updateMeSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  phone: z
    .string()
    .regex(/^\+?[1-9]\d{6,14}$/)
    .optional()
    .or(z.literal(""))
    .or(z.null()),
  avatar: z.string().optional().or(z.literal("")).or(z.null()),
  emergencyContact: z
    .string()
    .max(20)
    .optional()
    .or(z.literal(""))
    .or(z.null()),
});

authRouter.patch(
  "/me",
  authenticate,
  zValidator("json", updateMeSchema),
  async (c) => {
    const userId = c.get("userId" as never) as string;
    const body = c.req.valid("json");

    const updated = await updateUser(userId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
      ...(body.avatar !== undefined ? { avatar: body.avatar || null } : {}),
      ...(body.emergencyContact !== undefined
        ? { emergencyContact: body.emergencyContact || null }
        : {}),
    });

    if (!updated) return error(c, "User not found", 404);

    return success(c, {
      data: sanitizeUser(updated),
      message: "Profile updated",
    });
  },
);

// ─── DELETE /auth/me ──────────────────────────────────────────────────────────
// Permanently delete the authenticated user and all associated data.

authRouter.delete("/me", authenticate, async (c) => {
  const userId = c.get("userId" as never) as string;

  const user = await findUserById(userId);
  if (!user) return error(c, "User not found", 404);

  // Cascade delete: drivers/businesses/shipments are handled by FK onDelete cascade.
  await db.delete(users).where(eq(users.id, userId));

  clearRefreshCookie(c);
  return success(c, { data: null, message: "Account permanently deleted" });
});

// ─── PATCH /auth/password ─────────────────────────────────────────────────────
// Change the authenticated user's password.

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: accountPassword,
});

authRouter.patch(
  "/password",
  authenticate,
  zValidator("json", changePasswordSchema),
  async (c) => {
    const userId = c.get("userId" as never) as string;
    const { currentPassword, newPassword } = c.req.valid("json");

    const user = await findUserById(userId);
    if (!user) return error(c, "User not found", 404);

    const match = await compare(currentPassword, user.passwordHash);
    if (!match) return error(c, "Current password is incorrect", 400);

    const newHash = await hash(newPassword, BCRYPT_ROUNDS);

    const result = await db.execute(
      changePasswordStatement(userId, user.passwordHash, newHash),
    );
    if (!result.rows.length)
      return error(c, "Credentials changed. Please log in again", 409);
    clearRefreshCookie(c);
    return success(c, {
      data: null,
      message: "Password changed. Please log in again on all devices",
    });
  },
);
