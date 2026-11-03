import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  real,
  integer,
  jsonb,
  PgDialect,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/neon-http";
import {
  shipmentAccessPredicate,
  shipmentTransitionStatement,
  shipmentCreationStatement,
} from "../src/db/queries/shipment-access.ts";
import { fleetAccessPredicate } from "../src/db/queries/fleet-access.ts";
import { readFileSync } from "node:fs";
import {
  acceptDriverInvitationStatement,
  acceptExistingDriverInvitationStatement,
} from "../src/db/queries/accept-driver-invitation.ts";
import { createExistingDriverInvitationRouter } from "../src/routes/existing-driver-invitation.ts";
import { hashInvitationToken } from "../src/lib/invitation-token.ts";
import { SignJWT } from "jose";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.ts";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { confirmPaymentStatement } from "../src/db/queries/confirm-payment.ts";
import { createStripeWebhookRouter } from "../src/routes/stripe-webhook.ts";
import Stripe from "stripe";
import { parseStripeSession } from "../src/lib/stripe-payload.ts";
import { openSessionStatement, rotateSessionStatement, activeSessionStatement, revokeSessionStatement, changePasswordStatement, purgeExpiredSessionsStatement } from "../src/db/queries/session-statements.ts";
import { createSessionRouter } from "../src/routes/sessions.ts";
import { requireSessionClaims } from "../src/lib/session-claims.ts";

const container = `isotrack-access-test-${randomUUID()}`;
const image = "postgres:17-alpine";
const dialect = new PgDialect();
const shipments = pgTable("shipments", {
  businessId: text("business_id"),
  driverId: text("driver_id"),
  customerId: text("customer_id"),
});
let started = false;

function docker(args, input) {
  return execFileSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function compile(statement) {
  const compiled = dialect.sqlToQuery(statement);
  // Only generated fixture strings are inlined for psql; application queries
  // continue to use driver-bound parameters.
  const text = compiled.sql.replace(/\$(\d+)/g, (_, index) => {
    const value = compiled.params[Number(index) - 1];
    if (value === null) return "NULL";
    if (typeof value === "number") {
      assert.ok(Number.isFinite(value));
      return String(value);
    }
    assert.equal(typeof value, "string");
    return `'${value.replaceAll("'", "''")}'`;
  });
  return text;
}

const psqlArgs = () => [
  "exec",
  "-i",
  container,
  "psql",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-qAt",
  "-v",
  "ON_ERROR_STOP=1",
];

function query(statement) {
  return docker(psqlArgs(), compile(statement));
}

async function concurrentQuery(statement) {
  const process = promisify(execFile)("docker", psqlArgs(), {
    encoding: "utf8",
    timeout: 30_000,
  });
  process.child.stdin.end(compile(statement));
  return (await process).stdout.trim();
}

before(async () => {
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--env",
    "POSTGRES_PASSWORD=isolated-test-only",
    image,
  ]);
  started = true;
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      docker(["exec", container, "pg_isready", "-U", "postgres"]);
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  query(
    sql.raw(`
    create table businesses (id text primary key, user_id text not null);
    create table drivers (id text primary key, user_id text not null, business_id text);
    create table shipments (
      id text primary key, business_id text references businesses(id),
      driver_id text references drivers(id), customer_id text, status text
    );
    insert into businesses values ('biz-a', 'owner-a'), ('biz-b', 'owner-b');
    insert into drivers values ('driver-a', 'rider-a', 'biz-a'), ('driver-b', 'rider-b', 'biz-b'), ('legacy', 'legacy-rider', null);
    insert into shipments values
      ('shipment-a', 'biz-a', 'driver-a', 'customer-a', 'pending'),
      ('shipment-b', 'biz-b', 'driver-b', 'customer-b', 'pending'),
      ('unassigned', 'biz-b', null, null, 'pending');
  `),
  );
});

after(() => {
  if (started) docker(["stop", "--time", "1", container]);
});

for (const [role, userId] of [
  ["business", "owner-a"],
  ["driver", "rider-a"],
  ["customer", "customer-a"],
]) {
  test(`${role} can read only its own shipment`, () => {
    const predicate = shipmentAccessPredicate(shipments, { role, userId });
    assert.equal(
      query(sql`select id from ${shipments} where ${predicate}`),
      "shipment-a",
    );
  });

  test(`${role} cannot update a foreign shipment`, () => {
    const predicate = shipmentAccessPredicate(shipments, { role, userId });
    assert.equal(
      query(sql`with changed as (
      update ${shipments} set status = 'cancelled'
      where id = 'shipment-b' and ${predicate} returning id
    ) select count(*) from changed`),
      "0",
    );
    assert.equal(
      query(sql`select status from ${shipments} where id = 'shipment-b'`),
      "pending",
    );
  });
}

test("unknown roles and SQL injection strings grant no access", () => {
  for (const actor of [
    { role: "admin", userId: "owner-a" },
    { role: "business", userId: "owner-a' OR true --" },
    { role: "driver", userId: "missing" },
    { role: "customer", userId: "missing" },
  ]) {
    assert.equal(
      query(sql`select count(*) from ${shipments}
      where ${shipmentAccessPredicate(shipments, actor)}`),
      "0",
    );
  }
});

test("businesses discover only their own drivers and exclude unlinked accounts", () => {
  const drivers = pgTable("drivers", { businessId: text("business_id") });
  for (const [owner, expected] of [
    ["owner-a", "driver-a"],
    ["owner-b", "driver-b"],
    ["missing", ""],
  ]) {
    assert.equal(
      query(
        sql`select id from ${drivers} where ${fleetAccessPredicate(drivers.businessId, owner)}`,
      ),
      expected,
    );
  }
});

