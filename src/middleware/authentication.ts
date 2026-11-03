import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { User } from "@/db/schema";

interface Dependencies {
  verifyToken: (token: string) => Promise<{ sub?: string; sid?: string }>;
  findUser: (id: string) => Promise<User | null | undefined>;
  isSessionActive?: (sid: string, userId: string) => Promise<boolean>;
}

export function createAuthenticationMiddleware(dependencies: Dependencies) {
  return createMiddleware(async (c, next) => {
    const authorization = c.req.header("Authorization");
    const match = authorization?.match(/^Bearer ([^\s]+)$/);
    if (!match?.[1]) {
      throw new HTTPException(401, { message: "Missing or invalid authorization header" });
    }

    let subject: string;
    let sessionId: string | undefined;
    try {
      const payload = await dependencies.verifyToken(match[1]);
      if (!payload.sub?.trim()) throw new Error("Missing subject");
      subject = payload.sub;
      sessionId = payload.sid;
    } catch {
      throw new HTTPException(401, { message: "Invalid or expired token" });
    }

    if (dependencies.isSessionActive && (!sessionId || !await dependencies.isSessionActive(sessionId, subject))) {
      throw new HTTPException(401, { message: "Session expired or revoked" });
    }

    // Dependency failures must remain server failures, not invalid credentials.
    const user = await dependencies.findUser(subject);
    if (!user || !user.isActive) {
      throw new HTTPException(401, { message: "User not found or inactive" });
    }
    c.set("user", user);
    c.set("userId", user.id);
    c.set("userRole", user.role);
    await next();
  });
}
