import { and, eq } from "drizzle-orm";
import { fleetAccessPredicate } from "./fleet-access";
import { db } from "@/db";
import { drivers } from "@/db/schema";
import type { Driver, NewDriver } from "@/db/schema";
import type { Coordinates } from "@/types";

// ─── Read ──────────────────────────────────────────────────────────────────────

export async function findDriverById(id: string, ownerUserId: string) {
  return db.query.drivers.findFirst({
    where: and(
      eq(drivers.id, id),
      fleetAccessPredicate(drivers.businessId, ownerUserId),
    ),
    with: { user: true },
  });
}

export async function findDriverByUserId(userId: string) {
  return db.query.drivers.findFirst({
    where: eq(drivers.userId, userId),
    with: { user: true },
  });
}

// ─── Write ─────────────────────────────────────────────────────────────────────

export async function createDriver(data: NewDriver): Promise<Driver> {
  const [driver] = await db.insert(drivers).values(data).returning();
  if (!driver) throw new Error("Failed to create driver");
  return driver;
}

export async function updateDriverStatus(
  id: string,
  status: Driver["status"],
): Promise<Driver | null> {
  const [driver] = await db
    .update(drivers)
    .set({ status, updatedAt: new Date() })
    .where(eq(drivers.id, id))
    .returning();
  return driver ?? null;
}

export async function updateDriverLocation(
  id: string,
  location: Coordinates,
): Promise<Driver | null> {
  const [driver] = await db
    .update(drivers)
    .set({ currentLocation: location, updatedAt: new Date() })
    .where(eq(drivers.id, id))
    .returning();
  return driver ?? null;
}

export async function incrementDriverDeliveries(id: string): Promise<void> {
  const driver = await db.query.drivers.findFirst({
    where: eq(drivers.id, id),
  });
  if (!driver) return;
  await db
    .update(drivers)
    .set({ totalDeliveries: driver.totalDeliveries + 1, updatedAt: new Date() })
    .where(eq(drivers.id, id));
}
