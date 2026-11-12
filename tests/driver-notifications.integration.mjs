import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import { postgresFixture } from "./helpers/postgres.mjs";
import { smtpFixture } from "./helpers/smtp.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import { createOutboxProcessor } from "../src/workers/outbox-processor.ts";
import { renderNotificationEmail } from "../src/lib/notification-email.ts";

const pg = postgresFixture({ prefix: "driver-notifications" });
const query = (text) => pg.query(sql.raw(text));
const store = {
  execute: async (statement) => {
    const result = await pg.query(statement, { prepared: true });
    return result ? result.split("\n").map((line) => JSON.parse(line)) : [];
  },
};
let smtp, transport, processEvent;
before(async () => {
  await pg.start();
  await runMigrations(
    {
      execute: async (statement) =>
        JSON.parse(
          await pg.query(
            sql`select coalesce(json_agg(r),'[]') from (${statement}) r`,
          ),
        ),
      transaction: (statements) =>
        pg.query(
          sql.join(
            [sql.raw("begin"), ...statements, sql.raw("commit")],
            sql.raw(";"),
          ),
        ),
    },
    fileURLToPath(new URL("../drizzle", import.meta.url)),
  );
  await query(`insert into users(id,email,password_hash,name,role) values ('owner','owner@example.test','hash','Owner','business'),('rider','rider@example.test','hash','Rider','driver'),('other','other@example.test','hash','Other','driver');
    insert into businesses(id,user_id,business_name) values('biz','owner','Business');
    insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate) values('driver','rider','biz','bike','TEST'),('other-driver','other','biz','bike','OTHER');`);
  smtp = await smtpFixture();
  transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: smtp.port,
    ignoreTLS: true,
  });
  processEvent = createOutboxProcessor(store, async (email) =>
    transport.sendMail({
      from: "test@example.test",
      ...renderNotificationEmail(email, "https://app.example.test"),
    }),
  );
});
beforeEach(async () => {
  await query(
    "truncate shipments,notifications cascade; update users set is_active=true; update drivers set business_id='biz',notification_preferences=null",
  );
  smtp.accepted.length = 0;
  smtp.reject(false);
});
after(async () => {
  transport?.close();
  await smtp?.close();
  await pg.stop();
});
async function assignment(label = "one", driver = "driver") {
  await pg.query(
    sql`insert into shipments(id,tracking_id,business_id,driver_id,status,description,weight_kg,pickup_address,delivery_address,price_kobo) values(${label},${`IST-${label}`},'biz',${driver},'assigned','Box',1,'{}','{}',100)`,
  );
  await pg.query(
    sql`insert into shipment_events(id,shipment_id,status,message) values(${`assigned-${label}`},${label},'assigned','Assigned')`,
  );
  return `shipment_assigned-${label}_driver`;
}
const state = (id) =>
  pg.query(sql`select state from notification_outbox where id=${id}`);
