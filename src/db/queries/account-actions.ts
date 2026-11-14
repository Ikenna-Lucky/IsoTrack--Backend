import { sql } from "drizzle-orm";
import type { AccountPurpose } from "../../lib/account-action-token.ts";

export function actionRequestBudget(key: string) {
  return sql`insert into account_action_limits(key,window_start,count,next_at)
    values(${key}, date_bin(interval '10 minutes',statement_timestamp(),'2000-01-01'::timestamptz),1,statement_timestamp())
    on conflict(key) do update set
      window_start=excluded.window_start,
      count=case when account_action_limits.window_start=excluded.window_start then account_action_limits.count+1 else 1 end
    where account_action_limits.window_start<excluded.window_start
      or (account_action_limits.window_start=excluded.window_start and account_action_limits.count<30)
    returning json_build_object('allowed',true) as result`;
}

export function issueAccountAction(
  email: string,
  purpose: AccountPurpose,
  id: string,
  hash: string,
) {
  return sql`with eligible as (
    select id,email,credential_version from users where email=${email} and is_active
      and (${purpose} <> 'verify_email' or not is_email_verified)
  ), admitted as (
    insert into account_action_limits(key,window_start,count,next_at)
    select 'account:' || id || ':' || ${purpose},date_trunc('hour',statement_timestamp()),1,statement_timestamp()+interval '1 minute' from eligible
    on conflict(key) do update set window_start=excluded.window_start,
      count=case when account_action_limits.window_start=excluded.window_start then account_action_limits.count+1 else 1 end,
      next_at=excluded.next_at
    where account_action_limits.next_at<=statement_timestamp()
      and (account_action_limits.window_start<excluded.window_start
        or (account_action_limits.window_start=excluded.window_start and account_action_limits.count<5))
    returning key
  ) insert into account_actions(id,user_id,purpose,email,credential_version,token_hash,expires_at)
    select ${id},e.id,${purpose},e.email,e.credential_version,${hash},statement_timestamp()+
      case when ${purpose}='reset_password' then interval '30 minutes' else interval '24 hours' end
    from eligible e join admitted a on a.key='account:' || e.id || ':' || ${purpose}
    returning json_build_object('issued',true) as result`;
}

export function validAccountAction(
  id: string,
  hash: string,
  purpose: AccountPurpose,
) {
  return sql`select json_build_object('valid',true) as result from account_actions a join users u on u.id=a.user_id
    where a.id=${id} and a.token_hash=${hash} and a.purpose=${purpose} and a.consumed_at is null
      and a.expires_at>statement_timestamp() and u.is_active and a.email=u.email
      and a.credential_version=u.credential_version
      and (${purpose}<>'verify_email' or not u.is_email_verified)`;
}

export function consumeAccountAction(
  id: string,
  hash: string,
  purpose: AccountPurpose,
  passwordHash: string | null,
  noticeId: string,
) {
  return sql`with changed as (
    update users u set password_hash=case when ${purpose}='reset_password' then ${passwordHash} else u.password_hash end,
      is_email_verified=case when ${purpose}='verify_email' then true else u.is_email_verified end,
      updated_at=statement_timestamp()
    where u.is_active and (${purpose}<>'verify_email' or not u.is_email_verified) and exists (
      select 1 from account_actions a where a.id=${id} and a.user_id=u.id and a.token_hash=${hash}
        and a.purpose=${purpose} and a.consumed_at is null and a.expires_at>statement_timestamp()
        and a.email=u.email and a.credential_version=u.credential_version
    ) returning u.id,u.email,u.credential_version
  ), consumed as (
    update account_actions a set consumed_at=statement_timestamp() from changed u where a.id=${id} and a.user_id=u.id
    returning a.id
  ), notice as (
    insert into account_actions(id,user_id,purpose,email,credential_version,expires_at)
      select ${noticeId},id,'password_changed',email,credential_version,statement_timestamp()+interval '24 hours'
      from changed where ${purpose}='reset_password' returning id
  ) select json_build_object('changed',true) as result from consumed`;
}

export function claimAccountEmails(lease: string) {
  return sql`with exhausted as (
    update account_actions set delivery_state='dead',lease_token=null,lease_until=null
      where id in (select id from account_actions where delivery_state='processing'
        and lease_until<=statement_timestamp() and attempts>=5 order by lease_until limit 100 for update skip locked) returning id
  ), due as (
    select id from account_actions where attempts<5 and
      ((delivery_state='pending' and available_at<=statement_timestamp()) or (delivery_state='processing' and lease_until<=statement_timestamp()))
    order by available_at limit 5 for update skip locked
  ) update account_actions a set delivery_state='processing',attempts=attempts+1,lease_token=${lease},lease_until=statement_timestamp()+interval '2 minutes'
    from due where a.id=due.id returning json_build_object('id',a.id,'purpose',a.purpose,'tokenHash',a.token_hash) as result`;
}

export function accountEmailContext(id: string, lease: string) {
  return sql`select json_build_object('email',a.email,'purpose',a.purpose,'tokenHash',a.token_hash) as result
    from account_actions a join users u on u.id=a.user_id
    where a.id=${id} and a.lease_token=${lease} and a.delivery_state='processing' and a.lease_until>statement_timestamp()
      and a.expires_at>statement_timestamp() and u.is_active and u.email=a.email
      and (a.purpose='password_changed' or (a.consumed_at is null and a.credential_version=u.credential_version
        and (a.purpose<>'verify_email' or not u.is_email_verified)))`;
}

export function finishAccountEmail(
  id: string,
  lease: string,
  state: "sent" | "skipped" | "failed",
  retrySeconds = 0,
) {
  return sql`update account_actions set
    delivery_state=case when ${state}='failed' then case when attempts>=5 then 'dead' else 'pending' end else ${state} end,
    available_at=statement_timestamp()+greatest(least(300,power(2,attempts)::int*5),${retrySeconds}::int)*interval '1 second',
    lease_token=null,lease_until=null
    where id=${id} and delivery_state='processing' and lease_token=${lease} and lease_until>statement_timestamp()
    returning json_build_object('completed',true) as result`;
}

export function purgeAccountActions() {
  return sql`with old as (select id from account_actions where expires_at<statement_timestamp()-interval '7 days'
    and delivery_state<>'processing' order by expires_at limit 5000 for update skip locked),
    removed as (delete from account_actions where id in(select id from old) returning id),
    limits as (delete from account_action_limits where key in(select key from account_action_limits
      where window_start<statement_timestamp()-interval '2 days' order by window_start limit 5000 for update skip locked) returning key)
    select json_build_object('actions',(select count(*) from removed),'limits',(select count(*) from limits)) as result`;
}
