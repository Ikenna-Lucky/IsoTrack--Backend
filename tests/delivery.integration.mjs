import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serve } from "@hono/node-server";
import { SignJWT } from "jose";
import { sql } from "drizzle-orm";
import { postgresFixture } from "./helpers/postgres.mjs";
import { runMigrations } from "../src/db/migration-runner.ts";
import { createShipmentCommandRouter } from "../src/routes/shipment-commands.ts";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.ts";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { activeSessionStatement } from "../src/db/queries/session-statements.ts";

const pg = postgresFixture({ prefix: "delivery" });
const query = (text) => pg.query(sql.raw(text));
const store = {
  execute: async (statement) => {
    const result = await pg.query(statement);
    return result ? result.split("\n").map((line) => JSON.parse(line)) : [];
  },
};
const secret = new TextEncoder().encode(
  "shipment-command-signature-fixture-32",
);
const tokens = new Map();
let server,
  base,
  failAfterCommit = false;
before(async () => {
  mail = await smtpFixture();
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
  await query(`insert into users(id,email,password_hash,name,role) values
    ('owner','owner@example.test','hash','Owner','business'),('other','other@example.test','hash','Other','business'),
    ('rider','rider@example.test','hash','Rider','driver'),('customer','customer@example.test','hash','Customer','customer');
    insert into businesses(id,user_id,business_name) values('biz','owner','A'),('other-biz','other','B');
    insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate) values('driver','rider','biz','bike','TEST');
    insert into auth_sessions(id,user_id,credential_version,expires_at) select 'session_'||id,id,0,now()+interval '1 day' from users;`);
  for (const [id, role] of [
    ["owner", "business"],
    ["other", "business"],
    ["rider", "driver"],
    ["customer", "customer"],
  ]) {
    tokens.set(
      id,
      await new SignJWT({ type: "access", role, sid: `session_${id}` })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(id)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(secret),
    );
  }
  const app = new Hono();
  app.onError((e, c) =>
    e instanceof HTTPException
      ? e.getResponse()
      : c.json({ error: "SERVER_FAILURE" }, 500),
  );
  app.use(
    "*",
    createAuthenticationMiddleware({
      verifyToken: (t) => verifySessionToken(t, secret, "access"),
      findUser: async (id) => {
        const result = await pg.query(
          sql`select jsonb_build_object('id',id,'role',role,'email',email,'isActive',is_active) from users where id=${id}`,
        );
        return result ? JSON.parse(result) : null;
      },
      isSessionActive: async (sid, id) =>
        Boolean(await pg.query(activeSessionStatement(sid, id))),
    }),
  );
  app.route(
    "/shipments",
    createShipmentCommandRouter({
      execute: async (statement) => {
        const result = await store.execute(statement);
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new Error("Injected lost database acknowledgement");
        }
        return result;
      },
    }),
  );
  app.route(
    "/shipments",
    createDeliveryRouter(
      {
        execute: async (statement) => {
          const result = await store.execute(statement);
          if (failAfterCommit) {
            failAfterCommit = false;
            throw new Error("lost acknowledgement");
          }
          return result;
        },
      },
      deliverySecret,
    ),
  );
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  failAfterCommit = false;
  await query(`truncate shipments,idempotency_requests,account_action_limits cascade;
    insert into shipments(id,tracking_id,business_id,customer_id,description,weight_kg,pickup_address,delivery_address,price_kobo)
    values('shipment','IST-COMMAND','biz','customer','Box',1,'{}','{}',100);`);
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await mail.close();
  await pg.stop();
});

