import { shipmentContactColumns } from "@/db/queries/user-columns";
import { shipmentAccessPredicate, shipmentTransitionStatement, shipmentCreationStatement, type ShipmentActor, type ShipmentTransition } from "./shipment-access";
import { nanoid } from "nanoid";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { db } from "@/db";
import { shipments, shipmentEvents, drivers } from "@/db/schema";
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

export async function findShipmentsByBusiness(
  businessId: string,
  opts: { page?: number; pageSize?: number } = {},
) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(50, opts.pageSize ?? 20);
  const offset = (page - 1) * pageSize;

  const [rows, [totalRow]] = await Promise.all([
    db.query.shipments.findMany({
      where: eq(shipments.businessId, businessId),
      with: {
        driver: { with: { user: { columns: shipmentContactColumns } } },
        customer: { columns: shipmentContactColumns },
      },
      orderBy: desc(shipments.createdAt),
      limit: pageSize,
      offset,
    }),
    db
      .select({ total: count() })
      .from(shipments)
      .where(eq(shipments.businessId, businessId)),
  ]);

  return {
    data: rows,
    pagination: {
      page,
      pageSize,
      total: totalRow?.total ?? 0,
      totalPages: Math.ceil((totalRow?.total ?? 0) / pageSize),
    },
  };
}

export async function findShipmentsByDriver(
  driverId: string,
  opts: { includeCompleted?: boolean } = {},
) {
  const fleetMembership = sql`exists (
    select 1 from ${drivers} as "fleet_driver"
    where "fleet_driver"."id" = ${shipments.driverId}
      and "fleet_driver"."business_id" = ${shipments.businessId}
  )`;
  return db.query.shipments.findMany({
    where: opts.includeCompleted
      ? and(eq(shipments.driverId, driverId), fleetMembership)
      : and(
          eq(shipments.driverId, driverId),
          fleetMembership,
          sql`${shipments.status} NOT IN ('delivered', 'failed', 'cancelled')`,
        ),
    with: {
      customer: { columns: shipmentContactColumns },
      events: { orderBy: desc(shipmentEvents.createdAt), limit: 1 },
    },
    orderBy: desc(shipments.updatedAt),
  });
}

export async function findShipmentsByCustomer(customerId: string) {
  return db.query.shipments.findMany({
    where: eq(shipments.customerId, customerId),
    with: {
      driver: { with: { user: { columns: shipmentContactColumns } } },
      events: { orderBy: desc(shipmentEvents.createdAt), limit: 3 },
    },
    orderBy: desc(shipments.createdAt),
  });
}

// ─── Write ─────────────────────────────────────────────────────────────────────

export async function transitionShipment(actor: ShipmentActor, change: ShipmentTransition): Promise<Shipment | null> {
  const result = await db.execute(shipmentTransitionStatement(shipments, actor, change));
  const row = result.rows[0]?.shipment as Record<string, unknown> | undefined;
  if (!row) return null;
  return shipmentFromDatabaseJson(row);
}

function shipmentFromDatabaseJson(row: Record<string, unknown>): Shipment {
  // Raw SQL returns database column names; preserve the existing API row shape.
  const mapped = Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value,
  ]));
  for (const key of ["scheduledPickup", "actualPickup", "estimatedDelivery", "actualDelivery", "createdAt", "updatedAt"]) {
    if (typeof mapped[key] === "string") mapped[key] = new Date(mapped[key]);
  }
  return mapped as unknown as Shipment;
}

export async function createShipment(data: NewShipment): Promise<Shipment> {
  const result = await db.execute(shipmentCreationStatement(
    db.insert(shipments).values(data).returning(), nanoid(),
  ));
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
