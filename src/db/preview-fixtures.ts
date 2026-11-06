import { sql } from "drizzle-orm";

export const previewAccounts = [
  ["preview-owner", "business"],
  ["preview-other", "business"],
  ["preview-driver", "driver"],
  ["preview-customer", "customer"],
] as const;
export function previewFixtureStatements(passwordHash: string) {
  return [
    ...previewAccounts.map(
      ([id, role]) =>
        sql`insert into users(id,email,password_hash,name,role) values(${id},${`${id}@example.invalid`},${passwordHash},${id},${role})`,
    ),
    sql`insert into businesses(id,user_id,business_name) values('preview-biz','preview-owner','Preview A'),('preview-other-biz','preview-other','Preview B')`,
    sql`insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate) values('preview-driver-profile','preview-driver','preview-biz','bike','PREVIEW')`,
    sql`insert into shipments(id,tracking_id,business_id,driver_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo,status)
      values('preview-shipment','IST-PREVIEW-ONLY','preview-biz','preview-driver-profile','preview-customer','PRIVATE-PREVIEW-PACKAGE',1,'{"street":"PRIVATE-PREVIEW-ADDRESS"}','{}',100,'assigned'),
      ('preview-foreign-shipment','IST-PREVIEW-FOREIGN','preview-other-biz',null,null,'Foreign preview',1,'{}','{}',100,'pending')`,
    sql`insert into shipment_events(id,shipment_id,status,message) values('preview-event','preview-shipment','assigned','PRIVATE-PREVIEW-EVENT')`,
  ];
}
