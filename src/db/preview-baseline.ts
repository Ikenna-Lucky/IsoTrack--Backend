import { sql } from "drizzle-orm";
import type { MigrationStore } from "./migration-runner.ts";

/** Read-only preflight: never invent migration history for a copied schema. */
export async function assertPreviewBaseline(
  store: Pick<MigrationStore, "execute">,
) {
  const [state] = await store.execute(sql`select
    exists(select 1 from information_schema.tables where table_schema='public' and table_name in ('users','businesses','drivers','shipments','shipment_events','payments','idempotency_requests')) as has_tables,
    to_regclass('drizzle.__drizzle_migrations') is not null as has_ledger`);
  if (
    !state ||
    typeof state.has_tables !== "boolean" ||
    typeof state.has_ledger !== "boolean"
  )
    throw new Error("Cannot inspect preview migration baseline");
  if (!state.has_tables) return;
  if (!state.has_ledger)
    throw new Error(
      "Copied preview schema has no migration history; manual baseline review is required",
    );
  const [history] = await store.execute(
    sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
  );
  if (
    !history ||
    !/^\d+$/.test(String(history.count)) ||
    BigInt(String(history.count)) === 0n
  )
    throw new Error(
      "Copied preview schema has empty migration history; manual baseline review is required",
    );
}
