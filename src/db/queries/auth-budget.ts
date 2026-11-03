import { sql } from "drizzle-orm";

export function reserveAuthBudget(key: string, limit: number, seconds: number) {
  return sql`with clock as (
    select date_bin(${seconds} * interval '1 second',statement_timestamp(),'2000-01-01'::timestamptz) as start
  ), admitted as (
    insert into account_action_limits(key,window_start,count,next_at)
    select ${key},start,1,start+${seconds}*interval '1 second' from clock
    on conflict(key) do update set window_start=excluded.window_start,next_at=excluded.next_at,
      count=case when account_action_limits.window_start=excluded.window_start then account_action_limits.count+1 else 1 end
    where account_action_limits.window_start<excluded.window_start
      or (account_action_limits.window_start=excluded.window_start and account_action_limits.count<${limit})
    returning key
  ) select json_build_object('allowed',exists(select 1 from admitted),
    'retryAfter',greatest(1,ceil(extract(epoch from (start+${seconds}*interval '1 second'-statement_timestamp()))))) as result from clock`;
}
