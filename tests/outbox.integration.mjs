import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import nodemailer from "nodemailer";
import { postgresFixture } from "./helpers/postgres.mjs";
import { smtpFixture } from "./helpers/smtp.mjs";
import {
  shipmentCreationStatement,
  shipmentTransitionStatement,
} from "../src/db/queries/shipment-access.ts";
import { confirmPaymentStatement } from "../src/db/queries/confirm-payment.ts";
import {
  claimOutboxStatement,
  completeInAppStatement,
  dueOutboxStatement,
  replayOutboxStatement,
  purgeOutboxStatement,
} from "../src/db/queries/outbox.ts";
import { createOutboxProcessor } from "../src/workers/outbox-processor.ts";
import { dispatchOutbox } from "../src/workers/outbox-dispatcher.ts";
import {
  createOutboxRuntime,
  OUTBOX_QUEUE,
} from "../src/workers/outbox-runtime.ts";
import { renderNotificationEmail } from "../src/lib/notification-email.ts";

const postgres = postgresFixture({ prefix: "outbox" });
const redisContainer = `isotrack-outbox-redis-test-${randomUUID()}`;
const docker = promisify(execFile);
const columns = pgTable("shipments", {
  businessId: text("business_id"),
  driverId: text("driver_id"),
  customerId: text("customer_id"),
});
const store = {
  execute: async (statement) => {
    const result = await postgres.query(statement);
    return result ? result.split("\n").map((line) => JSON.parse(line)) : [];
  },
};
let redisStarted = false;
let redis;
let redisUrl;
let queue;
let smtp;
let transport;
const send = async (email) => {
  await transport.sendMail({
    from: "test@example.test",
    ...renderNotificationEmail(email, "https://app.example.test"),
  });
};

async function waitFor(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error("Condition not reached before deadline");
    await delay(100);
  }
}
before(async () => {
  await postgres.start();
  for (const name of [
    "0000_graceful_the_enforcers",
    "0002_private_fleets",
    "0003_driver_invitations",
    "0004_stripe_checkout",
    "0005_auth_sessions",
    "0006_notification_outbox",
    "0007_request_idempotency",
    "0009_payment_lifecycle",
  ]) {
    await postgres.query(
      sql.raw(
        await readFile(
          new URL(`../drizzle/${name}.sql`, import.meta.url),
          "utf8",
        ),
      ),
    );
  }
  await postgres.query(
    sql.raw(`insert into users(id,email,password_hash,name,role) values
    ('owner-a','owner-a@example.test','hash','Owner A','business'),('owner-b','owner-b@example.test','hash','Owner B','business'),
    ('customer-a','customer-a@example.test','hash','Customer','customer'),('rider-a','rider-a@example.test','hash','Driver A','driver'),
    ('rider-b','rider-b@example.test','hash','Driver B','driver');
    insert into businesses(id,user_id,business_name) values('biz-a','owner-a','A'),('biz-b','owner-b','B');
    insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate) values
      ('driver-a','rider-a','biz-a','bike','A'),('driver-b','rider-b','biz-b','bike','B');`),
  );
  await docker(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      redisContainer,
      "--publish",
      "127.0.0.1::6379",
      "redis:7.4-alpine",
    ],
    { timeout: 120000 },
  );
  redisStarted = true;
  const port = (
    await docker("docker", ["port", redisContainer, "6379/tcp"])
  ).stdout
    .trim()
    .split(":")
    .at(-1);
  redisUrl = `redis://127.0.0.1:${port}`;
  redis = new IORedis(redisUrl, {
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    enableOfflineQueue: false,
  });
  redis.on("error", () => {});
  await once(redis, "ready");
  queue = new Queue(OUTBOX_QUEUE, { connection: redis });
  await queue.waitUntilReady();
  smtp = await smtpFixture();
  transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: smtp.port,
    ignoreTLS: true,
  });
});
beforeEach(async () => {
  await redis.flushdb();
  await postgres.query(
    sql`truncate shipments,shipment_events,payments,notification_outbox,notifications cascade`,
  );
  await postgres.query(sql`update users set is_active=true`);
  await postgres.query(sql`update businesses set notification_preferences=null`);
  smtp.accepted.length = 0;
  smtp.reject(false);
});
after(async () => {
  if (queue) await queue.close();
  redis?.disconnect();
  transport?.close();
  await smtp?.close();
  if (redisStarted)
    await docker("docker", ["stop", "--time", "1", redisContainer]);
  await postgres.stop();
});

