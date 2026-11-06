import { sql } from "drizzle-orm";
import type { ShipmentActor } from "./shipment-access.ts";
import type { ShipmentPage } from "../../lib/shipment-page.ts";

// Keep API fields explicit: adding a database column must not publish it.
const shipmentFields = [
  "id",
  "tracking_id",
  "status",
  "version",
  "failure_reason",
  "failed_at",
  "attempt_number",
  "return_state",
  "returned_at",
  "business_id",
  "driver_id",
  "customer_id",
  "description",
  "weight_kg",
  "dimensions",
  "pickup_address",
  "delivery_address",
  "current_location",
  "scheduled_pickup",
  "actual_pickup",
  "estimated_delivery",
  "actual_delivery",
  "price_kobo",
  "is_paid",
  "created_at",
  "updated_at",
];
const camel = (key: string) =>
  key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function fields(alias: string, names: string[]) {
  return sql`jsonb_build_object(${sql.join(
    names.flatMap((name) => [
      sql`${camel(name)}::text`,
      sql`${sql.identifier(alias)}.${sql.identifier(name)}`,
    ]),
    sql`,`,
  )})`;
}
function active(actor: ShipmentActor) {
  return sql`exists(select 1 from users where id=${actor.userId} and is_active and role::text=${actor.role})`;
}
function projection(actor: ShipmentActor) {
  const columns =
    actor.role === "business"
      ? [...shipmentFields, "recipient_email"]
      : shipmentFields;
  return sql`${fields("s", columns)} || jsonb_build_object(
    'customer',(select ${fields("u", ["id", "name", "email", "phone", "avatar"])} from users u where u.id=s.customer_id),
    'driver',(select ${fields("d", ["id", "vehicle_type", "vehicle_plate"])} || jsonb_build_object('user',${fields("u", ["id", "name", "email", "phone", "avatar"])})
      from drivers d join users u on u.id=d.user_id where d.id=s.driver_id and d.business_id=s.business_id))`;
}
function scope(actor: ShipmentActor) {
  return actor.role === "business"
    ? sql`exists(select 1 from businesses where id=s.business_id and user_id=${actor.userId})`
    : actor.role === "driver"
      ? sql`exists(select 1 from drivers where id=s.driver_id and user_id=${actor.userId} and business_id=s.business_id)`
      : actor.role === "customer"
        ? sql`s.customer_id=${actor.userId}`
        : sql`false`;
}
export function shipmentDetailStatement(actor: ShipmentActor, id: string) {
  return sql`select ${projection(actor)} || jsonb_build_object(
    'payment',case when ${actor.role}='driver' then null else (
      select ${fields("p", ["id", "amount_kobo", "status", "channel", "paid_at", "created_at"])}
      from payments p where p.shipment_id=s.id order by p.created_at desc,p.id collate "C" desc limit 1) end,
    'events',coalesce((select jsonb_agg(e.payload order by e.created_at desc,e.id collate "C" desc) from (
      select ${fields("e", ["id", "shipment_id", "status", "message", "location", "created_at"])} payload,e.created_at,e.id
      from shipment_events e where e.shipment_id=s.id order by e.created_at desc,e.id collate "C" desc limit 50) e),'[]'::jsonb),
    'eventsTruncated',(select count(*)>50 from (select 1 from shipment_events where shipment_id=s.id limit 51) e)
  ) as result from shipments s where s.id=${id} and ${scope(actor)} and ${active(actor)}`;
}
export function shipmentEventsStatement(
  actor: ShipmentActor,
  id: string,
  page: ShipmentPage,
) {
  const position = page.position
    ? sql`and (e.created_at,e.id collate "C") < (${page.position.time}::timestamptz,${page.position.id} collate "C")`
    : sql``;
  // The outer row distinguishes an authorized empty history from a foreign ID.
  return sql`select jsonb_build_object('events',coalesce((
    select jsonb_agg(jsonb_build_object('event',e.payload,'time',e.time) order by e.created_at desc,e.id collate "C" desc)
    from (select ${fields("e", ["id", "shipment_id", "status", "message", "location", "created_at"])} payload,e.created_at,e.id,
      to_char(e.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') time
      from shipment_events e where e.shipment_id=s.id ${position}
      order by e.created_at desc,e.id collate "C" desc limit ${page.limit + 1}) e
  ),'[]'::jsonb)) as result from shipments s where s.id=${id} and ${scope(actor)} and ${active(actor)}`;
}
export function businessAnalyticsStatement(actor: ShipmentActor) {
  return sql`with owned as materialized (
    select id from businesses where user_id=${actor.userId} and ${actor.role}='business' and ${active(actor)} order by id limit 1
  ), stats as (
    select status,count(*) n,sum(price_kobo::bigint) amount from shipments where business_id=(select id from owned) group by status
  ) select jsonb_build_object(
    'statusBreakdown',coalesce((select jsonb_object_agg(status,n) from stats),'{}'::jsonb),
    'totalShipments',coalesce((select sum(n) from stats),0)::text,
    'totalRevenueKobo',coalesce((select sum(amount) from stats),0)::text,
    'recentShipments',coalesce((select jsonb_agg(r.payload order by r.created_at desc,r.id collate "C" desc) from (
      select ${projection(actor)} payload,s.created_at,s.id from shipments s where s.business_id=(select id from owned)
      order by s.created_at desc,s.id collate "C" desc limit 10) r),'[]'::jsonb)
  ) as result where ${actor.role}='business' and ${active(actor)}`;
}