test("legacy or mismatched membership cannot authorize driver access", () => {
  query(
    sql.raw(`insert into shipments values
    ('mismatch', 'biz-b', 'driver-a', null, 'pending'),
    ('legacy-shipment', 'biz-a', 'legacy', null, 'pending')`),
  );
  assert.equal(
    query(
      sql`select id from ${shipments} where ${shipmentAccessPredicate(shipments, { role: "driver", userId: "rider-a" })}`,
    ),
    "shipment-a",
  );
  assert.equal(
    query(
      sql`select count(*) from ${shipments} where ${shipmentAccessPredicate(shipments, { role: "driver", userId: "legacy-rider" })}`,
    ),
    "0",
  );
});

test("actual migrations repair skipped settings and enforce fleet assignment constraints", () => {
  // Separate schema preserves the existing ownership fixture; no application DB.
  const initial = readFileSync(
    new URL("../drizzle/0000_graceful_the_enforcers.sql", import.meta.url),
    "utf8",
  );
  const fleet = readFileSync(
    new URL("../drizzle/0002_private_fleets.sql", import.meta.url),
    "utf8",
  );
  query(
    sql.raw(`create schema migration_test; set search_path to migration_test, public;
    ${initial.replaceAll('"public".', '"migration_test".')}
    insert into users (id,email,password_hash,name,role) values
      ('owner-a','a@example.test','test','A','business'),
      ('owner-b','b@example.test','test','B','business'),
      ('rider-a','r@example.test','test','R','driver');
    insert into businesses (id,user_id,business_name) values ('biz-a','owner-a','A'),('biz-b','owner-b','B');
    insert into drivers (id,user_id,vehicle_type,vehicle_plate) values ('driver-a','rider-a','bike','TEST');
    ${fleet}
    do $$ begin
      if (select business_id from drivers where id='driver-a') is not null then
        raise exception 'Legacy driver was assigned without consent';
      end if;
    end $$;
    update drivers set business_id='biz-a' where id='driver-a';
    insert into shipments (id,tracking_id,business_id,driver_id,description,weight_kg,pickup_address,delivery_address,price_kobo)
      values ('s','IST-TEST','biz-a','driver-a','test',1,'{}','{}',100);
    do $$ begin
      begin
        update shipments set business_id='biz-b' where id='s';
        raise exception 'Cross-business assignment was allowed';
      exception when foreign_key_violation then null;
      end;
      begin
        insert into drivers(id,user_id,business_id,vehicle_type,vehicle_plate)
          values ('duplicate','rider-a','biz-b','bike','OTHER');
        raise exception 'Duplicate driver account was allowed';
      exception when unique_violation then null;
      end;
    end $$;
    select emergency_contact from users limit 1;
    select vehicle_model from drivers limit 1;
    select preferences,notification_preferences from businesses limit 1;
    alter table shipments validate constraint shipments_driver_business_fk;
  `),
  );
});

const inMigrationSchema = (statement) =>
  sql`set search_path to migration_test, public; ${statement}`;
function acceptance(suffix, overrides = {}) {
  return acceptDriverInvitationStatement({
    tokenHash: `hash-${suffix}`,
    email: `${suffix}@example.test`,
    userId: `user-${suffix}`,
    driverId: `driver-${suffix}`,
    name: "Invited Driver",
    passwordHash: "fixture-hash",
    vehicleType: "bike",
    vehiclePlate: "TEST-123",
    ...overrides,
  });
}
function issue(suffix, state = "pending") {
  query(
    inMigrationSchema(sql`insert into driver_invitations
    (id,business_id,email,token_hash,created_at,expires_at,revoked_at)
    values (${suffix},'biz-a',${`${suffix}@example.test`},${`hash-${suffix}`},
      now() - interval '3 days',
      case when ${state} = 'expired' then now() - interval '1 day' else now() + interval '1 day' end,
      case when ${state} = 'revoked' then now() else null end)`),
  );
}

test("invitation migration installs on the actual application schema", () => {
  const migration = readFileSync(
    new URL("../drizzle/0003_driver_invitations.sql", import.meta.url),
    "utf8",
  );
  query(inMigrationSchema(sql.raw(migration)));
});

test("acceptance creates one driver membership and replay creates nothing", () => {
  issue("valid");
  assert.equal(
    query(inMigrationSchema(acceptance("valid"))),
    "user-valid|driver-valid|biz-a",
  );
  assert.equal(
    query(
      inMigrationSchema(
        acceptance("valid", { userId: "replayed", driverId: "replayed" }),
      ),
    ),
    "",
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from users where email='valid@example.test'`,
      ),
    ),
    "1",
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from drivers where user_id='user-valid' and business_id='biz-a'`,
      ),
    ),
    "1",
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select accepted_at is not null from driver_invitations where id='valid'`,
      ),
    ),
    "t",
  );
});

test("expired, revoked, unknown and wrong-recipient invitations create no accounts", () => {
  issue("expired", "expired");
  issue("revoked", "revoked");
  issue("wrong");
  for (const [suffix, overrides] of [
    ["expired", {}],
    ["revoked", {}],
    ["unknown", {}],
    ["wrong", { email: "someone-else@example.test" }],
  ]) {
    assert.equal(query(inMigrationSchema(acceptance(suffix, overrides))), "");
    assert.equal(
      query(
        inMigrationSchema(
          sql`select count(*) from users where id=${`user-${suffix}`}`,
        ),
      ),
      "0",
    );
  }
});

test("existing accounts are never overwritten and the invitation stays pending", () => {
  issue("existing");
  query(
    inMigrationSchema(sql`insert into users(id,email,password_hash,name,role)
    values ('existing-user','existing@example.test','original-hash','Original','customer')`),
  );
  assert.equal(query(inMigrationSchema(acceptance("existing"))), "");
  assert.equal(
    query(
      inMigrationSchema(
        sql`select password_hash,role from users where id='existing-user'`,
      ),
    ),
    "original-hash|customer",
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select accepted_at is null from driver_invitations where id='existing'`,
      ),
    ),
    "t",
  );
});

