import { sql, type AnyColumn, type SQL } from "drizzle-orm";

export interface ShipmentActor {
  userId: string;
  role: "business" | "driver" | "customer";
}

interface ShipmentColumns {
  businessId: AnyColumn;
  driverId: AnyColumn;
  customerId: AnyColumn;
}

export function shipmentAccessPredicate(
  columns: ShipmentColumns,
  actor: ShipmentActor,
): SQL {
  switch (actor.role) {
    case "business":
      return sql`exists (
        select 1 from "businesses" as "owner_business"
        where "owner_business"."id" = ${columns.businessId}
          and "owner_business"."user_id" = ${actor.userId}
      )`;
    case "driver":
      return sql`exists (
        select 1 from "drivers" as "assigned_driver"
        where "assigned_driver"."id" = ${columns.driverId}
          and "assigned_driver"."user_id" = ${actor.userId}
      )`;
    case "customer":
      return sql`${columns.customerId} = ${actor.userId}`;
    default:
      return sql`false`;
  }
}
