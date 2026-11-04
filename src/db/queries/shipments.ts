import { shipmentContactColumns } from "@/db/queries/user-columns";
import {
  shipmentAccessPredicate,
  shipmentTransitionStatement,
  shipmentCreationStatement,
  type ShipmentActor,
  type ShipmentTransition,
} from "./shipment-access";
import { nanoid } from "nanoid";
import { eq, and, desc, count } from "drizzle-orm";
import { db } from "@/db";
import { shipments, shipmentEvents } from "@/db/schema";
import type { NewShipment, Shipment } from "@/db/schema";

// ─── Read ──────────────────────────────────────────────────────────────────────

export async function findShipmentById(id: string, actor: ShipmentActor) {
  return db.query.shipments.findFirst({
    where: and(eq(shipments.id, id), shipmentAccessPredicate(shipments, actor)),
    with: {
      driver: { with: { user: { columns: shipmentContactColumns } } },
      customer: { columns: shipmentContactColumns },
      events: { orderBy: desc(shipmentEvents.createdAt) },
      payment: true,
    },
  });
}

export async function findShipmentByTrackingId(trackingId: string) {
  return db.query.shipments.findFirst({
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

// ─── Analytics ─────────────────────────────────────────────────────────────────

export async function getBusinessShipmentStats(businessId: string) {
  const rows = await db
    .select({
      status: shipments.status,
      count: count(),
    })
    .from(shipments)
    .where(eq(shipments.businessId, businessId))
    .groupBy(shipments.status);

  return rows.reduce(
    (acc, row) => {
      acc[row.status] = row.count;
      return acc;
    },
    {} as Record<string, number>,
  );
}