test("a driver insert failure rolls back user creation and invitation consumption", () => {
  issue("rollback");
  assert.throws(() =>
    query(inMigrationSchema(acceptance("rollback", { driverId: "driver-a" }))),
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from users where id='user-rollback'`,
      ),
    ),
    "0",
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select accepted_at is null from driver_invitations where id='rollback'`,
      ),
    ),
    "t",
  );
});

test("concurrent acceptance of one invitation succeeds exactly once", async () => {
  issue("race");
  const results = await Promise.all([
    concurrentQuery(
      inMigrationSchema(
        acceptance("race", { userId: "race-one", driverId: "race-one" }),
      ),
    ),
    concurrentQuery(
      inMigrationSchema(
        acceptance("race", { userId: "race-two", driverId: "race-two" }),
      ),
    ),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from users where email='race@example.test'`,
      ),
    ),
    "1",
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from drivers where user_id in ('race-one','race-two')`,
      ),
    ),
    "1",
  );
});

test("two invitations for the same email cannot create two accounts or fleets", async () => {
  issue("shared");
  query(
    inMigrationSchema(sql`insert into driver_invitations (id,business_id,email,token_hash,expires_at)
    values ('shared-other','biz-b','shared@example.test','hash-shared-other',now()+interval '1 day')`),
  );
  const results = await Promise.all([
    concurrentQuery(inMigrationSchema(acceptance("shared"))),
    concurrentQuery(
      inMigrationSchema(
        acceptance("shared", {
          tokenHash: "hash-shared-other",
          userId: "shared-other-user",
          driverId: "shared-other-driver",
        }),
      ),
    ),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from users where email='shared@example.test'`,
      ),
    ),
    "1",
  );
  assert.equal(
    query(
      inMigrationSchema(sql`select count(*) from driver_invitations
    where email='shared@example.test' and accepted_at is not null`),
    ),
    "1",
  );
});

test("revocation competing with acceptance leaves exactly one terminal state", async () => {
  issue("revoke-race");
  await Promise.all([
    concurrentQuery(inMigrationSchema(acceptance("revoke-race"))),
    concurrentQuery(
      inMigrationSchema(sql`update driver_invitations set revoked_at=now()
      where id='revoke-race' and accepted_at is null and revoked_at is null returning id`),
    ),
  ]);
  const state = query(
    inMigrationSchema(sql`select accepted_at is not null,revoked_at is not null
    from driver_invitations where id='revoke-race'`),
  );
  assert.ok(state === "t|f" || state === "f|t", state);
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from users where email='revoke-race@example.test'`,
      ),
    ),
    state === "t|f" ? "1" : "0",
  );
});

function legacyDriver(suffix, options = {}) {
  issue(suffix, options.state ?? "pending");
  query(
    inMigrationSchema(sql`insert into users(id,email,password_hash,name,role,is_active)
    values (${`legacy-${suffix}`},${`${suffix}@example.test`},'unchanged','Existing',
      ${options.role ?? "driver"}::user_role, ${options.active === false ? "false" : "true"}::boolean);
    insert into drivers(id,user_id,vehicle_type,vehicle_plate,business_id)
    values (${`legacy-${suffix}`},${`legacy-${suffix}`},'bike','LEGACY',${options.linked ? "biz-b" : null})`),
  );
}

test("existing unlinked driver joins without changing credentials and cannot replay", () => {
  legacyDriver("existing-driver");
  const statement = acceptExistingDriverInvitationStatement(
    "legacy-existing-driver",
    "hash-existing-driver",
  );
  assert.equal(
    query(inMigrationSchema(statement)),
    "legacy-existing-driver|legacy-existing-driver|biz-a",
  );
  assert.equal(query(inMigrationSchema(statement)), "");
  assert.equal(
    query(
      inMigrationSchema(
        sql`select password_hash from users where id='legacy-existing-driver'`,
      ),
    ),
    "unchanged",
  );
});

test("existing enrollment rejects wrong identity, inactive accounts, wrong roles and unavailable invitations", () => {
  for (const [suffix, options] of [
    ["wrong-existing", {}],
    ["inactive-existing", { active: false }],
    ["customer-existing", { role: "customer" }],
    ["linked-existing", { linked: true }],
    ["expired-existing", { state: "expired" }],
    ["revoked-existing", { state: "revoked" }],
  ]) {
    legacyDriver(suffix, options);
    const userId =
      suffix === "wrong-existing"
        ? "legacy-existing-driver"
        : `legacy-${suffix}`;
    assert.equal(
      query(
        inMigrationSchema(
          acceptExistingDriverInvitationStatement(userId, `hash-${suffix}`),
        ),
      ),
      "",
    );
    assert.equal(
      query(
        inMigrationSchema(
          sql`select accepted_at is null from driver_invitations where id=${suffix}`,
        ),
      ),
      "t",
    );
  }
});

