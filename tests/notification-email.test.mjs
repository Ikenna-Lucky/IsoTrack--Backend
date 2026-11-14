import assert from "node:assert/strict";
import { test } from "node:test";
import { renderNotificationEmail } from "../src/lib/notification-email.ts";
import { outboxJobId } from "../src/workers/outbox-processor.ts";

test("notification email escapes untrusted content and uses configured tracking origin", () => {
  const input = {
    eventId: "event:one",
    to: "test@example.test",
    name: '<script>"bad"</script>',
    title: "Shipment assigned",
    trackingId: "IST-<&",
    message: "<img src=x>&'",
  };
  const email = renderNotificationEmail(input, "https://product.example.test");
  assert.ok(email.html.includes("&lt;script&gt;"));
  assert.equal(email.html.includes("<img"), false);
  assert.ok(
    email.html.includes("https://product.example.test/customer/track?id="),
  );
  assert.equal(email.html.includes("localhost"), false);
  assert.equal(
    email.messageId,
    renderNotificationEmail(input, "https://product.example.test").messageId,
  );
  assert.notEqual(
    email.messageId,
    renderNotificationEmail(
      { ...input, eventId: "event:two" },
      "https://product.example.test",
    ).messageId,
  );
  assert.match(outboxJobId("event:one"), /^[a-f0-9]{64}$/);
});


test("Business shipment emails link to the Business workspace", () => {
  const email = renderNotificationEmail({ eventId: "business-event", recipientRole: "business", to: "owner@example.test", name: "Owner", title: "Shipment created", trackingId: "IST-1", message: "Created" }, "https://product.example.test");
  assert.ok(email.text.includes("https://product.example.test/business/shipments"));
  assert.equal(email.html.includes("/customer/"), false);
});