async function preferences(value) {
  await pg.query(
    sql`update drivers set notification_preferences=${JSON.stringify(value)}::jsonb where id='driver'`,
  );
}
test("assignment captures independent inbox/email jobs once and sends real local SMTP", async () => {
  const id = await assignment();
  assert.equal(
    await query(
      "select count(*) from notification_outbox where recipient_id='rider'",
    ),
    "2",
  );
  await processEvent(`${id}_in_app`);
  await processEvent(`${id}_in_app`);
  await processEvent(`${id}_email`);
  await processEvent(`${id}_email`);
  assert.equal(
    await query("select count(*) from notifications where user_id='rider'"),
    "1",
  );
  assert.equal(smtp.accepted.length, 1);
  assert.ok(smtp.accepted[0].includes("/driver/deliveries"));
});
test("current choices suppress queued channels independently and preserve existing inbox history", async () => {
  const first = await assignment("first");
  await preferences({
    newDelivery: { push: false, email: true },
    weeklyReport: { push: false, email: false },
  });
  await processEvent(`${first}_in_app`);
  await processEvent(`${first}_email`);
  assert.equal(await state(`${first}_in_app`), "skipped");
  assert.equal(smtp.accepted.length, 1);
  const second = await assignment("second");
  await preferences({ newDelivery: { push: true, email: false } });
  await processEvent(`${second}_in_app`);
  await processEvent(`${second}_email`);
  assert.equal(await state(`${second}_email`), "skipped");
  assert.equal(
    await query("select count(*) from notifications where user_id='rider'"),
    "1",
  );
  await preferences({ newDelivery: { push: false, email: false } });
  assert.equal(
    await query("select count(*) from notifications where user_id='rider'"),
    "1",
  );
  const other = await assignment("other", "other-driver");
  await processEvent(`${other}_email`);
  assert.equal(smtp.accepted.length, 2);
});
test("reassignment, inactivity and missing fleet membership suppress queued driver delivery", async () => {
  for (const change of [
    "update shipments set driver_id='other-driver'",
    "update users set is_active=false where id='rider'",
    "update shipments set driver_id=null; update drivers set business_id=null where id='driver'",
  ]) {
    await query(
      "truncate shipments,notifications cascade;update users set is_active=true;update drivers set business_id='biz'",
    );
    const id = await assignment();
    await query(change);
    await processEvent(`${id}_in_app`);
    await processEvent(`${id}_email`);
    assert.equal(await state(`${id}_email`), "skipped");
    assert.equal(await state(`${id}_in_app`), "skipped");
  }
  assert.equal(smtp.accepted.length, 0);
});
test("only actual failures create failed-attempt alerts; return audit entries do not", async () => {
  await assignment();
  await query(
    "update shipments set status='failed',failure_reason='recipient_unavailable',failed_at=now() where id='one'; insert into shipment_events(id,shipment_id,status,message) values('failed','one','failed','Failed'); insert into shipment_exceptions(id,shipment_id,actor_id,action,reason,note,version,attempt_number) values('failed','one','rider','fail','recipient_unavailable','',2,1)",
  );
  assert.equal(
    await query(
      "select count(*) from notification_outbox where id like 'shipment_failed_driver_%'",
    ),
    "2",
  );
  await processEvent("shipment_failed_driver_email");
  assert.equal(smtp.accepted.length, 1);
  await query(
    "insert into shipment_events(id,shipment_id,status,message) values('return','one','failed','Return requested'); insert into shipment_exceptions(id,shipment_id,actor_id,action,note,version,attempt_number) values('return','one','owner','return_request','',3,1)",
  );
  assert.equal(
    await query(
      "select count(*) from notification_outbox where id like 'shipment_return_driver_%'",
    ),
    "0",
  );
});
test("failed SMTP delivery rechecks opt-out before retry", async () => {
  const id = await assignment();
  smtp.reject(true);
  await assert.rejects(
    processEvent(`${id}_email`),
    /Notification delivery failed/,
  );
  smtp.reject(false);
  await preferences({ newDelivery: { push: true, email: false } });
  await pg.query(
    sql`update notification_outbox set available_at=now() where id=${`${id}_email`}`,
  );
  await processEvent(`${id}_email`);
  assert.equal(await state(`${id}_email`), "skipped");
  assert.equal(smtp.accepted.length, 0);
});

test("confirmed-delivery events honor their own channel preferences", async () => {
  await assignment();
  await query(
    "insert into shipment_events(id,shipment_id,status,message) values('completed','one','delivered','Confirmed handover')",
  );
  await preferences({
    deliveryComplete: { push: true, email: false },
    newDelivery: { push: false, email: true },
  });
  await processEvent("shipment_completed_driver_in_app");
  await processEvent("shipment_completed_driver_email");
  assert.equal(await state("shipment_completed_driver_in_app"), "delivered");
  assert.equal(await state("shipment_completed_driver_email"), "skipped");
  assert.equal(smtp.accepted.length, 0);
});