test("simultaneous existing-driver invitations cannot join two fleets", async () => {
  legacyDriver("existing-race");
  query(
    inMigrationSchema(sql`insert into driver_invitations (id,business_id,email,token_hash,expires_at)
    values ('existing-race-other','biz-b','existing-race@example.test','hash-existing-race-other',now()+interval '1 day')`),
  );
  const results = await Promise.all([
    concurrentQuery(
      inMigrationSchema(
        acceptExistingDriverInvitationStatement(
          "legacy-existing-race",
          "hash-existing-race",
        ),
      ),
    ),
    concurrentQuery(
      inMigrationSchema(
        acceptExistingDriverInvitationStatement(
          "legacy-existing-race",
          "hash-existing-race-other",
        ),
      ),
    ),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(
    query(
      inMigrationSchema(sql`select count(*) from driver_invitations
    where email='existing-race@example.test' and accepted_at is not null`),
    ),
    "1",
  );
});

test("existing-driver HTTP handler persists enrollment through real PostgreSQL", async () => {
  legacyDriver("http-existing");
  const token = "b".repeat(43);
  const signingKey = new TextEncoder().encode(
    "isolated-integration-signing-key-32-characters",
  );
  const accessToken = await new SignJWT({ type: "access", role: "driver" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("legacy-http-existing")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
  query(
    inMigrationSchema(
      sql`update driver_invitations set token_hash=${hashInvitationToken(token)} where id='http-existing'`,
    ),
  );
  const router = createExistingDriverInvitationRouter({
    authenticate: createAuthenticationMiddleware({
      verifyToken: (value) => verifySessionToken(value, signingKey, "access"),
      findUser: async (id) => {
        const row = query(
          inMigrationSchema(
            sql`select id,role,is_active from users where id=${id}`,
          ),
        );
        if (!row) return null;
        const [userId, role, active] = row.split("|");
        return { id: userId, role, isActive: active === "t" };
      },
    }),
    accept: async (userId, secret) => {
      const row = query(
        inMigrationSchema(
          acceptExistingDriverInvitationStatement(
            userId,
            hashInvitationToken(secret),
          ),
        ),
      );
      if (!row) return undefined;
      const [resultUserId, driverId, businessId] = row.split("|");
      return { userId: resultUserId, driverId, businessId };
    },
  });
  const request = () =>
    router.request("/accept-existing", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ token }),
    });
  assert.equal(
    (await router.request("/accept-existing", { method: "POST" })).status,
    401,
  );
  assert.equal((await request()).status, 200);
  assert.equal(
    query(
      inMigrationSchema(
        sql`select business_id from drivers where id='legacy-http-existing'`,
      ),
    ),
    "biz-a",
  );
  assert.equal((await request()).status, 409);
});

test("unreconciled cross-business shipment history blocks legacy enrollment", () => {
  const initial = readFileSync(
    new URL("../drizzle/0000_graceful_the_enforcers.sql", import.meta.url),
    "utf8",
  );
  const fleet = readFileSync(
    new URL("../drizzle/0002_private_fleets.sql", import.meta.url),
    "utf8",
  );
  const invitations = readFileSync(
    new URL("../drizzle/0003_driver_invitations.sql", import.meta.url),
    "utf8",
  );
  query(
    sql.raw(`create schema history_test; set search_path to history_test, public;
    ${initial.replaceAll('"public".', '"history_test".')}
    insert into users(id,email,password_hash,name,role) values
      ('owner-a','a@test.example','test','A','business'), ('owner-b','b@test.example','test','B','business'),
      ('legacy','legacy@test.example','test','D','driver');
    insert into businesses(id,user_id,business_name) values ('a','owner-a','A'),('b','owner-b','B');
    insert into drivers(id,user_id,vehicle_type,vehicle_plate) values ('legacy','legacy','bike','LEGACY');
    insert into shipments(id,tracking_id,business_id,driver_id,description,weight_kg,pickup_address,delivery_address,price_kobo)
      values ('historic','IST-HISTORY','b','legacy','test',1,'{}','{}',100);
    ${fleet}
    ${invitations}
    insert into driver_invitations(id,business_id,email,token_hash,expires_at)
      values ('invite','a','legacy@test.example','history-hash',now()+interval '1 day');
  `),
  );
  assert.equal(
    query(sql`set search_path to history_test, public;
    ${acceptExistingDriverInvitationStatement("legacy", "history-hash")}`),
    "",
  );
  assert.equal(
    query(sql`set search_path to history_test, public;
    select business_id is null from drivers where id='legacy'`),
    "t",
  );
  assert.equal(
    query(sql`set search_path to history_test, public;
    select accepted_at is null from driver_invitations where id='invite'`),
    "t",
  );
});

function shipmentFixture(id, status = "pending") {
  query(
    inMigrationSchema(sql`insert into shipments
    (id,tracking_id,business_id,driver_id,description,weight_kg,pickup_address,delivery_address,price_kobo,status)
    values (${id},${`IST-${id}`},'biz-a',${status === "pending" ? null : "driver-a"},
      'fixture',1,'{}','{}',100,${status}::shipment_status)`),
  );
}
function transition(id, expectedStatus, status, options = {}) {
  const { actor = { userId: "owner-a", role: "business" }, ...overrides } =
    options;
  return inMigrationSchema(
    shipmentTransitionStatement(shipments, actor, {
      shipmentId: id,
      expectedStatus,
      status,
      eventId: `event-${id}`,
      message: "Status changed",
      ...overrides,
    }),
  );
}

test("shipment status, pickup time and history commit together", () => {
  shipmentFixture("atomic-pickup", "assigned");
  assert.ok(query(transition("atomic-pickup", "assigned", "picked_up")));
  assert.equal(
    query(
      inMigrationSchema(
        sql`select status,actual_pickup is not null from shipments where id='atomic-pickup'`,
      ),
    ),
    "picked_up|t",
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select status from shipment_events where shipment_id='atomic-pickup'`,
      ),
    ),
    "picked_up",
  );
});

test("history insertion failure rolls back shipment status and timestamp", () => {
  shipmentFixture("atomic-rollback", "assigned");
  query(
    inMigrationSchema(sql`insert into shipment_events(id,shipment_id,status,message)
    values ('event-atomic-rollback','atomic-rollback','assigned','Existing event')`),
  );
  assert.throws(() =>
    query(transition("atomic-rollback", "assigned", "picked_up")),
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select status,actual_pickup is null from shipments where id='atomic-rollback'`,
      ),
    ),
    "assigned|t",
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from shipment_events where shipment_id='atomic-rollback'`,
      ),
    ),
    "1",
  );
});

test("competing assignment and cancellation produce one change and one event", async () => {
  shipmentFixture("atomic-race");
  const results = await Promise.all([
    concurrentQuery(
      transition("atomic-race", "pending", "assigned", {
        driverId: "driver-a",
        eventId: "race-assigned",
      }),
    ),
    concurrentQuery(
      transition("atomic-race", "pending", "cancelled", {
        eventId: "race-cancelled",
      }),
    ),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from shipment_events where shipment_id='atomic-race'`,
      ),
    ),
    "1",
  );
  assert.equal(
    query(
      inMigrationSchema(sql`select s.status=e.status from shipments s
    join shipment_events e on e.shipment_id=s.id where s.id='atomic-race'`),
    ),
    "t",
  );
});

