import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import { hash } from "bcryptjs";
import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { OutboxStore } from "../workers/outbox-processor.ts";
import {
  actionHash,
  actionId,
  actionPeerHash,
  actionToken,
  newActionId,
} from "../lib/account-action-token.ts";
import {
  actionRequestBudget,
  issueAccountAction,
  validAccountAction,
  consumeAccountAction,
} from "../db/queries/account-actions.ts";

const emailInput = z
  .object({ email: z.string().trim().toLowerCase().email().max(254) })
  .strict();
const tokenInput = z.object({ token: z.string().length(87) }).strict();
// bcrypt truncates beyond 72 bytes. Use the same policy for every password write.
export const accountPassword = z
  .string()
  .min(8)
  .max(72)
  .regex(/[A-Z]/)
  .regex(/[0-9]/)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 72,
    "Password must be at most 72 bytes",
  );
const resetInput = tokenInput.extend({ newPassword: accountPassword });
interface Dependencies {
  store: OutboxStore;
  key: string | undefined;
  peer: (context: import("hono").Context) => string | undefined;
  reportError: () => void;
}

export function createAccountActionRouter({
  store,
  key,
  peer,
  reportError,
}: Dependencies) {
  const app = new Hono();
  app.onError((_, c) => {
    reportError();
    return c.json({ success: false, error: "ACCOUNT_ACTION_UNAVAILABLE" }, 503);
  });
  for (const path of [
    "/forgot-password",
    "/reset-password",
    "/verification/request",
    "/verification/confirm",
  ]) {
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      if (!key)
        return c.json(
          { success: false, error: "ACCOUNT_ACTION_UNAVAILABLE" },
          503,
        );
      const address = peer(c);
      if (!address)
        return c.json(
          { success: false, error: "ACCOUNT_ACTION_UNAVAILABLE" },
          503,
        );
      if (
        !(
          await store.execute(
            actionRequestBudget(`peer:${actionPeerHash(address, key)}`),
          )
        ).length
      ) {
        c.header("Retry-After", "600");
        return c.json({ success: false, error: "RATE_LIMITED" }, 429);
      }
      await next();
    });
    app.use(
      path,
      bodyLimit({
        maxSize: 4096,
        onError: (c) =>
          c.json({ success: false, error: "BODY_TOO_LARGE" }, 413),
      }),
    );
  }
  const read = async <T>(
    c: import("hono").Context,
    schema: z.ZodType<T>,
  ): Promise<T | null> => {
    if (!c.req.header("Content-Type")?.startsWith("application/json"))
      return null;
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return null;
    }
    const result = schema.safeParse(input);
    return result.success ? result.data : null;
  };
  for (const [path, purpose] of [
    ["/forgot-password", "reset_password"],
    ["/verification/request", "verify_email"],
  ] as const) {
    app.post(path, async (c) => {
      const started = performance.now();
      const input = await read(c, emailInput);
      if (!input)
        return c.json({ success: false, error: "INVALID_INPUT" }, 400);
      const id = newActionId();
      const token = actionToken(id, purpose, key!);
      await store.execute(
        issueAccountAction(input.email, purpose, id, actionHash(token)),
      );
      // Both eligible and ineligible requests share a minimum response window.
      // This reduces obvious timing differences; it is not constant-time HTTP.
      await delay(
        Math.max(0, 300 + randomInt(0, 51) - (performance.now() - started)),
      );
      return c.json(
        {
          success: true,
          message: "If the account is eligible, an email will be sent.",
        },
        202,
      );
    });
  }
  for (const [path, purpose] of [
    ["/reset-password", "reset_password"],
    ["/verification/confirm", "verify_email"],
  ] as const) {
    app.post(path, async (c) => {
      const input = await read(
        c,
        purpose === "reset_password" ? resetInput : tokenInput,
      );
      if (!input)
        return c.json({ success: false, error: "INVALID_INPUT" }, 400);
      const id = actionId(input.token);
      const invalid = () =>
        c.json({ success: false, error: "INVALID_OR_EXPIRED_TOKEN" }, 400);
      if (
        !id ||
        !(
          await store.execute(
            validAccountAction(id, actionHash(input.token), purpose),
          )
        ).length
      )
        return invalid();
      const passwordHash =
        "newPassword" in input
          ? await hash(input.newPassword as string, 12)
          : null;
      if (
        !(
          await store.execute(
            consumeAccountAction(
              id,
              actionHash(input.token),
              purpose,
              passwordHash,
              newActionId(),
            ),
          )
        ).length
      )
        return invalid();
      if (purpose === "reset_password")
        deleteCookie(c, "iso_refresh_token", { path: "/" });
      return c.json({
        success: true,
        message:
          purpose === "reset_password"
            ? "Password reset. Please log in again."
            : "Email verified.",
      });
    });
  }
  return app;
}
