import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie } from "hono/cookie";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { WriteStore } from "../lib/idempotency.ts";

interface Dependencies {
  authenticate: MiddlewareHandler;
  protectPeer: MiddlewareHandler;
  protectAccount: MiddlewareHandler;
  store: WriteStore;
  comparePassword: (password: string, hash: string) => Promise<boolean>;
}
const input = z
  .object({
    currentPassword: z
      .string()
      .min(1)
      .max(72)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
  })
  .strict();
const result = z.union([
  z.object({ deactivated: z.literal(true) }),
  z.object({
    error: z.enum([
      "ACCOUNT_INACTIVE",
      "CREDENTIALS_CHANGED",
      "FLEET_OFFBOARDING_REQUIRED",
      "ACTIVE_SHIPMENTS",
      "UNRESOLVED_PAYMENTS",
    ]),
  }),
]);

export function createAccountDeactivationRouter(deps: Dependencies) {
  const router = new Hono();
  router.delete("/me", deps.authenticate, (c) =>
    c.json(
      {
        success: false,
        error: "PERMANENT_DELETION_UNAVAILABLE",
        message: "Use account deactivation; historical records are preserved",
      },
      409,
    ),
  );
  router.post(
    "/deactivate",
    deps.protectPeer,
    deps.authenticate,
    deps.protectAccount,
    bodyLimit({ maxSize: 2048 }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      let body;
      try {
        body = input.parse(await c.req.json());
      } catch {
        return c.json(
          {
            success: false,
            error: "INVALID_REQUEST",
            message: "Provide only currentPassword",
          },
          400,
        );
      }
      const user = c.get("user");
      if (!user || user.id !== c.get("userId"))
        return c.json({ success: false, error: "UNAUTHORIZED" }, 401);
      if (
        !(await deps.comparePassword(body.currentPassword, user.passwordHash))
      )
        return c.json(
          {
            success: false,
            error: "INVALID_CREDENTIALS",
            message: "Current password is incorrect",
          },
          401,
        );
      const rows = await deps.store.execute(
        sql`select deactivate_account(${user.id},${user.passwordHash}) as result`,
      );
      const outcome = result.parse(rows[0]);
      if ("error" in outcome) {
        const message = {
          ACCOUNT_INACTIVE: "Account is inactive",
          CREDENTIALS_CHANGED: "Credentials changed; sign in again",
          FLEET_OFFBOARDING_REQUIRED:
            "Offboard the business fleet before deactivation",
          ACTIVE_SHIPMENTS:
            "Resolve active shipments and package custody before deactivation",
          UNRESOLVED_PAYMENTS:
            "Resolve pending payments and money reviews before deactivation",
        }[outcome.error];
        return c.json(
          { success: false, error: outcome.error, message },
          outcome.error === "ACCOUNT_INACTIVE" ? 401 : 409,
        );
      }
      deleteCookie(c, "iso_refresh_token", { path: "/" });
      return c.json({
        success: true,
        data: { isActive: false },
        message: "Account deactivated; shipment and payment history preserved",
      });
    },
  );
  return router;
}