test("foreign businesses and unauthorized driver actions write no history", () => {
  shipmentFixture("atomic-denied", "assigned");
  for (const options of [
    { actor: { userId: "owner-b", role: "business" } },
    { actor: { userId: "rider-a", role: "driver" } },
    { actor: { userId: "existing-user", role: "customer" } },
  ]) {
    assert.equal(
      query(transition("atomic-denied", "assigned", "cancelled", options)),
      "",
    );
  }
  assert.equal(
    query(
      inMigrationSchema(
        sql`select status from shipments where id='atomic-denied'`,
      ),
    ),
    "assigned",
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from shipment_events where shipment_id='atomic-denied'`,
      ),
    ),
    "0",
  );
});

test("assigned driver may update delivery progress", () => {
  shipmentFixture("atomic-driver", "assigned");
  assert.ok(
    query(
      transition("atomic-driver", "assigned", "picked_up", {
        actor: { userId: "rider-a", role: "driver" },
      }),
    ),
  );
});

test("assignment requires an active driver from the shipment business", () => {
  shipmentFixture("atomic-fleet");
  query(
    inMigrationSchema(
      sql`update drivers set business_id='biz-a' where id='legacy-inactive-existing'`,
    ),
  );
  for (const driverId of [
    "missing",
    "legacy-linked-existing",
    "legacy-inactive-existing",
  ]) {
    assert.equal(
      query(transition("atomic-fleet", "pending", "assigned", { driverId })),
      "",
    );
  }
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from shipment_events where shipment_id='atomic-fleet'`,
      ),
    ),
    "0",
  );
});

test("retry clears prior assignment and delivery timestamps atomically", () => {
  shipmentFixture("atomic-retry", "failed");
  query(
    inMigrationSchema(
      sql`update shipments set actual_pickup=now(),actual_delivery=now() where id='atomic-retry'`,
    ),
  );
  assert.ok(query(transition("atomic-retry", "failed", "pending")));
  assert.equal(
    query(
      inMigrationSchema(sql`select driver_id is null,actual_pickup is null,actual_delivery is null
    from shipments where id='atomic-retry'`),
    ),
    "t|t|t",
  );
});

function creation(id, eventId) {
  const table = pgTable("shipments", {
    id: text("id"),
    trackingId: text("tracking_id"),
    businessId: text("business_id"),
    description: text("description"),
    weightKg: real("weight_kg"),
    status: text("status"),
    pickupAddress: jsonb("pickup_address"),
    deliveryAddress: jsonb("delivery_address"),
    priceKobo: integer("price_kobo"),
  });
  // Build the real Drizzle insert fragment; execute through the isolated psql
  // adapter rather than invoking a remote Neon HTTP connection.
  const database = drizzle(() => {
    throw new Error("Unexpected HTTP execution");
  });
  const insert = database
    .insert(table)
    .values({
      id,
      trackingId: `IST-${id}`,
      businessId: "biz-a",
      description: "fixture",
      weightKg: 1,
      pickupAddress: {},
      deliveryAddress: {},
      priceKobo: 100,
    })
    .returning();
  return inMigrationSchema(shipmentCreationStatement(insert, eventId));
}
test("shipment creation and initial history commit together", () => {
  assert.ok(query(creation("atomic-create", "event-atomic-create")));
  assert.equal(
    query(
      inMigrationSchema(
        sql`select status,message from shipment_events where shipment_id='atomic-create'`,
      ),
    ),
    "pending|Shipment created",
  );
});

