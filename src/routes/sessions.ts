import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { User } from "@/db/schema";
import type { RefreshTokenPayload } from "@/lib/jwt";

interface Dependencies {
  frontendOrigin: string;
  secureCookies: boolean;
  verify: (token: string) => Promise<RefreshTokenPayload>;
  findUser: (id: string) => Promise<User | null>;
  rotate: (user: User, payload: RefreshTokenPayload) => Promise<{ accessToken: string; refreshToken: string; maxAge: number } | null>;
  revoke: (sid: string, userId: string) => Promise<void>;
  sanitize: (user: User) => unknown;
}

export function createSessionRouter(deps: Dependencies) {
  const router = new Hono();
  const cookie = "iso_refresh_token";
  const cookieRequest: MiddlewareHandler = async (c, next) => {
    c.header("Cache-Control", "no-store");
    // These endpoints use ambient cookies. Require an explicit trusted Origin,
    // including for non-browser clients, rather than relying on CORS alone.
    if (c.req.header("Origin") !== deps.frontendOrigin) {
      return c.json({ success: false, error: "FORBIDDEN", message: "Untrusted request origin" }, 403);
    }
    await next();
  };
  router.use("/refresh", cookieRequest);
  router.use("/logout", cookieRequest);
  router.post("/refresh", async (c) => {
    const token = getCookie(c, cookie);
    let payload;
    if (token) {
      try { payload = await deps.verify(token); } catch { /* Invalid credentials. */ }
    }
    if (!payload) {
      deleteCookie(c, cookie, { path: "/" });
      return c.json({ success: false, error: "UNAUTHORIZED", message: "Invalid or expired refresh token" }, 401);
    }
    // Storage/signing failures deliberately propagate as server errors.
    const user = await deps.findUser(payload.sub);
    const session = user?.isActive ? await deps.rotate(user, payload) : null;
    if (!session || !user) {
      deleteCookie(c, cookie, { path: "/" });
      return c.json({ success: false, error: "UNAUTHORIZED", message: "Session expired or revoked. Please log in again" }, 401);
    }
    setCookie(c, cookie, session.refreshToken, {
      path: "/", httpOnly: true, secure: deps.secureCookies,
      sameSite: deps.secureCookies ? "None" : "Lax", maxAge: session.maxAge,
    });
    return c.json({ success: true, data: { user: deps.sanitize(user), accessToken: session.accessToken } });
  });
  router.post("/logout", async (c) => {
    const token = getCookie(c, cookie);
    let payload;
    if (token) {
      try { payload = await deps.verify(token); } catch { /* Idempotent logout. */ }
    }
    if (payload) await deps.revoke(payload.sid, payload.sub);
    deleteCookie(c, cookie, { path: "/" });
    return c.json({ success: true, data: null, message: "Logged out successfully" });
  });
  return router;
}
