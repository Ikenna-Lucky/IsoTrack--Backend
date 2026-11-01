import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { pgTable, text, PgDialect } from "drizzle-orm/pg-core";
import { shipmentAccessPredicate } from "../src/db/queries/shipment-access.ts";
import { fleetAccessPredicate } from "../src/db/queries/fleet-access.ts";
import { readFileSync } from "node:fs";
import { acceptDriverInvitationStatement } from "../src/db/queries/accept-driver-invitation.ts";

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
    input, encoding: "utf8", timeout: 120_000, stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function compile(statement) {
  const compiled = dialect.sqlToQuery(statement);
  // Only generated fixture strings are inlined for psql; application queries
  // continue to use driver-bound parameters.
  const text = compiled.sql.replace(/\$(\d+)/g, (_, index) => {
    const value = compiled.params[Number(index) - 1];
    assert.equal(typeof value, "string");
    return `'${value.replaceAll("'", "''")}'`;
  });
  return text;
}

const psqlArgs = () => ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"];

function query(statement) {
  return docker(psqlArgs(), compile(statement));
}

async function concurrentQuery(statement) {
  const process = promisify(execFile)("docker", psqlArgs(), { encoding: "utf8", timeout: 30_000 });
  process.child.stdin.end(compile(statement));
  return (await process).stdout.trim();
}

before(async () => {
  docker(["run", "--detach", "--rm", "--name", container,
    "--env", "POSTGRES_PASSWORD=isolated-test-only", image]);
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
  query(sql.raw(`
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
  `));
});

after(() => {
  if (started) docker(["stop", "--time", "1", container]);
});

for (const [role, userId] of [
  ["business", "owner-a"], ["driver", "rider-a"], ["customer", "customer-a"],
]) {
  test(`${role} can read only its own shipment`, () => {
    const predicate = shipmentAccessPredicate(shipments, { role, userId });
    assert.equal(query(sql`select id from ${shipments} where ${predicate}`), "shipment-a");
  });

  test(`${role} cannot update a foreign shipment`, () => {
    const predicate = shipmentAccessPredicate(shipments, { role, userId });
    assert.equal(query(sql`with changed as (
      update ${shipments} set status = 'cancelled'
      where id = 'shipment-b' and ${predicate} returning id
    ) select count(*) from changed`), "0");
    assert.equal(query(sql`select status from ${shipments} where id = 'shipment-b'`), "pending");
  });
}

test("unknown roles and SQL injection strings grant no access", () => {
  for (const actor of [
    { role: "admin", userId: "owner-a" },
    { role: "business", userId: "owner-a' OR true --" },
    { role: "driver", userId: "missing" },
    { role: "customer", userId: "missing" },
  ]) {
    assert.equal(query(sql`select count(*) from ${shipments}
      where ${shipmentAccessPredicate(shipments, actor)}`), "0");
  }
});

test("businesses discover only their own drivers and exclude unlinked accounts", () => {
  const drivers = pgTable("drivers", { businessId: text("business_id") });
  for (const [owner, expected] of [["owner-a", "driver-a"], ["owner-b", "driver-b"], ["missing", ""]]) {
    assert.equal(query(sql`select id from ${drivers} where ${fleetAccessPredicate(drivers.businessId, owner)}`), expected);
  }
});

test("legacy or mismatched membership cannot authorize driver access", () => {
  query(sql.raw(`insert into shipments values
    ('mismatch', 'biz-b', 'driver-a', null, 'pending'),
    ('legacy-shipment', 'biz-a', 'legacy', null, 'pending')`));
  assert.equal(query(sql`select id from ${shipments} where ${shipmentAccessPredicate(shipments, { role: "driver", userId: "rider-a" })}`), "shipment-a");
  assert.equal(query(sql`select count(*) from ${shipments} where ${shipmentAccessPredicate(shipments, { role: "driver", userId: "legacy-rider" })}`), "0");
});

test("actual migrations repair skipped settings and enforce fleet assignment constraints", () => {
  // Separate schema preserves the existing ownership fixture; no application DB.
  const initial = readFileSync(new URL("../drizzle/0000_graceful_the_enforcers.sql", import.meta.url), "utf8");
  const fleet = readFileSync(new URL("../drizzle/0002_private_fleets.sql", import.meta.url), "utf8");
  query(sql.raw(`create schema migration_test; set search_path to migration_test, public;
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
  `));
});

const inMigrationSchema = (statement) => sql`set search_path to migration_test, public; ${statement}`;
function acceptance(suffix, overrides = {}) {
  return acceptDriverInvitationStatement({
    tokenHash: `hash-${suffix}`, email: `${suffix}@example.test`,
    userId: `user-${suffix}`, driverId: `driver-${suffix}`, name: "Invited Driver",
    passwordHash: "fixture-hash", vehicleType: "bike", vehiclePlate: "TEST-123",
    ...overrides,
  });
}
function issue(suffix, state = "pending") {
  query(inMigrationSchema(sql`insert into driver_invitations
    (id,business_id,email,token_hash,created_at,expires_at,revoked_at)
    values (${suffix},'biz-a',${`${suffix}@example.test`},${`hash-${suffix}`},
      now() - interval '3 days',
      case when ${state} = 'expired' then now() - interval '1 day' else now() + interval '1 day' end,
      case when ${state} = 'revoked' then now() else null end)`));
}

