import { shipmentContactColumns } from "@/db/queries/user-columns";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { db } from "@/db";
import { shipments, shipmentEvents } from "@/db/schema";
import type { NewShipment, Shipment, NewShipmentEvent } from "@/db/schema";

// ─── Read ──────────────────────────────────────────────────────────────────────

export async function findShipmentById(id: string) {
  return db.query.shipments.findFirst({
    where: eq(shipments.id, id),
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
  return db.query.shipments.findMany({
    where: opts.includeCompleted
      ? eq(shipments.driverId, driverId)
      : and(
          eq(shipments.driverId, driverId),
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

export async function createShipment(data: NewShipment): Promise<Shipment> {
  const [shipment] = await db.insert(shipments).values(data).returning();
  if (!shipment) throw new Error("Failed to create shipment");
  return shipment;
}

export async function updateShipment(
  id: string,
  data: Partial<Shipment>,
): Promise<Shipment | null> {
  const [shipment] = await db
    .update(shipments)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(shipments.id, id))
    .returning();
  return shipment ?? null;
}

export async function addShipmentEvent(data: NewShipmentEvent) {
  const [event] = await db.insert(shipmentEvents).values(data).returning();
  if (!event) throw new Error("Failed to create shipment event");
  return event;
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
