import { randomUUID } from "node:crypto";
import { encryptMailCache, decryptMailCache } from "../lib/mail-token-cache.ts";
export interface MailCacheDatabase {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
}
export function createMailCacheStore(
  database: MailCacheDatabase,
  identity: string,
  key: string,
) {
  return {
    async use<T>(
      operation: (cache: string | null) => Promise<{ cache: string; value: T }>,
      seconds = 90,
    ): Promise<T> {
      const lease = randomUUID();
      const rows = await database.query(
        `insert into microsoft_mail_cache (id, lease_id, lease_until) values ($1,$2,statement_timestamp()+$3*interval '1 second')
         on conflict (id) do update set lease_id=excluded.lease_id,lease_until=excluded.lease_until
         where microsoft_mail_cache.lease_until is null or microsoft_mail_cache.lease_until<statement_timestamp()
         returning encrypted_cache`,
        [identity, lease, seconds],
      );
      if (!rows.length)
        throw new Error("Microsoft mail authorization is busy; retry later.");
      try {
        const previous = rows[0]!.encrypted_cache;
        const result = await operation(
          typeof previous === "string"
            ? decryptMailCache(previous, key, identity)
            : null,
        );
        const saved = await database.query(
          `update microsoft_mail_cache set encrypted_cache=$3,lease_id=null,lease_until=null,updated_at=statement_timestamp()
           where id=$1 and lease_id=$2 and lease_until>statement_timestamp() returning id`,
          [identity, lease, encryptMailCache(result.cache, key, identity)],
        );
        if (!saved.length)
          throw new Error("Microsoft mail authorization lease expired.");
        return result.value;
      } finally {
        await database.query(
          "update microsoft_mail_cache set lease_id=null,lease_until=null where id=$1 and lease_id=$2 returning id",
          [identity, lease],
        );
      }
    },
  };
}
