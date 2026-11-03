import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePaystackVerification } from "../src/lib/paystack-payload.ts";

const data = { reference: "REF", status: "success", amount: 100, currency: "NGN",
  channel: "card", paid_at: "2026-11-03T00:00:00.000Z" };
test("successful verification requires the expected reference and complete receipt", () => {
  const parsed = parsePaystackVerification({ status: true, data }, "REF");
  assert.equal(parsed.paid, true);
  assert.equal(parsed.charge.amountKobo, 100);
  for (const raw of [{ status: false, data }, { status: true, data: { ...data, reference: "OTHER" } },
    { status: true, data: { ...data, paid_at: null } }, { status: true, data: { ...data, amount: "100" } }, {}]) {
    assert.equal(parsePaystackVerification(raw, "REF"), null);
  }
});
test("pending and unsuccessful responses do not require a paid receipt or trigger settlement", () => {
  for (const status of ["pending", "failed", "abandoned", "reversed"]) {
    const parsed = parsePaystackVerification({ status: true, data: { reference: "REF", status, channel: null } }, "REF");
    assert.equal(parsed.paid, false);
    assert.equal(parsed.charge, null);
  }
});
