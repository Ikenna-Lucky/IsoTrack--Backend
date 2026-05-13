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
import { businesses, drivers } from "@/db/schema";
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

  if (body.role === "driver") {
    await db.insert(drivers).values({
      id: nanoid(),
      userId: user.id,
      vehicleType: body.vehicleType!,
      vehiclePlate: body.vehiclePlate!,
      status: "offline",
      rating: 5.0,
      totalDeliveries: 0,
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
      return error(c, "User not found or inactive", 401);
    }

    // Rotate tokens — old refresh token is replaced
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
      message: "Token refreshed successfully",
    });
  } catch {
    clearRefreshCookie(c);
    return error(c, "Invalid or expired refresh token", 401);
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

authRouter.post("/logout", async (c) => {
  clearRefreshCookie(c);
  return success(c, {
    data: null,
    message: "Logged out successfully",
  });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

authRouter.get("/me", authenticate, async (c) => {
  const user = c.get("user");
  return success(c, {
    data: { user: sanitizeUser(user) },
  });
});
