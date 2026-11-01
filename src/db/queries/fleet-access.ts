import { sql, type AnyColumn } from "drizzle-orm";

export function fleetAccessPredicate(businessId: AnyColumn, ownerUserId: string) {
  return sql`exists (
    select 1 from "businesses" as "fleet_business"
    where "fleet_business"."id" = ${businessId}
      and "fleet_business"."user_id" = ${ownerUserId}
  )`;
}
