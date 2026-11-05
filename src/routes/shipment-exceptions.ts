import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  WriteError,
  requireIdempotencyKey,
  hashValue,
  requestFingerprint,
  type WriteStore,
} from "../lib/idempotency.ts";
const version = z.number().int().min(0).max(2147483646);
const reason = z.enum([
  "recipient_unavailable",
  "recipient_refused",
  "address_incorrect",
  "recipient_code_unavailable",
  "package_damaged",
  "vehicle_issue",
  "other",
]);
const input = z.union([
  z
    .object({
      action: z.literal("fail"),
      expectedVersion: version,
      reason,
      note: z.string().trim().max(1000).default(""),
    })
    .strict()
    .refine((v) => v.reason !== "other" || v.note.length > 0),
  z
    .object({
      action: z.enum([
        "retry",
        "return_request",
        "return_start",
        "return_receive",
        "cancel_failed",
      ]),
      expectedVersion: version,
      note: z.string().trim().max(1000).default(""),
    })
    .strict(),
]);
const resultSchema = z.object({
  response: z.record(z.unknown()).optional(),
  replayed: z.boolean().optional(),
  error: z.string().optional(),
  status: z.number().optional(),
});
const camel = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      v,
    ]),
  );
export function createShipmentExceptionRouter(store: WriteStore) {
  const router = new Hono();
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  router.get("/:id/exceptions", async (c) => {
    const user = c.get("userId"),
      role = c.get("userRole");
    if (!user) return c.json({ success: false, error: "UNAUTHORIZED" }, 401);
    if (!["business", "driver"].includes(role))
      return c.json({ success: false, error: "FORBIDDEN" }, 403);
    const params = new URL(c.req.url).searchParams;
    for (const k of params.keys())
      if (
        !["limit", "beforeVersion"].includes(k) ||
        params.getAll(k).length !== 1
      )
        return c.json({ success: false, error: "INVALID_REQUEST" }, 400);
    const limit = params.get("limit") ?? "20",
      before = params.get("beforeVersion");
    if (
      !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit) ||
      (before !== null &&
        (!/^[1-9][0-9]{0,9}$/.test(before) || Number(before) > 2147483647)) ||
      !/^[-_A-Za-z0-9]{1,128}$/.test(c.req.param("id"))
    )
      return c.json({ success: false, error: "INVALID_REQUEST" }, 400);
    const predicate = sql`exists(select 1 from shipments s join users u on u.id=${user} and u.is_active and u.role::text=${role}
   where s.id=${c.req.param("id")} and ((${role}='business' and exists(select 1 from businesses b where b.id=s.business_id and b.user_id=${user})) or
    (${role}='driver' and exists(select 1 from drivers d where d.id=s.driver_id and d.business_id=s.business_id and d.user_id=${user}))))`;
    const allowed = await store.execute(
      sql`select json_build_object('allowed',true) as result where ${predicate}`,
    );
    if (!allowed[0]) return c.json({ success: false, error: "NOT_FOUND" }, 404);
    const rows =
      await store.execute(sql`select to_jsonb(e) as result from shipment_exceptions e where e.shipment_id=${c.req.param("id")} and ${predicate}
   ${before === null ? sql`` : sql`and e.version<${Number(before)}`} order by e.version desc limit ${Number(limit) + 1}`);
    const data = rows.slice(0, Number(limit)),
      hasMore = rows.length > Number(limit);
    return c.json({
      success: true,
      data: data.map(camel),
      pagination: {
        limit: Number(limit),
        hasMore,
        nextBeforeVersion: hasMore ? data.at(-1)?.version : null,
      },
    });
  });
  router.post("/:id/exceptions", bodyLimit({ maxSize: 4096 }), async (c) => {
    try {
      const actor = c.get("userId"),
        role = c.get("userRole");
      if (!actor)
        throw new WriteError(401, "UNAUTHORIZED", "Authentication required");
      if (!["business", "driver"].includes(role))
        throw new WriteError(403, "FORBIDDEN", "Fleet access required");
      const key = requireIdempotencyKey(c.req.header("Idempotency-Key"));
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new WriteError(400, "INVALID_REQUEST", "Invalid JSON request");
      }
      const parsed = input.safeParse(body);
      if (!parsed.success || !/^[-_A-Za-z0-9]{1,128}$/.test(c.req.param("id")))
        throw new WriteError(
          400,
          "INVALID_REQUEST",
          "Provide a valid action, reason and expectedVersion",
        );
      const data = { ...parsed.data, shipmentId: c.req.param("id") };
      const result = resultSchema.parse(
        (
          await store.execute(
            sql`select execute_shipment_exception(${nanoid()},${actor},${role},${hashValue(key)},${requestFingerprint(data)},${JSON.stringify(data)}::jsonb,${nanoid()}) as result`,
          )
        )[0],
      );
      if (result.error)
        return c.json(
          { success: false, error: result.error },
          result.status === 404
            ? 404
            : result.status === 403
              ? 403
              : result.status === 410
                ? 410
                : result.status === 422
                  ? 422
                  : 409,
        );
      if (!result.response || typeof result.replayed !== "boolean")
        throw new Error("Invalid exception result");
      c.header("Idempotency-Replayed", String(result.replayed));
      const row = { ...result.response };
      if (role !== "business") delete row.recipient_email;
      return c.json({ success: true, data: camel(row) });
    } catch (e) {
      if (e instanceof WriteError)
        return c.json(
          { success: false, error: e.code, message: e.message },
          e.status,
        );
      throw e;
    }
  });
  return router;
}
