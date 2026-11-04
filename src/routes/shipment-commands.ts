import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import {
  hashValue,
  requestFingerprint,
  requireIdempotencyKey,
  WriteError,
  type WriteStore,
} from "../lib/idempotency.ts";

const version = z.number().int().min(0).max(2147483646);
const statusInput = z
  .object({
    expectedVersion: version,
    status: z.enum([
      "pending",
      "picked_up",
      "in_transit",
      "out_for_delivery",
      "delivered",
      "failed",
      "cancelled",
    ]),
    note: z.string().trim().max(1000).default(""),
  })
  .strict();
const assignInput = z
  .object({
    expectedVersion: version,
    driverId: z.string().trim().min(1).max(128),
  })
  .strict();
const cancelInput = z.object({ expectedVersion: version }).strict();
const resultSchema = z.object({
  error: z.string().optional(),
  status: z
    .union([
      z.literal(403),
      z.literal(404),
      z.literal(409),
      z.literal(410),
      z.literal(422),
    ])
    .optional(),
  response: z.record(z.unknown()).optional(),
  replayed: z.boolean().optional(),
});

export function createShipmentCommandRouter(store: WriteStore) {
  const router = new Hono();
  async function command(c: Context, action: "status" | "assign" | "cancel") {
    c.header("Cache-Control", "no-store");
    try {
      const userId = c.get("userId"),
        role = c.get("userRole");
      if (!userId || !role)
        throw new WriteError(401, "UNAUTHORIZED", "Authentication required");
      if (!["business", "driver"].includes(role))
        throw new WriteError(
          403,
          "FORBIDDEN",
          "Shipment updates require fleet access",
        );
      const key = requireIdempotencyKey(c.req.header("Idempotency-Key"));
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        throw new WriteError(
          400,
          "INVALID_REQUEST",
          "Invalid JSON request body",
        );
      }
      const parsed = (
        action === "status"
          ? statusInput
          : action === "assign"
            ? assignInput
            : cancelInput
      ).safeParse(input);
      if (!parsed.success)
        throw new WriteError(
          400,
          "INVALID_REQUEST",
          "Provide valid command data and expectedVersion",
        );
      const data = { ...parsed.data, shipmentId: c.req.param("id"), action };
      if (!data.shipmentId || data.shipmentId.length > 128)
        throw new WriteError(400, "INVALID_REQUEST", "Invalid shipment ID");
      const rows = await store.execute(
        sql`select execute_shipment_command(${nanoid()},${userId},${role},${hashValue(key)},${requestFingerprint(data)},${JSON.stringify(data)}::jsonb,${nanoid()}) as result`,
      );
      const result = resultSchema.parse(rows[0]);
      if (result.error)
        return c.json(
          {
            success: false,
            error: result.error,
            message:
              result.error === "SHIPMENT_VERSION_CONFLICT"
                ? "Shipment changed; reload before trying again"
                : "Shipment command could not be completed",
          },
          result.status ?? 409,
        );
      if (!result.response || typeof result.replayed !== "boolean")
        throw new Error("Invalid shipment command result");
      c.header("Idempotency-Replayed", String(result.replayed));
      const shipment = Object.fromEntries(
        Object.entries(result.response)
          .filter(([key]) => role === "business" || key !== "recipient_email")
          .map(([key, value]) => [
            key.replace(/_([a-z])/g, (_, letter: string) =>
              letter.toUpperCase(),
            ),
            value,
          ]),
      );
      return c.json({
        success: true,
        data: shipment,
        message:
          action === "assign"
            ? "Driver assigned"
            : action === "cancel"
              ? "Shipment cancelled"
              : "Status updated",
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
  router.use("*", bodyLimit({ maxSize: 4096 }));
  router.patch("/:id/status", (c) => command(c, "status"));
  router.patch("/:id/assign", (c) => command(c, "assign"));
  router.delete("/:id", (c) => command(c, "cancel"));
  return router;
}
