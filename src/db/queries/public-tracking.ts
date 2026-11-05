import { sql } from "drizzle-orm";

export function publicTrackingStatement(trackingId: string) {
  // No account/profile joins, address JSON or free-text messages cross this boundary.
  return sql`select jsonb_build_object(
    'trackingId',s.tracking_id,'status',s.status,'scheduledPickup',s.scheduled_pickup,
    'estimatedDelivery',s.estimated_delivery,'actualDelivery',s.actual_delivery,
    'events',coalesce((select jsonb_agg(jsonb_build_object('status',e.status,'createdAt',e.created_at)
      order by e.created_at desc,e.id collate "C" desc) from (
      select id,status,created_at from shipment_events where shipment_id=s.id
      order by created_at desc,id collate "C" desc limit 21) e),'[]'::jsonb)
    ) as result from shipments s where s.tracking_id=${trackingId}`;
}
