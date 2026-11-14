import { sql } from "drizzle-orm";

const eligible = sql`u.is_active and s.business_id=o.payload->>'businessId' and (
  (o.recipient_id=o.payload->>'ownerId' and u.role='business'
    and exists(select 1 from businesses b where b.id=s.business_id and b.user_id=u.id)) or
  (o.recipient_id=o.payload->>'customerId' and u.role='customer' and s.customer_id=u.id) or
  (u.role='driver' and o.recipient_id=o.payload->>'driverUserId' and s.driver_id=o.payload->>'driverId'
    and exists(select 1 from drivers d where d.id=s.driver_id and d.user_id=u.id and d.business_id=s.business_id)))`;

export function dueOutboxStatement() {
  return sql`with exhausted as (
    select id from notification_outbox where state='processing' and lease_until<=statement_timestamp()
      and attempts>=5 order by lease_until limit 100 for update skip locked
  ), failed as (
    update notification_outbox set state='dead',lease_token=null,lease_until=null,last_error='LEASE_EXHAUSTED'
    where id in (select id from exhausted) returning id
  ) select jsonb_build_object('id',id) as result from notification_outbox where attempts<5 and (
    (state='pending' and available_at<=statement_timestamp()) or
    (state='processing' and lease_until<=statement_timestamp()))
    order by available_at,id limit 100`;
}

export function claimOutboxStatement(id: string, token: string) {
  return sql`update notification_outbox set state='processing', attempts=attempts+1,
    lease_token=${token},lease_until=statement_timestamp()+interval '2 minutes'
    where id=${id} and attempts<5 and (
      (state='pending' and available_at<=statement_timestamp()) or
      (state='processing' and lease_until<=statement_timestamp()))
    returning jsonb_build_object('id',id) as result`;
}

export function outboxContextStatement(id: string, token: string) {
  return sql`select jsonb_build_object('name',u.name,'email',u.email,'recipientRole',u.role,'businessPreferences',
    (select b.notification_preferences from businesses b where b.id=s.business_id and b.user_id=u.id),
    'driverPreferences',(select d.notification_preferences from drivers d where d.id=s.driver_id and d.user_id=u.id),
    'payload',o.payload,'kind',o.kind,'channel',o.channel) as result from notification_outbox o
    join users u on u.id=o.recipient_id join shipments s on s.id=o.shipment_id
    where o.id=${id} and o.state='processing' and o.lease_token=${token}
      and o.lease_until>statement_timestamp() and ${eligible}`;
}

export function completeInAppStatement(
  id: string,
  token: string,
  title: string,
  message: string,
  businessEmail = false,
) {
  return sql`with owned as materialized (
    select id from notification_outbox where id=${id} and channel='in_app' and state='processing' and lease_token=${token}
      and lease_until>statement_timestamp() for update
  ), recipient as materialized (
    select o.* from notification_outbox o join owned on owned.id=o.id
    join users u on u.id=o.recipient_id join shipments s on s.id=o.shipment_id where ${eligible}
  ), inserted as (
    insert into notifications(id,user_id,type,title,message,status,metadata)
    select 'outbox_'||id,recipient_id,'push',${title},${message},'sent',
      jsonb_build_object('outboxId',id,'trackingId',payload->>'trackingId','status',payload->>'status')::text
    from recipient on conflict(id) do nothing returning id
  ), captured_email as (
    insert into notification_outbox(id,shipment_id,recipient_id,channel,kind,payload)
    select o.id||'_email',o.shipment_id,o.recipient_id,'email',o.kind,o.payload
      from recipient o join inserted n on n.id='outbox_'||o.id
      join users u on u.id=o.recipient_id
      where ${businessEmail} and u.role='business' and o.kind='shipment_status'
    on conflict(id) do nothing returning id
  ) update notification_outbox set state=case when exists(select 1 from recipient) then 'delivered' else 'skipped' end,
    completed_at=statement_timestamp(),lease_token=null,lease_until=null,last_error=null
    where id in(select id from owned) returning jsonb_build_object('id',id) as result`;
}

export function completeOutboxStatement(
  id: string,
  token: string,
  skipped = false,
) {
  return sql`update notification_outbox set state=${skipped ? "skipped" : "delivered"}, completed_at=statement_timestamp(),
    lease_token=null,lease_until=null,last_error=null
    where id=${id} and state='processing' and lease_token=${token} and lease_until>statement_timestamp() returning jsonb_build_object('id',id) as result`;
}

export function failOutboxStatement(
  id: string,
  token: string,
  retrySeconds = 0,
) {
  return sql`update notification_outbox set state=case when attempts>=5 then 'dead' else 'pending' end,
    available_at=statement_timestamp()+greatest(least(60,5*power(2,attempts-1)),${retrySeconds}::int)*interval '1 second',
    lease_token=null,lease_until=null,last_error='DELIVERY_FAILED'
    where id=${id} and state='processing' and lease_token=${token} and lease_until>statement_timestamp() returning jsonb_build_object('id',id) as result`;
}

export function replayOutboxStatement(id: string) {
  return sql`update notification_outbox set state='pending',attempts=0,available_at=statement_timestamp(),last_error=null
    where id=${id} and state='dead' returning jsonb_build_object('id',id) as result`;
}

export function purgeOutboxStatement() {
  return sql`with expired as (select id from notification_outbox
    where state in ('delivered','skipped') and completed_at<statement_timestamp()-interval '30 days'
    order by completed_at limit 5000 for update skip locked)
    delete from notification_outbox where id in (select id from expired) returning jsonb_build_object('id',id) as result`;
}

export function outboxStatusStatement() {
  return sql`select jsonb_build_object('state',state,'count',count(*),
    'oldestCreatedAt',min(created_at)) as result from notification_outbox group by state order by state`;
}
