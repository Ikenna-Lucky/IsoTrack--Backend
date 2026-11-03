import { sql } from "drizzle-orm";

export function openSessionStatement(
  id: string,
  userId: string,
  credentialVersion: number,
  lifetime: number,
) {
  return sql`insert into auth_sessions (id, user_id, credential_version, expires_at)
    select ${id}, id, credential_version, statement_timestamp() + ${lifetime} * interval '1 second'
    from users where id = ${userId} and is_active and credential_version = ${credentialVersion}
    returning extract(epoch from expires_at)::bigint as expires_at`;
}

// PostgreSQL rechecks the row after a competing UPDATE commits. A second use of
// the same generation therefore revokes the session instead of rotating twice.
export function rotateSessionStatement(
  id: string,
  userId: string,
  generation: number,
) {
  return sql`update auth_sessions s set
    generation = case when s.generation = ${generation} then s.generation + 1 else s.generation end,
    revoked_at = case when s.generation = ${generation} then null else statement_timestamp() end
    from users u where s.id = ${id} and s.user_id = ${userId} and u.id = s.user_id
      and u.is_active and u.credential_version = s.credential_version
      and s.revoked_at is null and s.expires_at > statement_timestamp()
    returning s.generation, s.revoked_at`;
}

export function activeSessionStatement(id: string, userId: string) {
  return sql`select s.id from auth_sessions s join users u on u.id = s.user_id
    where s.id = ${id} and s.user_id = ${userId} and s.revoked_at is null
      and s.expires_at > statement_timestamp() and u.is_active
      and s.credential_version = u.credential_version`;
}

export function revokeSessionStatement(id: string, userId: string) {
  return sql`update auth_sessions set revoked_at = coalesce(revoked_at, statement_timestamp())
    where id = ${id} and user_id = ${userId}`;
}

export function changePasswordStatement(
  userId: string,
  previousHash: string,
  nextHash: string,
) {
  return sql`update users set password_hash = ${nextHash}, updated_at = statement_timestamp()
    where id = ${userId} and password_hash = ${previousHash} and is_active returning id`;
}

// Keep seven days of expired records for investigation; bound each deletion so
// concurrent cleanup jobs do not hold large locks or block one another.
export function purgeExpiredSessionsStatement() {
  return sql`with expired as (
    select id from auth_sessions where expires_at < statement_timestamp() - interval '7 days'
    order by expires_at limit 5000 for update skip locked
  ) delete from auth_sessions where id in (select id from expired) returning id`;
}
