import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { pgTable, text, PgDialect } from "drizzle-orm/pg-core";
import { shipmentAccessPredicate } from "../src/db/queries/shipment-access.ts";
import { fleetAccessPredicate } from "../src/db/queries/fleet-access.ts";
import { readFileSync } from "node:fs";

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

function query(statement) {
  const compiled = dialect.sqlToQuery(statement);
  // Only generated fixture strings are inlined for psql; application queries
  // continue to use driver-bound parameters.
  const text = compiled.sql.replace(/\$(\d+)/g, (_, index) => {
    const value = compiled.params[Number(index) - 1];
    assert.equal(typeof value, "string");
    return `'${value.replaceAll("'", "''")}'`;
  });
  return docker(["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], text);
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
