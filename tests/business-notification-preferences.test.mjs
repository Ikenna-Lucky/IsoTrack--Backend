import assert from "node:assert/strict";
import { test } from "node:test";
import { businessShipmentEmailEnabled } from "../src/lib/business-notification-preferences.ts";
import { createOutboxProcessor } from "../src/workers/outbox-processor.ts";
import { PgDialect } from "drizzle-orm/pg-core";

test("business email choices match documented defaults and distinguish unsupported events", () => {
  for (const status of ["pending", "assigned", "out_for_delivery", "delivered", "failed"]) assert.equal(businessShipmentEmailEnabled(status, null), true);
  assert.equal(businessShipmentEmailEnabled("picked_up", null), false);
  assert.equal(businessShipmentEmailEnabled("picked_up", {pickedUp:{email:true,sms:false}}), true);
  assert.equal(businessShipmentEmailEnabled("delivered", {delivered:{email:false,sms:true}}), false);
  for (const status of ["paid", "cancelled", "in_transit", "return_requested", "weeklyReport"]) assert.equal(businessShipmentEmailEnabled(status, {}), false);
});

test("queued owner emails are skipped after opt-out while customer emails remain independent", async () => {
  const dialect = new PgDialect();
  for (const role of ["business", "customer"]) {
    const statements = [];
    const sent = [];
    const context = {name:"Review User", email:"review@example.test", recipientRole:role, businessPreferences:{delivered:{email:false}}, kind:"shipment_status", channel:"email", payload:{trackingId:"IST-REVIEW",status:"delivered",amountKobo:100}};
    const process = createOutboxProcessor({execute:async (statement) => {
      const query = dialect.sqlToQuery(statement); statements.push(query);
      return query.sql.startsWith("select") ? [context] : [{id:"event"}];
    }}, async (email) => {sent.push(email);});
    await process("event");
    assert.equal(sent.length, role === "business" ? 0 : 1);
    assert.ok(statements.at(-1).params.includes(role === "business" ? "skipped" : "delivered"));
  }
});
