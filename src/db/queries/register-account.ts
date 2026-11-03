import { sql } from "drizzle-orm";
export interface RegistrationInput {
  name: string;
  email: string;
  role: "business" | "driver" | "customer";
  phone?: string | undefined;
  businessName?: string | undefined;
}
export function registerAccountStatement(
  id: string,
  businessId: string,
  input: RegistrationInput,
  passwordHash: string,
) {
  return sql`with created as (
    insert into users(id,email,password_hash,name,role,phone)
      select ${id},${input.email},${passwordHash},${input.name},${input.role}::user_role,${input.phone || null}
      where ${input.role} in ('business','customer')
      on conflict(email) do nothing returning id
  ), profile as (
    insert into businesses(id,user_id,business_name) select ${businessId},id,${input.businessName ?? input.name}
    from created where ${input.role}='business' returning id
  ) select json_build_object('id',id) as result from created`;
}
