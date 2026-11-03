import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  WriteError,
  requireIdempotencyKey,
  type WriteActor,
  type WriteResult,
} from "../lib/idempotency.ts";
import { shipmentInput, checkoutInput } from "../lib/write-inputs.ts";
import type { createIdempotentWrites } from "../services/idempotent-writes";

interface Dependencies {
  authorize: MiddlewareHandler;
  writes: ReturnType<typeof createIdempotentWrites>;
}
async function handle(
  c: Context,
  write: (
    body: unknown,
    key: string,
    actor: WriteActor,
  ) => Promise<WriteResult>,
) {
  c.header("Cache-Control", "no-store");
  try {
    const user = c.get("user");
    if (!user || !c.get("userId") || !c.get("userRole"))
      throw new WriteError(401, "UNAUTHORIZED", "Authentication required");
    const key = requireIdempotencyKey(c.req.header("Idempotency-Key"));
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new WriteError(400, "INVALID_REQUEST", "Invalid JSON request body");
    }
    const result = await write(body, key, {
      userId: c.get("userId"),
      role: c.get("userRole"),
      email: user.email,
    });
    c.header("Idempotency-Replayed", String(result.replayed));
    return c.json(result.body, result.status);
  } catch (error) {
    if (error instanceof WriteError) {
      if (error.code === "IDEMPOTENCY_IN_PROGRESS")
        c.header("Retry-After", "1");
      return c.json(
        {
          success: false,
          error: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        error.status,
      );
    }
    throw error;
  }
}
export function createShipmentCreationRouter(deps: Dependencies) {
  const router = new Hono();
  router.post("/", deps.authorize, bodyLimit({ maxSize: 16384 }), (c) =>
    handle(c, (body, key, actor) => {
      const parsed = shipmentInput.safeParse(body);
      if (!parsed.success)
        throw new WriteError(400, "INVALID_REQUEST", "Invalid request body");
      return deps.writes.createShipment(parsed.data, key, actor);
    }),
  );
  return router;
}
export function createCheckoutInitializationRouter(deps: Dependencies) {
  const router = new Hono();
  router.post(
    "/initialize",
    deps.authorize,
    bodyLimit({ maxSize: 4096 }),
    (c) =>
      handle(c, (body, key, actor) => {
        const parsed = checkoutInput.safeParse(body);
        if (!parsed.success)
          throw new WriteError(400, "INVALID_REQUEST", "Invalid request body");
        return deps.writes.initializeCheckout(parsed.data, key, actor);
      }),
  );
  return router;
}
