import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { driverShipmentNotificationEnabled } from "../src/lib/driver-notification-preferences.ts";
import { createOutboxProcessor } from "../src/workers/outbox-processor.ts";
import { renderNotificationEmail } from "../src/lib/notification-email.ts";

test("driver defaults apply only to supported events and channels remain independent", () => {
  for (const status of ["assigned", "delivered", "failed"])
    for (const channel of ["in_app", "email"])
      assert.equal(
        driverShipmentNotificationEnabled(status, channel, null),
        true,
      );
  assert.equal(
    driverShipmentNotificationEnabled("assigned", "in_app", {
      newDelivery: { push: false, email: true },
    }),
    false,
  );
  assert.equal(
    driverShipmentNotificationEnabled("assigned", "email", {
      newDelivery: { push: false, email: true },
    }),
    true,
  );
  for (const status of [
    "pending",
    "picked_up",
    "paid",
    "return_requested",
    "return_in_transit",
    "return_received",
    "toString",
  ])
    assert.equal(driverShipmentNotificationEnabled(status, "email", {}), false);
});
test("the worker skips opted-out driver inbox and email candidates without sending", async () => {
  for (const channel of ["in_app", "email"]) {
    const statements = [];
    const sent = [];
    const dialect = new PgDialect();
    const context = {
      name: "Driver",
      email: "driver@example.test",
      recipientRole: "driver",
      driverPreferences: { newDelivery: { push: false, email: false } },
      kind: "shipment_status",
      channel,
      payload: { trackingId: "IST-TEST", status: "assigned", amountKobo: 100 },
    };
    const process = createOutboxProcessor(
      {
        execute: async (statement) => {
          const query = dialect.sqlToQuery(statement);
          statements.push(query);
          return query.sql.startsWith("select") ? [context] : [{ id: "event" }];
        },
      },
      async (email) => sent.push(email),
    );
    await process("event");
    assert.equal(sent.length, 0);
    assert.ok(statements.at(-1).params.includes("skipped"));
  }
});
test("driver email links to Deliveries instead of the customer workspace", () => {
  const email = renderNotificationEmail(
    {
      eventId: "event",
      recipientRole: "driver",
      to: "driver@example.test",
      name: "Driver",
      trackingId: "IST-TEST",
      title: "Assigned",
      message: "Assigned",
    },
    "https://app.example.test",
  );
  assert.ok(email.text.includes("/driver/deliveries"));
  assert.equal(email.html.includes("/customer/"), false);
});