test("failed initial history rolls back shipment creation", () => {
  assert.throws(
    () => query(creation("atomic-create-rollback", "event-atomic-create")),
    (error) =>
      error.stderr.includes("duplicate key value violates unique constraint"),
  );
  assert.equal(
    query(
      inMigrationSchema(
        sql`select count(*) from shipments where id='atomic-create-rollback'`,
      ),
    ),
    "0",
  );
});

test("Stripe migration preserves existing references as legacy and defaults new records to Stripe", () => {
  shipmentFixture("legacy-payment");
  const prior = JSON.parse(readFileSync(new URL("../drizzle/meta/0003_snapshot.json", import.meta.url), "utf8"));
  const legacyColumn = Object.keys(prior.tables["public.payments"].columns).find((key) => key.endsWith("_reference"));
  query(inMigrationSchema(sql`insert into payments(id,shipment_id,${sql.identifier(legacyColumn)},amount_kobo)
    values ('legacy-payment','legacy-payment','LEGACY-REF',100)`));
  query(inMigrationSchema(sql.raw(readFileSync(new URL("../drizzle/0004_stripe_checkout.sql", import.meta.url), "utf8"))));
  assert.equal(query(inMigrationSchema(sql`select provider_reference,provider from payments where id='legacy-payment'`)), "LEGACY-REF|legacy");
});

function paymentFixture(id) {
  shipmentFixture(id);
  query(inMigrationSchema(sql`insert into payments(id,shipment_id,provider_reference,amount_kobo)
    values (${id},${id},${`REF-${id}`},100)`));
}
function paymentConfirmation(id, overrides = {}) {
  return inMigrationSchema(confirmPaymentStatement({ reference: `REF-${id}`, sessionId: `cs_test_${id}`, amountKobo: 100,
    currency: "NGN", channel: "card", paidAt: "2026-11-03T00:00:00.000Z", ...overrides }));
}

test("payment and paid shipment commit together; duplicates preserve original receipt", () => {
  paymentFixture("payment-success");
  assert.equal(query(paymentConfirmation("payment-success")), "payment-success");
  assert.equal(query(paymentConfirmation("payment-success", { channel: "bank", paidAt: "2026-11-04T00:00:00.000Z" })), "payment-success");
  assert.equal(query(inMigrationSchema(sql`select p.status,p.channel,p.paid_at='2026-11-03T00:00:00Z'::timestamptz,s.is_paid
    from payments p join shipments s on s.id=p.shipment_id where p.id='payment-success'`)), "success|card|t|t");
});

test("unknown reference, wrong amount and wrong currency cannot mark a shipment paid", () => {
  paymentFixture("payment-mismatch");
  for (const overrides of [{ reference: "unknown" }, { amountKobo: 101 }, { currency: "USD" }]) {
    assert.equal(query(paymentConfirmation("payment-mismatch", overrides)), "");
  }
  assert.equal(query(inMigrationSchema(sql`select p.status,s.is_paid from payments p join shipments s on s.id=p.shipment_id
    where p.id='payment-mismatch'`)), "pending|f");
});

test("refunded payments cannot be resurrected by a late success callback", () => {
  paymentFixture("payment-refunded");
  query(inMigrationSchema(sql`update payments set status='refunded' where id='payment-refunded'`));
  assert.equal(query(paymentConfirmation("payment-refunded")), "");
  assert.equal(query(inMigrationSchema(sql`select status from payments where id='payment-refunded'`)), "refunded");
});

test("a shipment write failure rolls back payment confirmation", () => {
  paymentFixture("payment-rollback");
  query(inMigrationSchema(sql.raw(`create function reject_payment_flag() returns trigger language plpgsql as $$
    begin if new.id='payment-rollback' and new.is_paid then
      raise exception 'forced settlement failure'; end if; return new; end $$;
    create trigger reject_payment_flag before update on shipments for each row execute function reject_payment_flag();`)));
  assert.throws(() => query(paymentConfirmation("payment-rollback")),
    (error) => error.stderr.includes("forced settlement failure"));
  assert.equal(query(inMigrationSchema(sql`select p.status,p.paid_at is null,s.is_paid from payments p
    join shipments s on s.id=p.shipment_id where p.id='payment-rollback'`)), "pending|t|f");
});

test("concurrent webhook and verification confirmation converge on one paid state", async () => {
  paymentFixture("payment-race");
  const results = await Promise.all([
    concurrentQuery(paymentConfirmation("payment-race")),
    concurrentQuery(paymentConfirmation("payment-race")),
  ]);
  assert.deepEqual(results, ["payment-race", "payment-race"]);
  assert.equal(query(inMigrationSchema(sql`select p.status,s.is_paid from payments p join shipments s on s.id=p.shipment_id
    where p.id='payment-race'`)), "success|t");
});

test("signed webhook HTTP handler confirms and replays against real PostgreSQL", async () => {
  paymentFixture("payment-http");
  const secret = "isolated-webhook-integration-key";
  const router = createStripeWebhookRouter({ secret, expectedLiveMode: false,
    parseSession: (session, paidAt) => parseStripeSession(session, undefined, paidAt), confirm: async (payment) =>
    Boolean(query(inMigrationSchema(confirmPaymentStatement(payment)))) });
  const body = JSON.stringify({ id: "evt_http", object: "event", created: Math.floor(Date.now()/1000), livemode: false,
    type: "checkout.session.completed", data: { object: { id: "cs_test_payment-http", object: "checkout.session", mode: "payment",
      client_reference_id: "REF-payment-http", metadata: { reference: "REF-payment-http" }, status: "complete",
      payment_status: "paid", amount_total: 100, currency: "ngn" } } });
  const send = () => router.request("/webhook", { method: "POST", body,
    headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: body, secret }) } });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal(query(inMigrationSchema(sql`select is_paid from shipments where id='payment-http'`)), "t");
});

