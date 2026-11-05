import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import { postgresFixture } from "./helpers/postgres.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import {
  retentionBatch,
  retentionStatus,
  retentionTasks,
} from "../src/db/queries/retention.ts";
import { scrubRequestsStatement } from "../src/db/queries/idempotency.ts";
const pg = postgresFixture({ prefix: "retention" });
const query = (text) => pg.query(sql.raw(text));
async function execute(statement) {
  const output = await pg.query(statement);
  return output ? output.split("\n").map((line) => JSON.parse(line)) : [];
}
const batch = async (task, preview = false, limit = 500) =>
  (await execute(retentionBatch(task, preview, limit)))[0];
before(async () => {
  await pg.start();
  await runMigrations(
    {
      execute: async (s) =>
        JSON.parse(
          await pg.query(sql`select coalesce(json_agg(r),'[]') from (${s}) r`),
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
});
beforeEach(async () => {
  await query(`truncate users cascade;
    update retention_runs set last_success_at=null,last_affected=0;
    insert into users(id,email,password_hash,name,role) values('owner','owner@example.test','hash','Owner','business'),('rider','rider@example.test','hash','Rider','driver');
    insert into businesses(id,user_id,business_name) values('biz','owner','Fixture');
    insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate) values('driver','rider','biz','bike','TEST');
    insert into shipments(id,tracking_id,business_id,description,weight_kg,pickup_address,delivery_address,price_kobo)
      values('shipment','IST-RETENTION','biz','Fixture',1,'{}','{}',100);`);
});
after(() => pg.stop());
const oldSessions = (count) =>
  query(`insert into auth_sessions(id,user_id,credential_version,created_at,expires_at)
 select 'old-'||n,'owner',0,now()-interval '10 days',now()-interval '8 days' from generate_series(1,${count}) n`);

test("all policies are previewable without mutation or checkpoint writes", async () => {
  await oldSessions(3);
  for (const task of retentionTasks)
    assert.equal((await batch(task, true, 2)).task, task);
  assert.deepEqual(await batch("sessions", true, 2), {
    task: "sessions",
    eligibleUpToBatch: 2,
    hasMore: true,
  });
  assert.equal(await query("select count(*) from auth_sessions"), "3");
  assert.equal(
    await query(
      "select count(*) from retention_runs where last_success_at is not null",
    ),
    "0",
  );
});
test("cleanup is bounded, repeatable and preserves active/recent sessions", async () => {
  await oldSessions(501);
  await query(`insert into auth_sessions(id,user_id,credential_version,created_at,expires_at) values
    ('active','owner',0,now()-interval '10 days',now()+interval '1 day'),('recent','owner',0,now()-interval '2 days',now()-interval '1 day')`);
  assert.equal((await batch("sessions")).affected, 500);
  assert.equal((await batch("sessions")).affected, 1);
  assert.equal((await batch("sessions")).affected, 0);
  assert.equal(await query("select count(*) from auth_sessions"), "2");
  assert.ok(
    (await execute(retentionStatus())).find((r) => r.task === "sessions")
      .lastSuccessAt,
  );
});
test("pending, reviewed, leased and missing payments retain idempotent recovery data", async () => {
  await query(`insert into payments(id,shipment_id,provider_reference,amount_kobo,status,checkout_state,review_reason) values
    ('pending','shipment','PENDING',100,'pending','open',null),('review','shipment','REVIEW',100,'success','review','additional_payment'),
    ('settled','shipment','SETTLED',100,'success','settled',null);
    insert into idempotency_requests(id,user_id,operation,key_hash,request_hash,resource_id,parameters,response,state,created_at,expires_at)
      select resource,'owner','payments.initialize',repeat(md5(resource),2),repeat('b',64),resource,'{"recovery":"keep"}','{}','completed',now()-interval '40 days',now()-interval '39 days'
      from unnest(array['pending','review','settled','missing']) resource;
    insert into idempotency_requests(id,user_id,operation,key_hash,request_hash,resource_id,parameters,state,lease_token,lease_until,created_at,expires_at)
      values('lease','owner','shipments.create',repeat('c',64),repeat('b',64),'shipment','{}','pending','lease',now()+interval '1 hour',now()-interval '40 days',now()-interval '39 days');`);
  assert.equal((await batch("idempotency")).affected, 1);
  assert.equal(
    await query(
      "select count(*) from idempotency_requests where parameters is not null",
    ),
    "4",
  );
  assert.equal(
    await query(
      "select scrubbed_at is not null and parameters is null and response is null from idempotency_requests where id='settled'",
    ),
    "t",
  );
  assert.equal((await execute(scrubRequestsStatement())).length, 0);
  assert.equal(await query("select count(*) from payments"), "3");
});
test("completed outbox cleanup preserves pending, leased and dead-letter work", async () => {
  await query(`insert into notification_outbox(id,shipment_id,recipient_id,channel,kind,payload,state,completed_at,lease_token,lease_until)
    select state,'shipment','owner','email','shipment_status','{}',state,now()-interval '31 days',
    case when state='processing' then 'lease' end,case when state='processing' then now()+interval '1 hour' end
    from unnest(array['delivered','skipped','pending','processing','dead']) state;`);
  assert.equal((await batch("outbox")).affected, 2);
  assert.equal(await query("select count(*) from notification_outbox"), "3");
});
test("account and budget cleanup protects active leases, current windows and future holds", async () => {
  await query(`insert into account_actions(id,user_id,purpose,email,credential_version,created_at,expires_at,delivery_state,lease_token,lease_until)
    select state,'owner','password_changed','owner@example.test',0,now()-interval '10 days',now()-interval '8 days',state,
      case when state='processing' then 'lease' end,case when state='processing' then now()+interval '1 hour' end
    from unnest(array['sent','processing']) state;
    insert into account_action_limits(key,window_start,count,next_at) values
      ('old',now()-interval '3 days',1,now()-interval '2 days'),('current',now(),1,now()+interval '1 hour'),
      ('held',now()-interval '3 days',1,now()+interval '1 hour');`);
  assert.equal((await batch("account_actions")).affected, 1);
  assert.equal((await batch("account_limits")).affected, 1);
  assert.equal(await query("select count(*) from account_action_limits"), "2");
});
test("delivery cleanup separates unused expiry and consumed proof retention", async () => {
  await query(`insert into delivery_confirmations(id,shipment_id,driver_id,shipment_version,email,code_hash,created_at,expires_at,consumed_at,revoked_at,delivery_state,lease_token,lease_until)
    values
    ('expired','shipment','driver',0,'guest@example.test',repeat('a',64),now()-interval '10 days',now()-interval '8 days',null,now()-interval '8 days','sent',null,null),
    ('receipt','shipment','driver',0,'guest@example.test',repeat('b',64),now()-interval '100 days',now()-interval '99 days',now()-interval '99 days',null,'sent',null,null),
    ('recent','shipment','driver',0,'guest@example.test',repeat('c',64),now()-interval '10 days',now()-interval '9 days',now()-interval '9 days',null,'sent',null,null),
    ('leased','shipment','driver',0,'guest@example.test',repeat('d',64),now()-interval '10 days',now()-interval '8 days',null,now()-interval '8 days','processing','lease',now()+interval '1 hour');`);
  assert.equal((await batch("delivery_expired")).affected, 1);
  assert.equal((await batch("delivery_consumed")).affected, 1);
  assert.equal(await query("select count(*) from delivery_confirmations"), "2");
});
test("invitation cleanup preserves accepted membership evidence and current invites", async () => {
  await query(`insert into driver_invitations(id,business_id,email,token_hash,created_at,expires_at,accepted_at) values
    ('expired','biz','a@example.test',repeat('a',64),now()-interval '40 days',now()-interval '31 days',null),
    ('accepted','biz','b@example.test',repeat('b',64),now()-interval '40 days',now()-interval '31 days',now()-interval '35 days'),
    ('current','biz','c@example.test',repeat('c',64),now(),now()+interval '1 day',null);`);
  assert.equal((await batch("invitations")).affected, 1);
  assert.equal(await query("select count(*) from driver_invitations"), "2");
});
test("read notification expiry preserves unread items and unresolved delivery deduplication", async () => {
  await query(`insert into notification_outbox(id,shipment_id,recipient_id,channel,kind,payload,state) values('held','shipment','owner','in_app','shipment_status','{}','dead');
    insert into notifications(id,user_id,type,title,message,is_read,status,created_at) values
    ('old','owner','push','Old','Fixture',true,'sent',now()-interval '91 days'),
    ('unread','owner','push','Unread','Fixture',false,'sent',now()-interval '91 days'),
    ('recent','owner','push','Recent','Fixture',true,'sent',now()-interval '1 day'),
    ('outbox_held','owner','push','Held','Fixture',true,'sent',now()-interval '91 days');`);
  assert.equal((await batch("notifications")).affected, 1);
  assert.equal(await query("select count(*) from notifications"), "3");
});
test("GPS scrubbing preserves active/custody/payment-held locations and history structure", async () => {
  await query(`insert into shipments(id,tracking_id,business_id,status,driver_id,description,weight_kg,pickup_address,delivery_address,price_kobo,current_location,updated_at,actual_pickup,return_state,returned_at)
    select id,'IST-'||id,'biz',status::shipment_status,'driver','GPS fixture',1,'{}','{}',100,'{"lat":6,"lng":3}',now()-interval '31 days',
    case when id in ('held','returned') then now()-interval '40 days' end,
    case when id='returned' then 'received' else 'none' end,case when id='returned' then now()-interval '31 days' end
    from (values('closed','cancelled'),('active','in_transit'),('held','failed'),('returned','failed'),('money','cancelled')) x(id,status);
    insert into payments(id,shipment_id,amount_kobo,provider_reference,status,checkout_state) values('payment-hold','money',100,'MONEY','pending','open');
    insert into shipment_events(id,shipment_id,status,message,location) select 'gps-'||id,id,status,'Keep audit message','{"lat":6,"lng":3}'
      from shipments where current_location is not null;`);
  assert.equal((await batch("shipment_gps")).affected, 2);
  assert.equal((await batch("event_gps")).affected, 2);
  assert.equal(
    await query(
      "select count(*) from shipments where id in ('closed','returned') and version=0 and updated_at<now()-interval '30 days'",
    ),
    "2",
  );
  assert.equal(
    await query(
      "select count(*) from shipments where current_location is not null",
    ),
    "3",
  );
  assert.equal(
    await query(
      "select count(*) from shipment_events where message='Keep audit message'",
    ),
    "5",
  );
  assert.equal(
    await query(
      "select count(*) from shipment_events where location is not null",
    ),
    "3",
  );
});
test("checkpoint failure rolls back deletion and records no false success", async () => {
  await oldSessions(1);
  await query(`create function reject_retention_checkpoint() returns trigger language plpgsql as $$begin raise exception 'Injected checkpoint failure'; end$$;
    create trigger reject_retention before update on retention_runs for each row execute function reject_retention_checkpoint();`);
  try {
    await assert.rejects(batch("sessions"), /Injected checkpoint failure/);
  } finally {
    await query(
      "drop trigger reject_retention on retention_runs; drop function reject_retention_checkpoint()",
    );
  }
  assert.equal(await query("select count(*) from auth_sessions"), "1");
  assert.equal(
    await query(
      "select last_success_at is null from retention_runs where task='sessions'",
    ),
    "t",
  );
});
test("another replica skips an owned task instead of waiting or duplicating work", async () => {
  await oldSessions(2);
  const held = query(
    "begin; select pg_advisory_xact_lock(726519,0); select pg_sleep(4); rollback",
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    if (
      await query(
        "select 1 from pg_locks where classid=726519 and objid=0 and granted limit 1",
      )
    )
      break;
    await delay(20);
  }
  try {
    const result = await batch("sessions");
    assert.equal(result.status, "busy");
    assert.equal(result.affected, 0);
  } finally {
    await held;
  }
  assert.equal((await batch("sessions")).affected, 2);
});

test("missing checkpoint configuration prevents deletion rather than losing auditability", async () => {
  await oldSessions(1);
  await query("delete from retention_runs where task='sessions'");
  try {
    const result = await batch("sessions");
    assert.equal(result.recorded, false);
    assert.equal(result.affected, 0);
    assert.equal(await query("select count(*) from auth_sessions"), "1");
  } finally {
    await query("insert into retention_runs(task) values('sessions')");
  }
});

test("locked rows are skipped while other eligible rows can be cleaned", async () => {
  await oldSessions(2);
  const held = query(
    "begin; select id from auth_sessions where id='old-1' for update; select pg_sleep(4); rollback",
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    if (
      await query(
        "select 1 from pg_locks where relation='auth_sessions'::regclass and mode='RowShareLock' and granted limit 1",
      )
    )
      break;
    await delay(20);
  }
  try {
    assert.equal((await batch("sessions")).affected, 1);
  } finally {
    await held;
  }
  assert.equal((await batch("sessions")).affected, 1);
});

test("delivered GPS expires without removing delivery proof or advancing workflow version", async () => {
  await query(`update shipments set status='out_for_delivery',driver_id='driver',recipient_email='guest@example.test',
    actual_pickup=now()-interval '35 days',current_location='{"lat":6,"lng":3}' where id='shipment';
    insert into delivery_confirmations(id,shipment_id,driver_id,shipment_version,email,code_hash,created_at,expires_at,consumed_at,delivery_state)
      values('delivered-proof','shipment','driver',1,'guest@example.test',repeat('e',64),now()-interval '40 days',now()-interval '31 days',now()-interval '31 days','sent');
    update shipments set status='delivered',actual_delivery=now()-interval '31 days' where id='shipment';`);
  assert.equal(
    await query("select version from shipments where id='shipment'"),
    "2",
  );
  assert.equal((await batch("shipment_gps")).affected, 1);
  assert.equal(
    await query(
      "select current_location is null and status='delivered' and version=2 from shipments where id='shipment'",
    ),
    "t",
  );
  assert.equal(
    await query(
      "select count(*) from delivery_confirmations where id='delivered-proof' and consumed_at is not null",
    ),
    "1",
  );
});