import { createDeliveryRouter } from "../src/routes/delivery.ts";
import { deliveryCode } from "../src/lib/delivery-code.ts";
import { backlogStatement } from "../src/observability/backlog.ts";
import { purgeDeliveryConfirmations } from "../src/db/queries/delivery-operations.ts";
import { createDeliveryEmailProcessor } from "../src/workers/delivery-email.ts";
import nodemailer from "nodemailer";
import { smtpFixture } from "./helpers/smtp.mjs";
const deliverySecret = "ab".repeat(32);
let mail;
test("new delivered inserts are rejected and retention cleanup preserves current work", async () => {
  await assert.rejects(
    query(
      "insert into shipments(id,tracking_id,business_id,status,description,weight_kg,pickup_address,delivery_address,price_kobo) values('bypass','IST-BYPASS','biz','delivered','Box',1,'{}','{}',100)",
    ),
    /Delivery confirmation required/,
  );
  await issue(await ready());
  assert.equal((await store.execute(purgeDeliveryConfirmations())).length, 0);
  await query(
    "update delivery_confirmations set created_at=now()-interval '10 days',expires_at=now()-interval '8 days'",
  );
  assert.equal((await store.execute(purgeDeliveryConfirmations())).length, 1);
  assert.equal(await query("select count(*) from shipments"), "1");
  assert.equal(await query("select count(*) from idempotency_requests"), "1");
});
test("delivery pending, dead-letter and expired-lease metrics read durable records", async () => {
  const d = await issue(await ready());
  await query(
    "update delivery_confirmations set available_at=now()-interval '15 minutes'",
  );
  await pg.query(sql`insert into delivery_confirmations(id,shipment_id,driver_id,shipment_version,email,code_hash,expires_at,revoked_at,delivery_state,available_at,lease_token,lease_until)
  values('dead','shipment','driver',${d.version},'guest@example.test',repeat('a',64),now()+interval '1 hour',now(),'dead',now()-interval '15 minutes',null,null),
  ('lease','shipment','driver',${d.version},'guest@example.test',repeat('b',64),now()+interval '1 hour',now(),'processing',now(),'old',now()-interval '15 minutes')`);
  const rows = await store.execute(backlogStatement());
  for (const name of [
    "delivery_emails",
    "delivery_email_dead",
    "delivery_email_leases",
  ]) {
    const row = rows.find((r) => r.queue === name);
    assert.equal(row.present, true);
    assert.ok(Number(row.age) >= 890);
  }
});
const key = (label) => label.padEnd(24, "_");
function post(path, body, label, actor = "owner") {
  return fetch(`${base}/shipments/shipment/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(actor ? { Authorization: `Bearer ${tokens.get(actor)}` } : {}),
      "Idempotency-Key": key(label),
    },
    body: JSON.stringify(body),
  });
}
async function ready() {
  await query(
    "update shipments set status='out_for_delivery',driver_id='driver' where id='shipment'",
  );
  return Number(
    await query("select version from shipments where id='shipment'"),
  );
}
async function issue(v, label = "issue", email = "guest@example.test") {
  const response = await post(
    "delivery-code",
    { expectedVersion: v, recipientEmail: email },
    label,
  );
  assert.equal(response.status, 200);
  return (await response.json()).data;
}
const confirm = (
  d,
  code = deliveryCode(d.challengeId, deliverySecret),
  label = "confirm",
  actor = "rider",
) =>
  post(
    "confirm-delivery",
    { expectedVersion: d.version, challengeId: d.challengeId, code },
    label,
    actor,
  );
async function snapshot() {
  return JSON.parse(
    await query(
      `select jsonb_build_object('status',status,'version',version,'actualDelivery',actual_delivery,'events',(select count(*) from shipment_events),'consumed',(select count(*) from delivery_confirmations where consumed_at is not null),'notices',(select count(*) from notification_outbox)) from shipments where id='shipment'`,
    ),
  );
}
test("guest code issuance is private, durable and delivered through real SMTP", async () => {
  await query("update shipments set customer_id=null");
  const v = await ready(),
    d = await issue(v),
    code = deliveryCode(d.challengeId, deliverySecret);
  assert.equal(d.version, v + 1);
  assert.ok(!JSON.stringify(d).includes(code));
  const persisted = await query(
    "select row_to_json(d)::text from delivery_confirmations d",
  );
  assert.ok(!persisted.includes(code));
  const records = await query(
    "select coalesce(jsonb_agg(parameters),'[]')::text from idempotency_requests",
  );
  assert.ok(!records.includes(code));
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: mail.port,
    secure: false,
    ignoreTLS: true,
  });
  const before = mail.accepted.length;
  try {
    await createDeliveryEmailProcessor(store, deliverySecret, async (email) => {
      await transport.sendMail({ from: "test@example.test", ...email });
    })();
  } finally {
    transport.close();
  }
  assert.equal(mail.accepted.length, before + 1);
  assert.match(mail.accepted.at(-1), /guest@example.test/);
  assert.ok(mail.accepted.at(-1).includes(code));
  assert.equal(
    await query("select delivery_state from delivery_confirmations"),
    "sent",
  );
  const fetched = await fetch(`${base}/shipments/shipment/delivery-code`, {
    headers: { Authorization: `Bearer ${tokens.get("rider")}` },
  });
  assert.equal(fetched.status, 200);
  assert.ok(!(await fetched.text()).includes(code));
});
test("issue replay, durable resend budgets and competing different-key confirmations remain bounded", async () => {
  const v = await ready(),
    first = await issue(v);
  const replay = await post(
    "delivery-code",
    { expectedVersion: v, recipientEmail: "guest@example.test" },
    "issue",
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.equal((await replay.json()).data.challengeId, first.challengeId);
  let current = first;
  for (let i = 0; i < 2; i++) {
    await query(
      "update delivery_confirmations set created_at=now()-interval '2 minutes' where revoked_at is null",
    );
    current = await issue(current.version, `rotate-${i}`);
  }
  await query(
    "update delivery_confirmations set created_at=now()-interval '2 minutes' where revoked_at is null",
  );
  assert.equal(
    (
      await post(
        "delivery-code",
        {
          expectedVersion: current.version,
          recipientEmail: "guest@example.test",
        },
        "over-budget",
      )
    ).status,
    409,
  );
  const responses = await Promise.all([
    confirm(current, undefined, "race-a"),
    confirm(current, undefined, "race-b"),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await snapshot()).consumed, 1);
});
test("expired email leases are recovered and old owners cannot overwrite a newer worker", async () => {
  const d = await issue(await ready());
  let entered, release;
  const waiting = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  const first = createDeliveryEmailProcessor(
    store,
    deliverySecret,
    async () => {
      entered();
      await gate;
    },
  )();
  await waiting;
  await query(
    "update delivery_confirmations set lease_until=now()-interval '1 second'",
  );
  let secondSent = 0;
  await createDeliveryEmailProcessor(
    store,
    deliverySecret,
    async () => secondSent++,
  )();
  release();
  await first;
  assert.equal(secondSent, 1);
  assert.equal(
    await query("select delivery_state from delivery_confirmations"),
    "sent",
  );
  assert.equal(await query("select attempts from delivery_confirmations"), "2");
  assert.equal((await confirm(d)).status, 200);
});
test("confirmation is atomic and same-key replay survives response loss", async () => {
  const d = await issue(await ready());
  failAfterCommit = true;
  assert.equal((await confirm(d)).status, 500);
  const retry = await confirm(d);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get("Idempotency-Replayed"), "true");
  const data = (await retry.json()).data;
  assert.equal(data.recipientEmail, undefined);
  assert.equal(data.status, "delivered");
  assert.ok(data.actualDelivery);
  const s = await snapshot();
  assert.equal(s.events, 1);
  assert.equal(s.consumed, 1);
  assert.equal(s.notices, 3);
});
test("wrong-code attempts are committed, idempotent, capped and cannot be reset by new keys", async () => {
  const d = await issue(await ready());
  const wrong =
    deliveryCode(d.challengeId, deliverySecret) === "00000000"
      ? "11111111"
      : "00000000";
  assert.equal((await confirm(d, wrong, "bad-0")).status, 422);
  assert.equal((await confirm(d, wrong, "bad-0")).status, 422);
  assert.equal(await query("select failures from delivery_confirmations"), "1");
  for (let i = 1; i < 5; i++)
    assert.equal((await confirm(d, wrong, `bad-${i}`)).status, 422);
  assert.equal((await confirm(d, undefined, "correct-after-lock")).status, 409);
  assert.equal((await snapshot()).status, "out_for_delivery");
});
test("expired, revoked and stale-version codes cannot complete a delivery", async () => {
  let d = await issue(await ready());
  await query(
    "update delivery_confirmations set created_at=now()-interval '1 hour',expires_at=now()-interval '1 minute'",
  );
  assert.equal((await confirm(d)).status, 409);
  d = await issue(d.version, "replacement");
  await query("update delivery_confirmations set revoked_at=now()");
  assert.equal((await confirm(d, undefined, "revoked")).status, 409);
  await pg.query(
    sql`update delivery_confirmations set revoked_at=null where id=${d.challengeId}; update shipments set status='failed',failure_reason='vehicle_issue',failed_at=now()`,
  );
  assert.equal((await confirm(d, undefined, "stale")).status, 409);
});
test("races converge on one receipt, event and notification set", async () => {
  const d = await issue(await ready());
  const responses = await Promise.all([confirm(d), confirm(d)]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  assert.equal((await snapshot()).events, 1);
});
test("outbox failure rolls back consumed proof, status, history and saved response", async () => {
  const d = await issue(await ready());
  await query(
    "create function reject_delivery_notice() returns trigger language plpgsql as $$begin raise exception 'fixture';end$$; create trigger reject_delivery_notice before insert on notification_outbox for each row execute function reject_delivery_notice()",
  );
  try {
    assert.equal((await confirm(d)).status, 500);
    const s = await snapshot();
    assert.equal(s.status, "out_for_delivery");
    assert.equal(s.consumed, 0);
    assert.equal(s.events, 0);
  } finally {
    await query(
      "drop trigger reject_delivery_notice on notification_outbox;drop function reject_delivery_notice()",
    );
  }
  assert.equal((await confirm(d)).status, 200);
});
test("only owner issues and assigned driver confirms; direct delivered writes are blocked", async () => {
  const v = await ready();
  assert.equal(
    (
      await post(
        "delivery-code",
        { expectedVersion: v, recipientEmail: "guest@example.test" },
        "foreign",
        "other",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await post(
        "delivery-code",
        { expectedVersion: v, recipientEmail: "guest@example.test" },
        "driver",
        "rider",
      )
    ).status,
    403,
  );
  const d = await issue(v);
  assert.equal(
    (await confirm(d, undefined, "owner-confirm", "owner")).status,
    403,
  );
  assert.equal((await confirm(d, undefined, "anonymous", null)).status, 401);
  const bypass = await fetch(`${base}/shipments/shipment/status`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${tokens.get("rider")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key("bypass"),
    },
    body: JSON.stringify({ expectedVersion: d.version, status: "delivered" }),
  });
  assert.equal(bypass.status, 422);
  await assert.rejects(
    query("update shipments set status='delivered'"),
    /Delivery confirmation required/,
  );
  await query("update shipments set driver_id=null");
  assert.equal((await confirm(d, undefined, "unassigned")).status, 404);
});
test("resend rotates proof, fences old emails/codes and enforces durable cooldown", async () => {
  const first = await issue(await ready());
  assert.equal(
    (
      await post(
        "delivery-code",
        {
          expectedVersion: first.version,
          recipientEmail: "guest@example.test",
        },
        "too-soon",
      )
    ).status,
    409,
  );
  await query(
    "update delivery_confirmations set created_at=now()-interval '2 minutes'",
  );
  const second = await issue(
    first.version,
    "resend",
    "other-guest@example.test",
  );
  assert.equal((await confirm(first, undefined, "old-code")).status, 409);
  const sent = [];
  await createDeliveryEmailProcessor(store, deliverySecret, async (email) =>
    sent.push(email),
  )();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "other-guest@example.test");
  assert.equal((await confirm(second, undefined, "new-code")).status, 200);
});
test("SMTP failures exhaust retries and secret rotation cannot send a usable old code", async () => {
  const d = await issue(await ready());
  const fail = createDeliveryEmailProcessor(store, deliverySecret, async () => {
    throw new Error("SMTP fixture failure");
  });
  for (let i = 0; i < 5; i++) {
    await fail();
    await query(
      "update delivery_confirmations set available_at=now()-interval '1 minute'",
    );
  }
  assert.equal(
    await query("select delivery_state from delivery_confirmations"),
    "dead",
  );
  await query(
    "update delivery_confirmations set delivery_state='pending',attempts=0",
  );
  let sent = 0;
  await createDeliveryEmailProcessor(
    store,
    "cd".repeat(32),
    async () => sent++,
  )();
  assert.equal(sent, 0);
  assert.equal(
    await query("select delivery_state from delivery_confirmations"),
    "skipped",
  );
  assert.equal((await confirm(d)).status, 200);
});
