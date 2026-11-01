import { sql, type AnyColumn, type SQL, type SQLWrapper } from "drizzle-orm";

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
          and "assigned_driver"."business_id" = ${columns.businessId}
      )`;
    case "customer":
      return sql`${columns.customerId} = ${actor.userId}`;
    default:
      return sql`false`;
  }
}

export const shipmentTransitions: Record<string, readonly string[]> = {
  pending: ["assigned", "cancelled"],
  assigned: ["picked_up", "failed", "cancelled"],
  picked_up: ["in_transit"],
  in_transit: ["out_for_delivery"],
  out_for_delivery: ["delivered", "failed"],
  delivered: [], failed: ["pending"], cancelled: [],
};

export interface ShipmentTransition {
  shipmentId: string;
  expectedStatus: string;
  status: string;
  eventId: string;
  message: string;
  driverId?: string;
}

export function shipmentCreationStatement(insert: SQLWrapper, eventId: string) {
  return sql`with created as (${insert.getSQL()}), recorded as (
    insert into shipment_events(id,shipment_id,status,message)
    select ${eventId},id,status,'Shipment created' from created returning shipment_id
  ) select to_jsonb(created) as shipment from created join recorded on recorded.shipment_id = created.id`;
}

export function shipmentTransitionStatement(
  columns: ShipmentColumns,
  actor: ShipmentActor,
  change: ShipmentTransition,
) {
  if (!shipmentTransitions[change.expectedStatus]?.includes(change.status)) {
    throw new Error("Invalid shipment transition");
  }
  const allowedActor = actor.role === "business" || (
    actor.role === "driver" && !["assigned", "pending", "cancelled"].includes(change.status)
  );
  const assignment = change.status === "assigned"
    ? sql`exists (select 1 from drivers d join users u on u.id = d.user_id
        where d.id = ${change.driverId ?? null} and d.business_id = shipments.business_id
          and u.is_active = true and u.role = 'driver')`
    : sql`true`;

  return sql`with changed as (
    update shipments set status = ${change.status}::shipment_status,
      driver_id = case when ${change.status} = 'assigned' then ${change.driverId ?? null}
        when ${change.status} = 'pending' then null else driver_id end,
      actual_pickup = case when ${change.status} = 'picked_up' then statement_timestamp()
        when ${change.status} = 'pending' then null else actual_pickup end,
      actual_delivery = case when ${change.status} = 'delivered' then statement_timestamp()
        when ${change.status} = 'pending' then null else actual_delivery end,
      updated_at = statement_timestamp()
    where id = ${change.shipmentId} and status = ${change.expectedStatus}::shipment_status
      and ${allowedActor ? sql`true` : sql`false`}
      and ${shipmentAccessPredicate(columns, actor)} and ${assignment}
    returning *
  ), recorded as (
    insert into shipment_events(id,shipment_id,status,message)
    select ${change.eventId},id,status,${change.message} from changed returning shipment_id
  )
  select to_jsonb(changed) as shipment from changed join recorded on recorded.shipment_id = changed.id`;
}
