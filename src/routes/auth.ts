import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { hash, compare } from "bcryptjs";
import { nanoid } from "nanoid";

import { env } from "@/lib/env";
import {
  createAccessToken,
  createRefreshToken,
  verifyRefreshToken,
  refreshTokenMaxAge,
} from "@/lib/jwt";
import { authenticate } from "@/middleware/auth";
import {
  findUserByEmail,
  findUserById,
  createUser,
  sanitizeUser,
} from "@/db/queries/users";
import { db } from "@/db";
import { businesses, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { updateUser } from "@/db/queries/users";
import { success, error } from "@/lib/response";

// ─── Constants ────────────────────────────────────────────────────────────────

const REFRESH_COOKIE = "iso_refresh_token";
const BCRYPT_ROUNDS = 12;

// ─── Cookie helpers ───────────────────────────────────────────────────────────

function setRefreshCookie(c: Parameters<typeof setCookie>[0], token: string) {
  const isProduction = env.NODE_ENV === "production";
  setCookie(c, REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "None" : "Lax",
    path: "/",
    maxAge: refreshTokenMaxAge(),
  });
}

function clearRefreshCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, REFRESH_COOKIE, { path: "/" });
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const registerSchema = z
  .object({
    name: z
      .string()
      .min(2, "Name must be at least 2 characters")
      .max(100, "Name too long"),
    email: z.string().email("Invalid email address"),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(128, "Password too long")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[0-9]/, "Password must contain at least one number"),
    role: z.enum(["business", "driver", "customer"], {
      errorMap: () => ({ message: "Role must be business, driver, or customer" }),
    }),
    phone: z
      .string()
      .regex(/^\+?[1-9]\d{6,14}$/, "Invalid phone number")
      .optional()
      .or(z.literal("")),
    // Business-specific
    businessName: z.string().min(2).max(100).optional(),
    // Driver-specific
    vehicleType: z.enum(["bike", "car", "van", "truck"]).optional(),
    vehiclePlate: z.string().min(3).max(20).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role === "driver") {
      if (!data.vehicleType) {
        ctx.addIssue({ code: "custom", path: ["vehicleType"], message: "Vehicle type is required for drivers" });
      }
      if (!data.vehiclePlate) {
        ctx.addIssue({ code: "custom", path: ["vehiclePlate"], message: "Vehicle plate is required for drivers" });
      }
    }
  });

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const authRouter = new Hono();

// ─── POST /auth/register ──────────────────────────────────────────────────────

