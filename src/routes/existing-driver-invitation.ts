import { Hono, type MiddlewareHandler } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

interface Membership {
  userId: string;
  driverId: string;
  businessId: string;
}

interface Dependencies {
  authenticate: MiddlewareHandler;
  accept: (userId: string, token: string) => Promise<Membership | undefined>;
}

export function createExistingDriverInvitationRouter(
  dependencies: Dependencies,
) {
  const router = new Hono();
  router.post(
    "/accept-existing",
    dependencies.authenticate,
    async (c, next) => {
      if (c.get("userRole") !== "driver") {
        return c.json(
          {
            success: false,
            error: "FORBIDDEN",
            message: "A driver account is required",
          },
          403,
        );
      }
      await next();
    },
    zValidator(
      "json",
      z
        .object({
          token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        })
        .strict(),
    ),
    async (c) => {
      const membership = await dependencies.accept(
        c.get("userId"),
        c.req.valid("json").token,
      );
      if (!membership) {
        return c.json(
          {
            success: false,
            error: "CONFLICT",
            message: "Invitation cannot be accepted by this account",
          },
          409,
        );
      }
      return c.json({
        success: true,
        data: membership,
        message: "Fleet joined",
      });
    },
  );
  return router;
}
