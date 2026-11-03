import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { createAuthenticationMiddleware } from "./authentication";
import { verifyAccessToken } from "@/lib/jwt";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { UserRole } from "@/types";

export const authenticate = createAuthenticationMiddleware({
  verifyToken: verifyAccessToken,
  findUser: async (id) => {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  },
});

// Role-based access guard
export const requireRole = (...roles: UserRole[]) =>
  createMiddleware(async (c: Context, next: Next) => {
    const role = c.get("userRole");
    if (!roles.includes(role)) {
      throw new HTTPException(403, {
        message: `Access denied. Required role: ${roles.join(" or ")}`,
      });
    }
    await next();
  });
