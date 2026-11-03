import { sql } from "drizzle-orm";
import type { WriteActor } from "../../lib/idempotency";

export type WriteOperation = "shipments.create" | "payments.initialize";
export interface Reservation {
  id: string;
  userId: string;
  operation: WriteOperation;
  keyHash: string;
  requestHash: string;
  resourceId: string;
  parameters: Record<string, unknown>;
}
const record = sql`jsonb_build_object('id',id,'requestHash',request_hash,'parameters',parameters,
  'resourceId',resource_id,'response',response,'state',state,
  'expired',expires_at<=statement_timestamp(),'providerSafe',created_at+interval '23 hours'>statement_timestamp())`;

export function findRequestStatement(
  userId: string,
  operation: WriteOperation,
  keyHash: string,
) {
  return sql`select ${record} as result from idempotency_requests where user_id=${userId} and operation=${operation} and key_hash=${keyHash}`;
}
export function reserveRequestStatement(r: Reservation) {
  return sql`insert into idempotency_requests(id,user_id,operation,key_hash,request_hash,resource_id,parameters)
    values(${r.id},${r.userId},${r.operation},${r.keyHash},${r.requestHash},${r.resourceId},${JSON.stringify(r.parameters)}::jsonb)
    on conflict(user_id,operation,key_hash) do update set key_hash=excluded.key_hash
    returning ${record} as result`;
}
export function claimRequestStatement(
  id: string,
  userId: string,
  token: string,
) {
  return sql`update idempotency_requests set lease_token=${token},lease_until=statement_timestamp()+interval '60 seconds'
    where id=${id} and user_id=${userId} and state='pending' and expires_at>statement_timestamp()
      and (operation<>'payments.initialize' or created_at+interval '23 hours'>statement_timestamp())
      and (lease_until is null or lease_until<=statement_timestamp()) returning ${record} as result`;
}
export function releaseRequestStatement(
  id: string,
  userId: string,
  token: string,
) {
  return sql`update idempotency_requests set lease_token=null,lease_until=null
    where id=${id} and user_id=${userId} and lease_token=${token} and state='pending'
    returning jsonb_build_object('id',id) as result`;
}

function shipmentScope(actor: WriteActor) {
  if (actor.role === "business")
    return sql`exists(select 1 from businesses b where b.id=s.business_id and b.user_id=${actor.userId})`;
  if (actor.role === "customer") return sql`s.customer_id=${actor.userId}`;
  return sql`false`;
}
export function writableShipmentStatement(id: string, actor: WriteActor) {
  return sql`select jsonb_build_object('id',s.id,'trackingId',s.tracking_id,'priceKobo',s.price_kobo,
    'payable',not s.is_paid and s.status not in ('cancelled','failed')) as result
    from shipments s join users u on u.id=${actor.userId} and u.is_active and u.role=${actor.role}::user_role
    where s.id=${id} and ${shipmentScope(actor)}`;
}
export function businessForWriteStatement(
  actor: WriteActor,
  customerId?: string,
  customerEmail?: string,
) {
  return sql`select jsonb_build_object('businessId',b.id,'customerId',(
    select c.id from users c where c.role='customer' and c.is_active and (
      (${customerId ?? null}::text is not null and c.id=${customerId ?? null}) or
      (${customerId ?? null}::text is null and c.email=${customerEmail?.toLowerCase() ?? null})) limit 1)) as result
    from businesses b join users u on u.id=b.user_id and u.is_active and u.role='business'
    where b.user_id=${actor.userId}`;
}

export function createShipmentOnceStatement(
  id: string,
  actor: WriteActor,
  token: string,
) {
  return sql`with owned as materialized (
    select r.* from idempotency_requests r join businesses b on b.id=r.parameters->>'businessId'
    join users u on u.id=b.user_id and u.is_active and u.role='business'
    where r.id=${id} and r.user_id=${actor.userId} and r.operation='shipments.create'
      and b.user_id=r.user_id and r.state='pending' and r.lease_token=${token} and r.lease_until>statement_timestamp()
      and r.expires_at>statement_timestamp() and (r.parameters->>'customerId' is null or exists(
        select 1 from users c where c.id=r.parameters->>'customerId' and c.is_active and c.role='customer'))
    for update of r
  ), created as (
    insert into shipments(id,tracking_id,business_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo,scheduled_pickup)
    select resource_id,parameters->>'trackingId',parameters->>'businessId',parameters->>'customerId',
      parameters->>'description',(parameters->>'weightKg')::real,parameters->'pickupAddress',parameters->'deliveryAddress',
      (parameters->>'priceKobo')::integer,(parameters->>'scheduledPickup')::timestamptz from owned returning *
  ), recorded as (
    insert into shipment_events(id,shipment_id,status,message)
    select owned.parameters->>'eventId',created.id,created.status,'Shipment created' from owned,created returning shipment_id
  ) update idempotency_requests r set response=to_jsonb(created),state='completed',lease_token=null,lease_until=null
    from created,recorded where r.id=${id} and recorded.shipment_id=created.id
    returning jsonb_build_object('response',r.response) as result`;
}

export function prepareCheckoutStatement(
  id: string,
  actor: WriteActor,
  token: string,
) {
  return sql`select result from (select prepare_payment_checkout(${id},${actor.userId},${actor.role},${token}) as result) prepared where result is not null`;
}

export function finishCheckoutStatement(
  id: string,
  userId: string,
  token: string,
  sessionId: string,
  response: Record<string, unknown>,
) {
  return sql`with owned as materialized (
    select * from idempotency_requests where id=${id} and user_id=${userId} and operation='payments.initialize'
      and state='pending' and lease_token=${token} and lease_until>statement_timestamp() for update
  ), attached as (
    update payments p set stripe_session_id=${sessionId},checkout_state=case when p.checkout_state='creating' then 'open' else p.checkout_state end,updated_at=statement_timestamp() from owned
    where p.id=owned.resource_id and p.provider='stripe' and p.provider_reference=owned.parameters->>'reference'
      and (p.stripe_session_id is null or p.stripe_session_id=${sessionId}) and p.status in ('pending','success') returning p.id
  ) update idempotency_requests r set response=${JSON.stringify(response)}::jsonb,state='completed',lease_token=null,lease_until=null
    from attached where r.id=${id} and r.resource_id=attached.id returning jsonb_build_object('response',r.response) as result`;
}

export function scrubRequestsStatement() {
  return sql`with old as (select id from idempotency_requests where created_at<statement_timestamp()-interval '30 days'
    and scrubbed_at is null and (lease_until is null or lease_until<=statement_timestamp())
    order by created_at limit 5000 for update skip locked)
    update idempotency_requests set parameters=null,response=null,scrubbed_at=statement_timestamp(),lease_token=null,lease_until=null
    where id in(select id from old) returning jsonb_build_object('id',id) as result`;
}