test("Stripe cannot settle legacy records or reuse a reference with a different session", () => {
  assert.equal(query(inMigrationSchema(confirmPaymentStatement({ reference: "LEGACY-REF", sessionId: "cs_test_legacy",
    amountKobo: 100, currency: "NGN", channel: "stripe_checkout", paidAt: "2026-11-03T00:00:00Z" }))), "");
  assert.equal(query(paymentConfirmation("payment-success", { sessionId: "cs_test_different" })), "");
});

test("session migration preserves existing users and creates revocable sessions", () => {
  query(inMigrationSchema(sql.raw(readFileSync(new URL("../drizzle/0005_auth_sessions.sql", import.meta.url), "utf8"))));
  assert.equal(query(inMigrationSchema(sql`select credential_version from users where id='owner-a'`)), "0");
});

function sessionFixture(label) {
  const user = `session-user-${label}`;
  const sid = `session-${label}`;
  query(inMigrationSchema(sql`insert into users(id,email,password_hash,name,role)
    values (${user}, ${`${user}@example.test`}, 'original-hash', 'Session test', 'customer')`));
  assert.ok(query(inMigrationSchema(openSessionStatement(sid, user, 0, 3600))));
  return { user, sid };
}
const activeSession = ({ sid, user }) => query(inMigrationSchema(activeSessionStatement(sid, user)));

test("refresh rotates once and replay revokes that session only", () => {
  const fixture = sessionFixture("replay");
  const other = "session-other-device";
  query(inMigrationSchema(openSessionStatement(other, fixture.user, 0, 3600)));
  assert.equal(query(inMigrationSchema(rotateSessionStatement(fixture.sid, fixture.user, 0))), "1|");
  assert.equal(activeSession(fixture), fixture.sid);
  assert.match(query(inMigrationSchema(rotateSessionStatement(fixture.sid, fixture.user, 0))), /^1\|.+/);
  assert.equal(activeSession(fixture), "");
  assert.equal(query(inMigrationSchema(rotateSessionStatement(fixture.sid, fixture.user, 1))), "");
  assert.equal(activeSession({ sid: other, user: fixture.user }), other);
});

test("concurrent refreshes serialize and revoke the reused generation", async () => {
  const fixture = sessionFixture("race");
  const rotate = () => concurrentQuery(inMigrationSchema(rotateSessionStatement(fixture.sid, fixture.user, 0)));
  const results = await Promise.all([rotate(), rotate()]);
  assert.equal(results.filter((result) => result === "1|").length, 1);
  assert.equal(results.filter((result) => /^1\|.+/.test(result)).length, 1);
  assert.equal(activeSession(fixture), "");
});

test("session ownership prevents cross-user checks, rotation and revocation", () => {
  const fixture = sessionFixture("ownership");
  assert.equal(activeSession({ ...fixture, user: "owner-b" }), "");
  assert.equal(query(inMigrationSchema(rotateSessionStatement(fixture.sid, "owner-b", 0))), "");
  query(inMigrationSchema(revokeSessionStatement(fixture.sid, "owner-b")));
  assert.equal(activeSession(fixture), fixture.sid);
});

test("logout revocation is idempotent and prevents access and refresh", () => {
  const fixture = sessionFixture("logout");
  for (let i = 0; i < 2; i++) query(inMigrationSchema(revokeSessionStatement(fixture.sid, fixture.user)));
  assert.equal(activeSession(fixture), "");
  assert.equal(query(inMigrationSchema(rotateSessionStatement(fixture.sid, fixture.user, 0))), "");
});

test("password changes invalidate every device and reject stale password writes and logins", () => {
  const fixture = sessionFixture("password");
  query(inMigrationSchema(openSessionStatement("session-password-other", fixture.user, 0, 3600)));
  assert.equal(query(inMigrationSchema(changePasswordStatement(fixture.user, "original-hash", "new-hash"))), fixture.user);
  assert.equal(activeSession(fixture), "");
  assert.equal(activeSession({ ...fixture, sid: "session-password-other" }), "");
  assert.equal(query(inMigrationSchema(rotateSessionStatement(fixture.sid, fixture.user, 0))), "");
  assert.equal(query(inMigrationSchema(changePasswordStatement(fixture.user, "original-hash", "stale-hash"))), "");
  assert.equal(query(inMigrationSchema(openSessionStatement("stale-login", fixture.user, 0, 3600))), "");
  assert.ok(query(inMigrationSchema(openSessionStatement("new-login", fixture.user, 1, 3600))));
});

test("deactivation and reactivation never resurrect old sessions", () => {
  const fixture = sessionFixture("inactive");
  query(inMigrationSchema(sql`update users set is_active=false where id=${fixture.user}`));
  assert.equal(activeSession(fixture), "");
  assert.equal(query(inMigrationSchema(openSessionStatement("inactive-login", fixture.user, 1, 3600))), "");
  query(inMigrationSchema(sql`update users set is_active=true where id=${fixture.user}`));
  assert.equal(activeSession(fixture), "");
  assert.equal(query(inMigrationSchema(rotateSessionStatement(fixture.sid, fixture.user, 0))), "");
  assert.ok(query(inMigrationSchema(openSessionStatement("reactivated-login", fixture.user, 2, 3600))));
});