test("invitation migration installs on the actual application schema", () => {
  const migration = readFileSync(new URL("../drizzle/0003_driver_invitations.sql", import.meta.url), "utf8");
  query(inMigrationSchema(sql.raw(migration)));
});

test("acceptance creates one driver membership and replay creates nothing", () => {
  issue("valid");
  assert.equal(query(inMigrationSchema(acceptance("valid"))), "user-valid|driver-valid|biz-a");
  assert.equal(query(inMigrationSchema(acceptance("valid", { userId: "replayed", driverId: "replayed" }))), "");
  assert.equal(query(inMigrationSchema(sql`select count(*) from users where email='valid@example.test'`)), "1");
  assert.equal(query(inMigrationSchema(sql`select count(*) from drivers where user_id='user-valid' and business_id='biz-a'`)), "1");
  assert.equal(query(inMigrationSchema(sql`select accepted_at is not null from driver_invitations where id='valid'`)), "t");
});

test("expired, revoked, unknown and wrong-recipient invitations create no accounts", () => {
  issue("expired", "expired");
  issue("revoked", "revoked");
  issue("wrong");
  for (const [suffix, overrides] of [
    ["expired", {}], ["revoked", {}], ["unknown", {}],
    ["wrong", { email: "someone-else@example.test" }],
  ]) {
    assert.equal(query(inMigrationSchema(acceptance(suffix, overrides))), "");
    assert.equal(query(inMigrationSchema(sql`select count(*) from users where id=${`user-${suffix}`}`)), "0");
  }
});

test("existing accounts are never overwritten and the invitation stays pending", () => {
  issue("existing");
  query(inMigrationSchema(sql`insert into users(id,email,password_hash,name,role)
    values ('existing-user','existing@example.test','original-hash','Original','customer')`));
  assert.equal(query(inMigrationSchema(acceptance("existing"))), "");
  assert.equal(query(inMigrationSchema(sql`select password_hash,role from users where id='existing-user'`)), "original-hash|customer");
  assert.equal(query(inMigrationSchema(sql`select accepted_at is null from driver_invitations where id='existing'`)), "t");
});

test("a driver insert failure rolls back user creation and invitation consumption", () => {
  issue("rollback");
  assert.throws(() => query(inMigrationSchema(acceptance("rollback", { driverId: "driver-a" }))));
  assert.equal(query(inMigrationSchema(sql`select count(*) from users where id='user-rollback'`)), "0");
  assert.equal(query(inMigrationSchema(sql`select accepted_at is null from driver_invitations where id='rollback'`)), "t");
});

test("concurrent acceptance of one invitation succeeds exactly once", async () => {
  issue("race");
  const results = await Promise.all([
    concurrentQuery(inMigrationSchema(acceptance("race", { userId: "race-one", driverId: "race-one" }))),
    concurrentQuery(inMigrationSchema(acceptance("race", { userId: "race-two", driverId: "race-two" }))),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(query(inMigrationSchema(sql`select count(*) from users where email='race@example.test'`)), "1");
  assert.equal(query(inMigrationSchema(sql`select count(*) from drivers where user_id in ('race-one','race-two')`)), "1");
});

test("two invitations for the same email cannot create two accounts or fleets", async () => {
  issue("shared");
  query(inMigrationSchema(sql`insert into driver_invitations (id,business_id,email,token_hash,expires_at)
    values ('shared-other','biz-b','shared@example.test','hash-shared-other',now()+interval '1 day')`));
  const results = await Promise.all([
    concurrentQuery(inMigrationSchema(acceptance("shared"))),
    concurrentQuery(inMigrationSchema(acceptance("shared", {
      tokenHash: "hash-shared-other", userId: "shared-other-user", driverId: "shared-other-driver",
    }))),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(query(inMigrationSchema(sql`select count(*) from users where email='shared@example.test'`)), "1");
  assert.equal(query(inMigrationSchema(sql`select count(*) from driver_invitations
    where email='shared@example.test' and accepted_at is not null`)), "1");
});

test("revocation competing with acceptance leaves exactly one terminal state", async () => {
  issue("revoke-race");
  await Promise.all([
    concurrentQuery(inMigrationSchema(acceptance("revoke-race"))),
    concurrentQuery(inMigrationSchema(sql`update driver_invitations set revoked_at=now()
      where id='revoke-race' and accepted_at is null and revoked_at is null returning id`)),
  ]);
  const state = query(inMigrationSchema(sql`select accepted_at is not null,revoked_at is not null
    from driver_invitations where id='revoke-race'`));
  assert.ok(state === "t|f" || state === "f|t", state);
  assert.equal(query(inMigrationSchema(sql`select count(*) from users where email='revoke-race@example.test'`)), state === "t|f" ? "1" : "0");
});
