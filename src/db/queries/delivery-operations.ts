import { sql } from "drizzle-orm";
export const deliveryStatus =
  () => sql`select json_build_object('state',delivery_state,'count',count(*)) as result
 from delivery_confirmations group by delivery_state order by delivery_state`;
export const purgeDeliveryConfirmations = () => sql`with old as (
 select id from delivery_confirmations where delivery_state<>'processing' and
  ((consumed_at is null and expires_at<statement_timestamp()-interval '7 days') or consumed_at<statement_timestamp()-interval '90 days')
 order by expires_at limit 5000 for update skip locked)
 delete from delivery_confirmations where id in(select id from old) returning json_build_object('removed',true) as result`;
