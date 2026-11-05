import { shipmentContactColumns } from "@/db/queries/user-columns";
import {
  shipmentAccessPredicate,
  shipmentTransitionStatement,
  shipmentCreationStatement,
  type ShipmentActor,
  type ShipmentTransition,
} from "./shipment-access";
import { nanoid } from "nanoid";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { shipments, shipmentEvents } from "@/db/schema";
import type { NewShipment, Shipment } from "@/db/schema";

// ─── Read ──────────────────────────────────────────────────────────────────────

// Payment commands need an ownership check, not the complete shipment graph.
export async function findShipmentById(id: string, actor: ShipmentActor) {
  const [row] = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(
      and(
        eq(shipments.id, id),
        shipmentAccessPredicate(shipments, actor),
        sql`exists(select 1 from users where id=${actor.userId} and is_active and role::text=${actor.role})`,
      ),
    )
    .limit(1);
  return row;
}

export async function findShipmentByTrackingId(trackingId: string) {
  return db.query.shipments.findFirst({
    columns: { recipientEmail: false },
    where: eq(shipments.trackingId, trackingId.toUpperCase()),
    with: {
      driver: { with: { user: { columns: shipmentContactColumns } } },
      events: { orderBy: desc(shipmentEvents.createdAt) },
    },
  });
}

// ─── Write ─────────────────────────────────────────────────────────────────────

export async function transitionShipment(
  actor: ShipmentActor,
  change: ShipmentTransition,
): Promise<Shipment | null> {
  const result = await db.execute(
    shipmentTransitionStatement(shipments, actor, change),
  );
  const row = result.rows[0]?.shipment as Record<string, unknown> | undefined;
  if (!row) return null;
  return shipmentFromDatabaseJson(row);
}

function shipmentFromDatabaseJson(row: Record<string, unknown>): Shipment {
  // Raw SQL returns database column names; preserve the existing API row shape.
  const mapped = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
  for (const key of [
    "scheduledPickup",
    "actualPickup",
    "estimatedDelivery",
    "actualDelivery",
    "createdAt",
    "updatedAt",
  ]) {
    if (typeof mapped[key] === "string") mapped[key] = new Date(mapped[key]);
  }
  return mapped as unknown as Shipment;
}

export async function createShipment(data: NewShipment): Promise<Shipment> {
  const result = await db.execute(
    shipmentCreationStatement(
      db.insert(shipments).values(data).returning(),
      nanoid(),
    ),
  );
  const row = result.rows[0]?.shipment as Record<string, unknown> | undefined;
  if (!row) throw new Error("Failed to create shipment");
  return shipmentFromDatabaseJson(row);
}