function creation(label) {
  return shipmentCreationStatement(
    sql`insert into shipments(id,tracking_id,business_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo)
    values(${label},${`IST-${label}`},'biz-a','customer-a','test',1,'{}','{}',100) returning *`,
    `created-${label}`,
  );
}
function assigned(label) {
  return shipmentTransitionStatement(
    columns,
    { userId: "owner-a", role: "business" },
    {
      shipmentId: label,
      expectedStatus: "pending",
      status: "assigned",
      driverId: "driver-a",
      eventId: `assigned-${label}`,
      message: "assigned",
    },
  );
}
async function emailFixture(label) {
  await postgres.query(creation(label));
  await postgres.query(assigned(label));
  await postgres.query(
    sql`delete from notification_outbox where channel<>'email'`,
  );
  return `shipment_assigned-${label}_email`;
}
const status = (id) =>
  postgres.query(sql`select state from notification_outbox where id=${id}`);

test("shipment creation and transition atomically capture recipient/channel notifications", async () => {
  await postgres.query(creation("capture"));
  assert.equal(
    await postgres.query(sql`select count(*) from notification_outbox`),
    "2",
  );
  await postgres.query(assigned("capture"));
  assert.equal(
    await postgres.query(sql`select count(*) from notification_outbox`),
    "5",
  );
  assert.equal(
    await postgres.query(
      sql`select count(*) from notification_outbox where channel='email' and payload->>'status'='assigned'`,
    ),
    "1",
  );
  assert.equal(await postgres.query(assigned("capture")), "");
  assert.equal(
    await postgres.query(sql`select count(*) from notification_outbox`),
    "5",
  );
});

test("outbox capture failure rolls back shipment creation and transition history", async (t) => {
  await postgres.query(
    sql`alter table notification_outbox add constraint reject_creation check(id not like 'shipment_created-rollback%')`,
  );
  t.after(() =>
    postgres.query(
      sql`alter table notification_outbox drop constraint reject_creation`,
    ),
  );
  await assert.rejects(postgres.query(creation("rollback")));
  assert.equal(
    await postgres.query(
      sql`select count(*) from shipments where id='rollback'`,
    ),
    "0",
  );
  assert.equal(
    await postgres.query(sql`select count(*) from shipment_events`),
    "0",
  );
  await postgres.query(creation("transition"));
  await postgres.query(
    sql`alter table notification_outbox add constraint reject_assignment check(payload->>'status'<>'assigned')`,
  );
  t.after(() =>
    postgres.query(
      sql`alter table notification_outbox drop constraint reject_assignment`,
    ),
  );
  await assert.rejects(postgres.query(assigned("transition")));
  assert.equal(
    await postgres.query(
      sql`select status from shipments where id='transition'`,
    ),
    "pending",
  );
  assert.equal(
    await postgres.query(
      sql`select count(*) from shipment_events where shipment_id='transition'`,
    ),
    "1",
  );
});

async function paymentFixture(label) {
  await postgres.query(creation(label));
  await postgres.query(
    sql`insert into payments(id,shipment_id,provider_reference,amount_kobo) values(${label},${label},${`REF-${label}`},100)`,
  );
  return confirmPaymentStatement({
    reference: `REF-${label}`,
    sessionId: `cs_test_${label}`,
    amountKobo: 100,
    currency: "NGN",
    channel: "stripe_checkout",
    paidAt: new Date().toISOString(),
  });
}
test("payment capture is atomic and repeated confirmation creates one notification set", async () => {
  const confirmation = await paymentFixture("payment");
  await Promise.all([
    postgres.query(confirmation),
    postgres.query(confirmation),
  ]);
  assert.equal(
    await postgres.query(
      sql`select count(*) from notification_outbox where kind='payment_confirmed'`,
    ),
    "3",
  );
  assert.equal(
    await postgres.query(sql`select is_paid from shipments where id='payment'`),
    "t",
  );
});
test("outbox failure rolls back payment success and paid shipment", async (t) => {
  const confirmation = await paymentFixture("payment-rollback");
  await postgres.query(
    sql`alter table notification_outbox add constraint reject_payment check(kind<>'payment_confirmed')`,
  );
  t.after(() =>
    postgres.query(
      sql`alter table notification_outbox drop constraint reject_payment`,
    ),
  );
  await assert.rejects(postgres.query(confirmation));
  assert.equal(
    await postgres.query(
      sql`select status from payments where id='payment-rollback'`,
    ),
    "pending",
  );
  assert.equal(
    await postgres.query(
      sql`select is_paid from shipments where id='payment-rollback'`,
    ),
    "f",
  );
});

