import { sql } from "drizzle-orm";
import type { ShipmentActor } from "./shipment-access.ts";
import type { ShipmentPage } from "../../lib/shipment-page.ts";

export function shipmentPageStatement(
  actor: ShipmentActor,
  page: ShipmentPage,
) {
  const scope =
    actor.role === "business"
      ? sql`s.business_id=(select id from businesses where user_id=${actor.userId} order by id limit 1)`
      : actor.role === "driver"
        ? sql`s.driver_id=(select id from drivers where user_id=${actor.userId})
        and s.business_id=(select business_id from drivers where user_id=${actor.userId})
        ${page.includeCompleted ? sql`` : sql`and (s.status not in ('delivered','failed','cancelled') or (s.status='failed' and s.actual_pickup is not null and s.return_state<>'received'))`}`
        : actor.role === "customer"
          ? sql`s.customer_id=${actor.userId}`
          : sql`false`;
  const position = page.position
    ? sql`and (s.created_at,s.id collate "C")<(${page.position.time}::timestamptz,${page.position.id} collate "C")`
    : sql``;
  return sql`with page as materialized (
    select s.* from shipments s where ${scope}
      and exists(select 1 from users u where u.id=${actor.userId} and u.is_active and u.role::text=${actor.role})
      ${position} order by s.created_at desc,s.id collate "C" desc limit ${page.limit + 1}
  ) select jsonb_build_object(
    'shipment',to_jsonb(p) ${actor.role === "business" ? sql`` : sql`-'recipient_email'`},
    'time',to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'customer',(select jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'phone',u.phone,'avatar',u.avatar) from users u where u.id=p.customer_id),
    'driver',(select jsonb_build_object('id',d.id,'vehicleType',d.vehicle_type,'vehiclePlate',d.vehicle_plate,
      'user',jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'phone',u.phone,'avatar',u.avatar))
      from drivers d join users u on u.id=d.user_id where d.id=p.driver_id and d.business_id=p.business_id),
    'events',${
      actor.role === "business"
        ? sql`'[]'::jsonb`
        : sql`(select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc,e.id collate "C" desc),'[]'::jsonb)
      from (select * from shipment_events where shipment_id=p.id order by created_at desc,id collate "C" desc limit ${actor.role === "driver" ? 1 : 3}) e)`
    }
    ) as result from page p order by p.created_at desc,p.id collate "C" desc`;
}
