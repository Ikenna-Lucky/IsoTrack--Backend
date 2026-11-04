import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import {
  hashValue,
  requireIdempotencyKey,
  WriteError,
  type WriteStore,
} from "../lib/idempotency.ts";
import {
  deliveryCode,
  deliveryProof,
  deliveryFingerprint,
} from "../lib/delivery-code.ts";
const version = z.number().int().min(0).max(2147483645);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const issue = z
  .object({
    expectedVersion: version,
    recipientEmail: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
  })
  .strict();
const confirm = z
  .object({
    expectedVersion: version,
    challengeId: id,
    code: z.string().regex(/^\d{8}$/),
  })
  .strict();
const resultSchema = z.object({
  error: z.string().optional(),
  status: z.number().optional(),
  response: z.record(z.unknown()).optional(),
  replayed: z.boolean().optional(),
});
const camel = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      v,
    ]),
  );
export function createDeliveryRouter(
  store: WriteStore,
  secret: string | undefined,
) {
  const router = new Hono();
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  router.get("/:id/delivery-code", async (c) => {
    if (!id.safeParse(c.req.param("id")).success)
      return c.json({ success: false, error: "INVALID_REQUEST" }, 400);
    const user = c.get("userId"),
      role = c.get("userRole");
    if (!user) return c.json({ success: false, error: "UNAUTHORIZED" }, 401);
    const rows =
      await store.execute(sql`select jsonb_build_object('challengeId',d.id,'version',d.shipment_version,'expiresAt',d.expires_at,'deliveryState',d.delivery_state) as result
   from delivery_confirmations d join shipments s on s.id=d.shipment_id join users u on u.id=${user} and u.is_active and u.role::text=${role}
   where s.id=${c.req.param("id")} and s.status='out_for_delivery' and d.shipment_version=s.version and d.driver_id=s.driver_id
    and d.email=s.recipient_email and d.revoked_at is null and d.consumed_at is null and d.failures<5 and d.expires_at>statement_timestamp()
    and ((${role}='business' and exists(select 1 from businesses b where b.id=s.business_id and b.user_id=${user})) or
      (${role}='driver' and exists(select 1 from drivers dr where dr.id=s.driver_id and dr.business_id=s.business_id and dr.user_id=${user}))) limit 1`);
    return rows[0]
      ? c.json({ success: true, data: rows[0] })
      : c.json({ success: false, error: "NOT_FOUND" }, 404);
  });
  router.use("*", bodyLimit({ maxSize: 2048 }));
  async function execute(c: Context, action: "issue" | "confirm") {
    try {
      const actor = c.get("userId"),
        role = c.get("userRole");
      if (!actor)
        throw new WriteError(401, "UNAUTHORIZED", "Authentication required");
      if (role !== (action === "issue" ? "business" : "driver"))
        throw new WriteError(403, "FORBIDDEN", "Delivery action not permitted");
      if (!secret)
        throw new WriteError(
          503,
          "DELIVERY_UNAVAILABLE",
          "Delivery confirmation is not configured",
        );
      const key = requireIdempotencyKey(c.req.header("Idempotency-Key"));
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new WriteError(400, "INVALID_REQUEST", "Invalid JSON");
      }
      const parsed = (action === "issue" ? issue : confirm).safeParse(body);
      if (!parsed.success || !id.safeParse(c.req.param("id")).success)
        throw new WriteError(
          400,
          "INVALID_REQUEST",
          "Invalid delivery request",
        );
      const data = { ...parsed.data, action, shipmentId: c.req.param("id") };
      const challenge =
        action === "issue"
          ? nanoid()
          : String((parsed.data as z.infer<typeof confirm>).challengeId);
      const proof = deliveryProof(
        challenge,
        action === "issue"
          ? deliveryCode(challenge, secret)
          : (parsed.data as z.infer<typeof confirm>).code,
        secret,
      );
      const safe = { ...data } as Record<string, unknown>;
      delete safe.code;
      const result = resultSchema.parse(
        (
          await store.execute(
            sql`select delivery_command(${nanoid()},${actor},${role},${hashValue(key)},${deliveryFingerprint(data, secret)},${JSON.stringify(safe)}::jsonb,${challenge},${proof},${nanoid()}) as result`,
          )
        )[0],
      );
      const response: Record<string, unknown> = result.response ?? result;
      if (result.replayed !== undefined)
        c.header("Idempotency-Replayed", String(result.replayed));
      const status = response.status;
      if (response.error)
        return c.json(
          { success: false, error: String(response.error) },
          status === 404
            ? 404
            : status === 410
              ? 410
              : status === 422
                ? 422
                : 409,
        );
      const shipment = response.shipment as Record<string, unknown> | undefined;
      if (shipment) delete shipment.recipient_email;
      return c.json({
        success: true,
        data: shipment ? camel(shipment) : response,
      });
    } catch (error) {
      if (error instanceof WriteError)
        return c.json(
          { success: false, error: error.code, message: error.message },
          error.status,
        );
      throw error;
    }
  }
  router.post("/:id/delivery-code", (c) => execute(c, "issue"));
  router.post("/:id/confirm-delivery", (c) => execute(c, "confirm"));
  return router;
}