test("real Redis/BullMQ delivery creates one in-app notification per recipient despite duplicate publication", async (t) => {
  await postgres.query(sql`update businesses set notification_preferences='{"shipmentCreated":{"email":false,"sms":false}}' where id='biz-a'`);
  await postgres.query(creation("in-app"));
  await Promise.all([
    dispatchOutbox(store, queue),
    dispatchOutbox(store, queue),
  ]);
  assert.equal(await queue.getWaitingCount(), 2);
  const runtime = createOutboxRuntime(store, redisUrl, send, () => {});
  t.after(() => runtime.close());
  await waitFor(
    async () =>
      (await postgres.query(
        sql`select count(*) from notification_outbox where state='delivered'`,
      )) === "2",
  );
  const process = createOutboxProcessor(store, send);
  await Promise.all([
    process("shipment_created-in-app_business"),
    process("shipment_created-in-app_business"),
  ]);
  assert.equal(
    await postgres.query(sql`select count(*) from notifications`),
    "2",
  );
  assert.equal(smtp.accepted.length, 0);
});

test("Redis publication timeout and lost queued data recover from durable pending rows", async (t) => {
  await postgres.query(creation("redis-loss"));
  await redis.call("CLIENT", "PAUSE", "1500", "ALL");
  await assert.rejects(dispatchOutbox(store, queue));
  assert.equal(
    await postgres.query(
      sql`select count(*) from notification_outbox where state='pending'`,
    ),
    "2",
  );
  await delay(1600);
  await dispatchOutbox(store, queue);
  assert.equal(await queue.getWaitingCount(), 2);
  await redis.flushdb();
  assert.equal(await queue.getWaitingCount(), 0);
  await dispatchOutbox(store, queue);
  assert.equal(await queue.getWaitingCount(), 2);
  const runtime = createOutboxRuntime(store, redisUrl, send, () => {});
  t.after(() => runtime.close());
  await waitFor(
    async () =>
      (await postgres.query(sql`select count(*) from notifications`)) === "2",
  );
});

test("expired leases can be reclaimed and old owners cannot commit delivery", async () => {
  await postgres.query(creation("lease"));
  const id = "shipment_created-lease_business";
  const claims = await Promise.all([
    store.execute(claimOutboxStatement(id, "first")),
    store.execute(claimOutboxStatement(id, "second")),
  ]);
  assert.equal(claims.filter((rows) => rows.length).length, 1);
  const previous = claims[0].length ? "first" : "second";
  await postgres.query(
    sql`update notification_outbox set lease_until=now()-interval '1 second' where id=${id}`,
  );
  assert.equal(
    (await store.execute(claimOutboxStatement(id, "replacement"))).length,
    1,
  );
  assert.equal(
    (
      await store.execute(
        completeInAppStatement(id, previous, "Title", "Message"),
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await store.execute(
        completeInAppStatement(id, "replacement", "Title", "Message"),
      )
    ).length,
    1,
  );
  assert.equal(
    await postgres.query(sql`select count(*) from notifications`),
    "1",
  );
});

test("SMTP failures exhaust a bounded retry budget and explicit replay recovers a dead letter", async () => {
  const id = await emailFixture("retry");
  smtp.reject(true);
  const process = createOutboxProcessor(store, send);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(process(id), /Notification delivery failed/);
    assert.equal(
      await postgres.query(
        sql`select attempts from notification_outbox where id=${id}`,
      ),
      String(attempt),
    );
    await postgres.query(
      sql`update notification_outbox set available_at=now() where id=${id}`,
    );
  }
  assert.equal(await status(id), "dead");
  assert.equal((await store.execute(dueOutboxStatement())).length, 0);
  assert.equal((await store.execute(replayOutboxStatement(id))).length, 1);
  smtp.reject(false);
  await process(id);
  await process(id);
  assert.equal(await status(id), "delivered");
  assert.equal(smtp.accepted.length, 1);
  assert.equal((await store.execute(replayOutboxStatement(id))).length, 0);
});

