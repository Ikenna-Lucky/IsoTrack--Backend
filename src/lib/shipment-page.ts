import { z } from "zod";
import { hashValue, WriteError } from "./idempotency.ts";
import type { ShipmentActor } from "../db/queries/shipment-access.ts";

const positionSchema = z
  .object({
    v: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    time: z
      .string()
      .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/)
      .refine((s) => {
        const date = new Date(s);
        return (
          Number.isFinite(date.getTime()) &&
          date.toISOString().slice(0, 23) === s.slice(0, 23)
        );
      }),
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type ShipmentPosition = z.infer<typeof positionSchema>;
export interface ShipmentPage {
  limit: number;
  includeCompleted: boolean;
  scope: string;
  position: ShipmentPosition | null;
}
const invalid = () =>
  new WriteError(
    400,
    "INVALID_PAGINATION",
    "Use limit=1–50 and a valid cursor for this account and filter",
  );
export function parseShipmentPage(
  params: URLSearchParams,
  actor: ShipmentActor,
): ShipmentPage {
  for (const name of params.keys())
    if (
      !["limit", "cursor", "includeCompleted"].includes(name) ||
      params.getAll(name).length !== 1
    )
      throw invalid();
  const value = params.get("limit") ?? "20";
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) throw invalid();
  const completed = params.get("includeCompleted");
  if (
    completed !== null &&
    (actor.role !== "driver" || !["true", "false"].includes(completed))
  )
    throw invalid();
  const includeCompleted = completed === "true";
  const scope = hashValue(
    JSON.stringify([actor.userId, actor.role, includeCompleted]),
  );
  let position: ShipmentPosition | null = null;
  const cursor = params.get("cursor");
  if (cursor !== null) {
    if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw invalid();
    try {
      const bytes = Buffer.from(cursor, "base64url");
      if (bytes.toString("base64url") !== cursor) throw invalid();
      position = positionSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (position.scope !== scope) throw invalid();
    } catch {
      throw invalid();
    }
  }
  return { limit: Number(value), includeCompleted, scope, position };
}
export function shipmentCursor(scope: string, time: string, id: string) {
  return Buffer.from(
    JSON.stringify(positionSchema.parse({ v: 1, scope, time, id })),
  ).toString("base64url");
}
