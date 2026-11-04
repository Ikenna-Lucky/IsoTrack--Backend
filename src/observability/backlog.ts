import { sql } from "drizzle-orm";

// Seek the oldest actionable row rather than counting whole production tables.
// Ages are based on the database clock. Empty queues report zero, not absence.
export const backlogStatement =
  () => sql`select jsonb_build_object('queue',queue,'age',coalesce(extract(epoch from statement_timestamp()-oldest),0),'present',oldest is not null) as result from (
  select 'notifications' as queue,min(available_at) as oldest from (
    select available_at from notification_outbox where state='pending' order by available_at limit 1) n
  union all select 'notification_dead',min(available_at) from (
    select available_at from notification_outbox where state='dead' order by available_at limit 1) n
  union all select 'notification_leases',min(lease_until) from (
    select lease_until from notification_outbox where state='processing' order by lease_until limit 1) n
  union all select 'account_emails',min(available_at) from (
    select available_at from account_actions where delivery_state='pending' order by available_at limit 1) a
  union all select 'account_email_dead',min(available_at) from (
    select available_at from account_actions where delivery_state='dead' order by available_at limit 1) a
  union all select 'account_email_leases',min(lease_until) from (
    select lease_until from account_actions where delivery_state='processing' order by lease_until limit 1) a
  union all select 'payments',min(reconcile_after) from (
    select reconcile_after from payments where provider='stripe' and status='pending' and checkout_state<>'review' order by reconcile_after limit 1) p
  union all select 'delivery_emails',min(available_at) from (
    select available_at from delivery_confirmations where delivery_state='pending' order by available_at limit 1) d
  union all select 'delivery_email_dead',min(available_at) from (
    select available_at from delivery_confirmations where delivery_state='dead' order by available_at limit 1) d
  union all select 'delivery_email_leases',min(lease_until) from (
    select lease_until from delivery_confirmations where delivery_state='processing' order by lease_until limit 1) d
  union all select 'payment_reviews',min(received_at) from (
    select received_at from payments where review_reason is not null and refund_id is null order by received_at limit 1) p
) backlog`;
