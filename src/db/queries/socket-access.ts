import { sql } from "drizzle-orm";
import type { SocketIdentity, LocationPayload } from "../../socket/protocol";

// Check sessions in batches to avoid a separate query for each socket.
export function socketAccessStatement(
  identities: readonly SocketIdentity[],
  trackingId?: string,
) {
  const shipment =
    trackingId === undefined
      ? sql`true`
      : sql`exists (
    select 1 from shipments s where s.tracking_id = ${trackingId} and (
      (u.role = 'customer' and s.customer_id = u.id) or
      (u.role = 'business' and exists (select 1 from businesses b where b.id=s.business_id and b.user_id=u.id)) or
      (u.role = 'driver' and exists (select 1 from drivers d where d.id=s.driver_id and d.user_id=u.id and d.business_id=s.business_id))
    ))`;
  return sql`select i."socketId" as socket_id, u.role from
    jsonb_to_recordset(${JSON.stringify(identities)}::jsonb)
      as i("socketId" text, "userId" text, "sessionId" text, "expiresAt" double precision)
    join auth_sessions a on a.id=i."sessionId" and a.user_id=i."userId"
    join users u on u.id=a.user_id
    where a.revoked_at is null and a.expires_at > statement_timestamp()
      and i."expiresAt" > extract(epoch from statement_timestamp())
      and u.is_active and u.credential_version=a.credential_version and ${shipment}`;
}

// Check access, event order and update frequency in the same UPDATE.
// PostgreSQL rechecks the shipment after waiting for a competing writer.
export function recordSocketLocationStatement(
  identity: SocketIdentity,
  location: LocationPayload,
) {
  return sql`update shipments s set current_location = jsonb_build_object(
      'lat', ${location.lat}::double precision, 'lng', ${location.lng}::double precision,
      'heading', ${location.heading ?? 0}::double precision, 'speed', ${location.speed ?? 0}::double precision,
      'timestamp', ${location.timestamp}::bigint,
      'receivedAt', floor(extract(epoch from statement_timestamp())*1000)),
      updated_at=statement_timestamp()
    from drivers d, users u, auth_sessions a
    where s.tracking_id=${location.trackingId} and s.driver_id=d.id and s.business_id=d.business_id
      and d.user_id=${identity.userId} and u.id=d.user_id and u.role='driver' and u.is_active
      and a.id=${identity.sessionId} and a.user_id=u.id and a.revoked_at is null
      and a.credential_version=u.credential_version and a.expires_at>statement_timestamp()
      and ${identity.expiresAt} > extract(epoch from statement_timestamp())
      and (s.status in ('assigned','picked_up','in_transit','out_for_delivery') or (s.status='failed' and s.return_state='in_transit'))
      and ${location.timestamp} >= extract(epoch from statement_timestamp())*1000-30000
      and ${location.timestamp} <= extract(epoch from statement_timestamp())*1000+5000
      and (case when jsonb_typeof(s.current_location->'receivedAt')='number'
        then (s.current_location->>'receivedAt')::numeric else 0 end) <= extract(epoch from statement_timestamp())*1000-1000
      and (case when jsonb_typeof(s.current_location->'timestamp')='number'
        then (s.current_location->>'timestamp')::numeric else -1 end) < ${location.timestamp}
    returning s.id`;
}
