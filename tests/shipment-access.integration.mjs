import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { pgTable, text, PgDialect } from "drizzle-orm/pg-core";
import { shipmentAccessPredicate } from "../src/db/queries/shipment-access.ts";

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
    create table drivers (id text primary key, user_id text not null);
    create table shipments (
      id text primary key, business_id text references businesses(id),
      driver_id text references drivers(id), customer_id text, status text
    );
    insert into businesses values ('biz-a', 'owner-a'), ('biz-b', 'owner-b');
    insert into drivers values ('driver-a', 'rider-a'), ('driver-b', 'rider-b');
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