test("expired sessions cannot refresh or authorize and user deletion removes sessions", () => {
  const fixture = sessionFixture("expiry");
  query(inMigrationSchema(sql`update auth_sessions set created_at=now()-interval '2 hours', expires_at=now()-interval '1 hour' where id=${fixture.sid}`));
  assert.equal(activeSession(fixture), "");
  assert.equal(query(inMigrationSchema(rotateSessionStatement(fixture.sid, fixture.user, 0))), "");
  query(inMigrationSchema(sql`delete from users where id=${fixture.user}`));
  assert.equal(query(inMigrationSchema(sql`select count(*) from auth_sessions where user_id=${fixture.user}`)), "0");
});

test("HTTP refresh replay and logout revoke real PostgreSQL sessions and protected access", async () => {
  const fixture = sessionFixture("http");
  const sid = "http_session_id_12345";
  query(inMigrationSchema(openSessionStatement(sid, fixture.user, 0, 3600)));
  const key = new TextEncoder().encode("real-session-test-signing-secret-32-chars");
  const sign = (type, generation = 0) => new SignJWT({ type, sid, generation, role: "customer" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(fixture.user).setIssuedAt().setExpirationTime("1h").sign(key);
  const verify = async (token, type) => {
    const payload = await verifySessionToken(token, key, type);
    requireSessionClaims(payload, type === "refresh");
    return payload;
  };
  const findUser = async () => ({ id: fixture.user, isActive: true, role: "customer" });
  const router = createSessionRouter({ frontendOrigin: "https://app.example.test", secureCookies: true,
    verify: (token) => verify(token, "refresh"), findUser, sanitize: (user) => ({ id: user.id }),
    rotate: async (_, payload) => {
      const result = await concurrentQuery(inMigrationSchema(rotateSessionStatement(payload.sid, payload.sub, payload.generation)));
      if (result !== `${payload.generation + 1}|`) return null;
      return { accessToken: await sign("access"), refreshToken: await sign("refresh", payload.generation + 1), maxAge: 3600 };
    }, revoke: async (id, user) => { query(inMigrationSchema(revokeSessionStatement(id, user))); },
  });
  router.get("/protected", createAuthenticationMiddleware({
    verifyToken: (token) => verify(token, "access"), findUser,
    isSessionActive: async (id, user) => Boolean(query(inMigrationSchema(activeSessionStatement(id, user)))),
  }), (c) => c.json({ ok: true }));
  const headers = { Origin: "https://app.example.test", Cookie: `iso_refresh_token=${await sign("refresh")}` };
  const first = await router.request("/refresh", { method: "POST", headers });
  assert.equal(first.status, 200);
  assert.match(first.headers.get("set-cookie"), /HttpOnly/);
  assert.match(first.headers.get("set-cookie"), /Secure/);
  const access = (await first.json()).data.accessToken;
  const protectedRequest = () => router.request("/protected", { headers: { Origin: headers.Origin, Authorization: `Bearer ${access}` } });
  assert.equal((await protectedRequest()).status, 200);
  assert.equal((await router.request("/refresh", { method: "POST", headers })).status, 401);
  assert.equal((await protectedRequest()).status, 401);
  query(inMigrationSchema(openSessionStatement("http_logout_id_123456", fixture.user, 0, 3600)));
  const logoutToken = await new SignJWT({ type: "refresh", sid: "http_logout_id_123456", generation: 0 })
    .setProtectedHeader({ alg: "HS256" }).setSubject(fixture.user).setIssuedAt().setExpirationTime("1h").sign(key);
  assert.equal((await router.request("/logout", { method: "POST", headers: { Origin: headers.Origin, Cookie: `iso_refresh_token=${logoutToken}` } })).status, 200);
  assert.equal(activeSession({ sid: "http_logout_id_123456", user: fixture.user }), "");
});

test("refresh racing logout cannot leave a live session", async () => {
  const fixture = sessionFixture("logout-race");
  await Promise.all([
    concurrentQuery(inMigrationSchema(rotateSessionStatement(fixture.sid, fixture.user, 0))),
    concurrentQuery(inMigrationSchema(revokeSessionStatement(fixture.sid, fixture.user))),
  ]);
  assert.equal(activeSession(fixture), "");
});

test("password change racing refresh and stale login leaves no valid old credentials", async () => {
  const fixture = sessionFixture("password-race");
  await Promise.all([
    concurrentQuery(inMigrationSchema(rotateSessionStatement(fixture.sid, fixture.user, 0))),
    concurrentQuery(inMigrationSchema(openSessionStatement("password-race-login", fixture.user, 0, 3600))),
    concurrentQuery(inMigrationSchema(changePasswordStatement(fixture.user, "original-hash", "changed-hash"))),
  ]);
  assert.equal(activeSession(fixture), "");
  assert.equal(activeSession({ ...fixture, sid: "password-race-login" }), "");
});

test("session cleanup removes old expired records and preserves active and recently expired sessions", () => {
  const fixture = sessionFixture("cleanup");
  for (const [id, expiry] of [["old-expired", "8 days"], ["recent-expired", "1 hour"]]) {
    query(inMigrationSchema(sql`insert into auth_sessions(id,user_id,credential_version,created_at,expires_at)
      values (${id}, ${fixture.user}, 0, now()-interval '10 days', now()-${expiry}::interval)`));
  }
  assert.equal(query(inMigrationSchema(purgeExpiredSessionsStatement())), "old-expired");
  assert.equal(activeSession(fixture), fixture.sid);
  assert.equal(query(inMigrationSchema(sql`select count(*) from auth_sessions where id='recent-expired'`)), "1");
});