test("inactive recipients and changed business ownership are skipped rather than notified", async () => {
  await postgres.query(creation("inactive"));
  await postgres.query(
    sql`update users set is_active=false where id='customer-a'`,
  );
  const process = createOutboxProcessor(store, send);
  await process("shipment_created-inactive_customer");
  assert.equal(await status("shipment_created-inactive_customer"), "skipped");
  await postgres.query(
    sql`update shipments set business_id='biz-b' where id='inactive'`,
  );
  await process("shipment_created-inactive_business");
  assert.equal(await status("shipment_created-inactive_business"), "skipped");
  assert.equal(
    await postgres.query(sql`select count(*) from notifications`),
    "0",
  );
});

test("worker killed after SMTP acceptance recovers with an explicit at-least-once duplicate window", async (t) => {
  const id = await emailFixture("crash");
  const child = fork(
    fileURLToPath(new URL("./helpers/outbox-worker.mjs", import.meta.url)),
    [],
    {
      env: {
        ...process.env,
        TEST_POSTGRES_CONTAINER: postgres.container,
        TEST_REDIS_URL: redisUrl,
        TEST_SMTP_PORT: String(smtp.port),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let childOutput = "";
  child.stderr.on("data", (chunk) => {
    childOutput += chunk;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(25000) }),
    once(child, "exit").then(() => {
      throw new Error(`Worker exited before sending: ${childOutput}`);
    }),
  ]);
  assert.equal(smtp.accepted.length, 1);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal(await status(id), "processing");
  // Accelerate the DB lease; real BullMQ lock/stalled-job recovery still runs.
  await postgres.query(
    sql`update notification_outbox set lease_until=now()-interval '1 second' where id=${id}`,
  );
  const runtime = createOutboxRuntime(store, redisUrl, send, () => {}, {
    lockDuration: 1000,
    stalledInterval: 1000,
  });
  t.after(() => runtime.close());
  await waitFor(async () => (await status(id)) === "delivered", 30000);
  assert.equal(smtp.accepted.length, 2);
  const ids = smtp.accepted.map(
    (message) =>
      message
        .replace(/\r?\n[ \t]+/g, " ")
        .match(/^Message-ID:\s*(<[^>]+>)/im)?.[1],
  );
  assert.ok(ids[0]);
  assert.equal(ids[0], ids[1]);
  assert.equal(
    await postgres.query(
      sql`select attempts from notification_outbox where id=${id}`,
    ),
    "2",
  );
});

test("exhausted abandoned leases become dead letters and cleanup preserves unresolved work", async () => {
  await postgres.query(creation("retention"));
  const id = "shipment_created-retention_business";
  await store.execute(claimOutboxStatement(id, "abandoned"));
  await postgres.query(
    sql`update notification_outbox set attempts=5,lease_until=now()-interval '1 second' where id=${id}`,
  );
  await store.execute(dueOutboxStatement());
  assert.equal(await status(id), "dead");
  await postgres.query(
    sql`update notification_outbox set state='delivered',completed_at=now()-interval '31 days' where id='shipment_created-retention_customer'`,
  );
  assert.equal((await store.execute(purgeOutboxStatement())).length, 1);
  assert.equal(await status(id), "dead");
});


test("Business email preferences preserve in-app updates and suppress queued emails before dispatch", async () => {
  const process = createOutboxProcessor(store, send);
  await postgres.query(creation("business-prefs"));
  const inAppId = "shipment_created-business-prefs_business";
  const emailId = `${inAppId}_email`;
  await process(inAppId);
  await process(inAppId);
  assert.equal(await status(emailId), "pending");
  assert.equal(await postgres.query(sql`select count(*) from notifications where user_id='owner-a'`), "1");
  await postgres.query(sql`update businesses set notification_preferences='{"shipmentCreated":{"email":false,"sms":true}}' where id='biz-a'`);
  await process(emailId);
  assert.equal(await status(emailId), "skipped");
  assert.equal(smtp.accepted.length, 0);
  await postgres.query(creation("business-optout"));
  await process("shipment_created-business-optout_business");
  assert.equal(await status("shipment_created-business-optout_business_email"), "");
  assert.equal(await postgres.query(sql`select count(*) from notifications where user_id='owner-a'`), "2");
  await postgres.query(assigned("business-optout"));
  await process("shipment_assigned-business-optout_business");
  await process("shipment_assigned-business-optout_business_email");
  await process("shipment_assigned-business-optout_email");
  assert.equal(smtp.accepted.length, 2);
  assert.equal(await status("shipment_assigned-business-optout_business_email"), "delivered");
  assert.equal(await status("shipment_assigned-business-optout_email"), "delivered");
});
