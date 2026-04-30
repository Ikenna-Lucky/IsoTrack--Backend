import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { jwtVerify } from "jose";
import { env } from "@/lib/env";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { UserRole } from "@/types";

interface JwtPayload {
  sub: string;
  role: UserRole;
  iat: number;
  exp: number;
}

// Attaches verified user to context
export const authenticate = createMiddleware(async (c: Context, next: Next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HTTPException(401, {
      message: "Missing or invalid authorization header",
    });
  }

  const token = authHeader.slice(7);
  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    const jwtPayload = payload as unknown as JwtPayload;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, jwtPayload.sub))
      .limit(1);

    if (!user || !user.isActive) {
      throw new HTTPException(401, { message: "User not found or inactive" });
    }

    c.set("user", user);
    c.set("userId", user.id);
    c.set("userRole", user.role);
    await next();
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    throw new HTTPException(401, { message: "Invalid or expired token" });
  }
});

// Role-based access guard
export const requireRole = (...roles: UserRole[]) =>
  createMiddleware(async (c: Context, next: Next) => {
    const role = c.get("userRole") as UserRole;
    if (!roles.includes(role)) {
      throw new HTTPException(403, {
        message: `Access denied. Required role: ${roles.join(" or ")}`,
      });
    }
    await next();
  });
