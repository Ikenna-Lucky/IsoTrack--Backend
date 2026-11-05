import { sql, type SQL } from "drizzle-orm";

export const retentionTasks = [
  "sessions",
  "idempotency",
  "outbox",
  "account_actions",
  "account_limits",
  "delivery_expired",
  "delivery_consumed",
  "invitations",
  "notifications",
  "shipment_gps",
  "event_gps",
] as const;
export type RetentionTask = (typeof retentionTasks)[number];

// Missing/unresolved payment records retain their recovery parameters. The
// permanent hashed tombstone remains even when a resolved payload is scrubbed.
export const resolvedRequest = sql`(t.operation<>'payments.initialize' or exists (
  select 1 from payments p where p.id=t.resource_id and p.status<>'pending'
    and p.checkout_state not in ('creating','open','processing','review')
    and (p.review_reason is null or p.refund_id is not null)
    and not exists(select 1 from payment_checkout_guards g where g.payment_id=p.id)))`;

const closedAt = (alias: "t" | "s") =>
  sql.raw(`case when ${alias}.status='delivered' then ${alias}.actual_delivery
  when ${alias}.status='cancelled' then ${alias}.updated_at
  when ${alias}.status='failed' and ${alias}.return_state='received' then ${alias}.returned_at end`);
const noPaymentHold = (
  alias: "t" | "s",
) => sql`not exists(select 1 from payments p where p.shipment_id=${sql.identifier(alias)}.id
  and (p.status='pending' or p.checkout_state='review' or (p.review_reason is not null and p.refund_id is null)))`;

function policy(task: RetentionTask): {
  table: string;
  key: string;
  age: SQL;
  eligible: SQL;
  scrub?: boolean;
  clear?: string;
  join?: SQL;
} {
  switch (task) {
    case "sessions":
      return {
        table: "auth_sessions",
        key: "id",
        age: sql`t.expires_at`,
        eligible: sql`t.expires_at<statement_timestamp()-interval '7 days'`,
      };
    case "idempotency":
      return {
        table: "idempotency_requests",
        key: "id",
        age: sql`t.created_at`,
        scrub: true,
        eligible: sql`t.created_at<statement_timestamp()-interval '30 days' and t.expires_at<=statement_timestamp() and t.scrubbed_at is null
        and (t.lease_until is null or t.lease_until<=statement_timestamp()) and ${resolvedRequest}`,
      };
    case "outbox":
      return {
        table: "notification_outbox",
        key: "id",
        age: sql`t.completed_at`,
        eligible: sql`t.state in ('delivered','skipped') and t.completed_at<statement_timestamp()-interval '30 days'`,
      };
    case "account_actions":
      return {
        table: "account_actions",
        key: "id",
        age: sql`t.expires_at`,
        eligible: sql`t.expires_at<statement_timestamp()-interval '7 days' and t.delivery_state<>'processing'`,
      };
    case "account_limits":
      return {
        table: "account_action_limits",
        key: "key",
        age: sql`t.window_start`,
        eligible: sql`t.window_start<statement_timestamp()-interval '2 days' and t.next_at<=statement_timestamp()`,
      };
    case "delivery_expired":
      return {
        table: "delivery_confirmations",
        key: "id",
        age: sql`t.expires_at`,
        eligible: sql`t.consumed_at is null and t.delivery_state<>'processing' and t.expires_at<statement_timestamp()-interval '7 days'`,
      };
    case "delivery_consumed":
      return {
        table: "delivery_confirmations",
        key: "id",
        age: sql`t.consumed_at`,
        eligible: sql`t.consumed_at is not null and t.delivery_state<>'processing' and t.consumed_at<statement_timestamp()-interval '90 days'`,
      };
    case "invitations":
      return {
        table: "driver_invitations",
        key: "id",
        age: sql`t.expires_at`,
        eligible: sql`t.accepted_at is null and t.expires_at<statement_timestamp()-interval '30 days'`,
      };
    case "notifications":
      return {
        table: "notifications",
        key: "id",
        age: sql`t.created_at`,
        eligible: sql`t.is_read and t.status='sent' and t.created_at<statement_timestamp()-interval '90 days'
        and not exists(select 1 from notification_outbox o where t.id like 'outbox_%' and o.id=substring(t.id from 8)
          and o.state not in ('delivered','skipped'))`,
      };
    case "shipment_gps":
      return {
        table: "shipments",
        key: "id",
        age: closedAt("t"),
        clear: "current_location",
        eligible: sql`t.current_location is not null and (${closedAt("t")})<statement_timestamp()-interval '30 days' and ${noPaymentHold("t")}`,
      };
    case "event_gps":
      return {
        table: "shipment_events",
        key: "id",
        age: sql`t.created_at`,
        clear: "location",
        join: sql`join shipments s on s.id=t.shipment_id`,
        eligible: sql`t.location is not null and (${closedAt("s")})<statement_timestamp()-interval '30 days' and ${noPaymentHold("s")}`,
      };
  }
}
function batchSize(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 500)
    throw new Error("Retention batch must be 1–500");
  return value;
}
export function retentionBatch(
  task: RetentionTask,
  preview = true,
  limit = 500,
) {
  const size = batchSize(limit);
  const p = policy(task),
    table = sql.identifier(p.table),
    key = sql.identifier(p.key);
  const candidates = sql`select t.${key} as id from ${table} t ${p.join ?? sql``} where ${p.eligible}`;
  if (preview)
    return sql`select jsonb_build_object('task',${task},'eligibleUpToBatch',least(count(*),${size}),
    'hasMore',count(*)>${size}) as result from (${candidates} order by ${p.age},t.${key} limit ${size + 1}) bounded`;
  const mutation = p.scrub
    ? sql`update ${table} t set parameters=null,response=null,scrubbed_at=statement_timestamp(),lease_token=null,lease_until=null
        from candidates c where t.${key}=c.id returning t.${key}`
    : p.clear
      ? sql`update ${table} t set ${sql.identifier(p.clear)}=null from candidates c where t.${key}=c.id returning t.${key}`
      : sql`delete from ${table} t using candidates c where t.${key}=c.id returning t.${key}`;
  return sql`with guard as materialized(select pg_try_advisory_xact_lock(726519,${retentionTasks.indexOf(task)}) as acquired,
      exists(select 1 from retention_runs where task=${task}) as present),
    candidates as materialized(${candidates} and (select acquired and present from guard)
      order by ${p.age},t.${key} limit ${size} for update of t skip locked),
    changed as (${mutation}),
    checkpoint as (update retention_runs set last_success_at=statement_timestamp(),last_affected=(select count(*) from changed)
      where task=${task} and (select acquired from guard) returning task)
    select jsonb_build_object('task',${task},'status',case when (select acquired from guard) then 'success' else 'busy' end,
      'affected',(select count(*) from changed),'recorded',(select count(*) from checkpoint)=1) as result`;
}
export const retentionStatus =
  () => sql`select jsonb_build_object('task',task,'lastSuccessAt',last_success_at,
  'lastAffected',last_affected,'ageSeconds',extract(epoch from statement_timestamp()-coalesce(last_success_at,created_at))) as result
  from retention_runs order by task`;