authRouter.post("/register", zValidator("json", registerSchema), async (c) => {
  const body = c.req.valid("json");

  if (body.role === "driver") return error(c, "Drivers must join through a business invitation", 403);

  // Check if email already taken
  const existing = await findUserByEmail(body.email);
  if (existing) {
    return error(c, "An account with this email already exists", 409);
  }

  // Hash password
  const passwordHash = await hash(body.password, BCRYPT_ROUNDS);

  // Create user
  const user = await createUser({
    id: nanoid(),
    email: body.email,
    passwordHash,
    name: body.name,
    role: body.role,
    phone: body.phone || null,
    isEmailVerified: false,
    isActive: true,
  });

  // ── Create role-specific profile ──────────────────────────────────────────
  if (body.role === "business") {
    await db.insert(businesses).values({
      id: nanoid(),
      userId: user.id,
      businessName: body.businessName ?? body.name,
    });
  }


  // Issue tokens
  const [accessToken, refreshToken] = await Promise.all([
    createAccessToken(user.id, user.role),
    createRefreshToken(user.id),
  ]);

  setRefreshCookie(c, refreshToken);

  return success(c, {
    data: {
      user: sanitizeUser(user),
      accessToken,
    },
    message: "Account created successfully",
    status: 201,
  });
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────

authRouter.post("/login", zValidator("json", loginSchema), async (c) => {
  const { email, password } = c.req.valid("json");

  // Find user
  const user = await findUserByEmail(email);
  if (!user) {
    // Constant-time response — prevents user enumeration via timing
    await hash("dummy_constant_time_check", BCRYPT_ROUNDS);
    return error(c, "Invalid email or password", 401);
  }

  // Check password
  const passwordMatch = await compare(password, user.passwordHash);
  if (!passwordMatch) {
    return error(c, "Invalid email or password", 401);
  }

  // Check if account is active
  if (!user.isActive) {
    return error(c, "Your account has been deactivated. Contact support.", 401);
  }

  // Issue tokens
  const [accessToken, refreshToken] = await Promise.all([
    createAccessToken(user.id, user.role),
    createRefreshToken(user.id),
  ]);

  setRefreshCookie(c, refreshToken);

  return success(c, {
    data: {
      user: sanitizeUser(user),
      accessToken,
    },
    message: "Logged in successfully",
  });
});

// ─── POST /auth/refresh ───────────────────────────────────────────────────────

authRouter.post("/refresh", async (c) => {
  const refreshToken = getCookie(c, REFRESH_COOKIE);

  if (!refreshToken) {
    return error(c, "No refresh token provided", 401);
  }

  try {
    const payload = await verifyRefreshToken(refreshToken);

    const user = await findUserById(payload.sub!);
    if (!user || !user.isActive) {
      clearRefreshCookie(c);
      return error(c, "Session expired", 401);
    }

    const [newAccessToken, newRefreshToken] = await Promise.all([
      createAccessToken(user.id, user.role),
      createRefreshToken(user.id),
    ]);

    setRefreshCookie(c, newRefreshToken);

    return success(c, {
      data: {
        user: sanitizeUser(user),
        accessToken: newAccessToken,
      },
    });
  } catch {
    clearRefreshCookie(c);
    return error(c, "Invalid or expired refresh token", 401);
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

authRouter.post("/logout", (c) => {
  clearRefreshCookie(c);
  return success(c, { data: null, message: "Logged out successfully" });
});

// ─── PATCH /auth/me ───────────────────────────────────────────────────────────
// Update the authenticated user's own profile (name, phone, avatar URL).

const updateMeSchema = z.object({
  name:             z.string().min(2).max(100).optional(),
  phone:            z.string().regex(/^\+?[1-9]\d{6,14}$/).optional().or(z.literal("")).or(z.null()),
  avatar:           z.string().optional().or(z.literal("")).or(z.null()),
  emergencyContact: z.string().max(20).optional().or(z.literal("")).or(z.null()),
});

authRouter.patch("/me", authenticate, zValidator("json", updateMeSchema), async (c) => {
  const userId = c.get("userId" as never) as string;
  const body   = c.req.valid("json");

  const updated = await updateUser(userId, {
    ...(body.name             !== undefined ? { name: body.name }                           : {}),
    ...(body.phone            !== undefined ? { phone: body.phone || null }                 : {}),
    ...(body.avatar           !== undefined ? { avatar: body.avatar || null }               : {}),
    ...(body.emergencyContact !== undefined ? { emergencyContact: body.emergencyContact || null } : {}),
  });

  if (!updated) return error(c, "User not found", 404);

  return success(c, { data: sanitizeUser(updated), message: "Profile updated" });
});

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
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128)
    .regex(/[A-Z]/, "Must contain an uppercase letter")
    .regex(/[0-9]/, "Must contain a number"),
});

authRouter.patch("/password", authenticate, zValidator("json", changePasswordSchema), async (c) => {
  const userId = c.get("userId" as never) as string;
  const { currentPassword, newPassword } = c.req.valid("json");

  const user = await findUserById(userId);
  if (!user) return error(c, "User not found", 404);

  const match = await compare(currentPassword, user.passwordHash);
  if (!match) return error(c, "Current password is incorrect", 400);

  const newHash = await hash(newPassword, BCRYPT_ROUNDS);

  // Re-use updateUser with a raw set — we need to update passwordHash
  await db.update(users).set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(users.id, userId));

  return success(c, { data: null, message: "Password changed successfully" });
});
