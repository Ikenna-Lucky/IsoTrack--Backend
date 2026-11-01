import { sql } from "drizzle-orm";

interface Acceptance {
  tokenHash: string;
  email: string;
  userId: string;
  driverId: string;
  name: string;
  passwordHash: string;
  vehicleType: "bike" | "car" | "van" | "truck";
  vehiclePlate: string;
}

// One statement is atomic on the Neon HTTP driver. Lock the invitation before
// creating anything, so acceptance and revocation serialize on the same row.
export function acceptDriverInvitationStatement(input: Acceptance) {
  return sql`with invitation as materialized (
    select id, business_id, email from driver_invitations
    where token_hash = ${input.tokenHash} and email = ${input.email}
      and accepted_at is null and revoked_at is null
      and expires_at > statement_timestamp()
    for update
  ), new_user as (
    insert into users (id, email, password_hash, name, role)
    select ${input.userId}, email, ${input.passwordHash}, ${input.name}, 'driver'
    from invitation
    on conflict (email) do nothing
    returning id
  ), new_driver as (
    insert into drivers (id, user_id, business_id, vehicle_type, vehicle_plate)
    select ${input.driverId}, new_user.id, invitation.business_id,
      ${input.vehicleType}::vehicle_type, ${input.vehiclePlate}
    from invitation cross join new_user
    returning id, user_id, business_id
  ), accepted as (
    update driver_invitations set accepted_at = statement_timestamp()
    where id in (select id from invitation) and exists (select 1 from new_driver)
    returning id
  )
  select new_driver.user_id as "userId", new_driver.id as "driverId",
    new_driver.business_id as "businessId"
  from new_driver cross join accepted`;
}
