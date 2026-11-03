import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStripeSession } from "../src/lib/stripe-payload.ts";

const session = {
  id: "cs_test_example",
  object: "checkout.session",
  mode: "payment",
  client_reference_id: "REF",
  metadata: { reference: "REF" },
  status: "complete",
  payment_status: "paid",
  amount_total: 100,
  currency: "ngn",
};
test("paid Stripe sessions require bound reference, complete status and amount", () => {
  const verified = parseStripeSession(session, "REF");
  assert.equal(verified.charge.currency, "NGN");
  assert.equal(verified.charge.sessionId, session.id);
  for (const invalid of [
    { ...session, amount_total: "100" },
    { ...session, metadata: { reference: "OTHER" } },
    {},
  ]) {
    assert.equal(parseStripeSession(invalid, "REF"), null);
  }
  assert.equal(parseStripeSession(session, "OTHER"), null);
});
test("unpaid and incomplete Checkout sessions never confirm a payment", () => {
  assert.equal(
    parseStripeSession({ ...session, payment_status: "unpaid" }).charge,
    null,
  );
  assert.equal(parseStripeSession({ ...session, status: "open" }).charge, null);
});
