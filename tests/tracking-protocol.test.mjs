import assert from "node:assert/strict";
import { test } from "node:test";
import {
  locationSchema,
  trackingIdSchema,
  isFreshLocation,
} from "../src/socket/protocol.ts";

test("tracking identifiers and GPS coordinates reject malformed and spoofed fields", () => {
  const valid = {
    trackingId: "IST-test",
    lat: 6.5,
    lng: 3.4,
    timestamp: 100000,
  };
  assert.equal(locationSchema.safeParse(valid).success, true);
  for (const change of [
    { lat: NaN },
    { lat: Infinity },
    { lat: 91 },
    { lng: -181 },
    { speed: -1 },
    { speed: 101 },
    { heading: 360 },
    { timestamp: 1.5 },
    { driverId: "other" },
    { userId: "other" },
    { role: "driver" },
  ]) {
    assert.equal(
      locationSchema.safeParse({ ...valid, ...change }).success,
      false,
    );
  }
  for (const id of ["", "a".repeat(65), "shipment:*", "../secret", " room"])
    assert.equal(trackingIdSchema.safeParse(id).success, false);
});

test("location timestamps have explicit stale and future bounds", () => {
  assert.equal(isFreshLocation({ timestamp: 70_000 }, 100_000), true);
  assert.equal(isFreshLocation({ timestamp: 105_000 }, 100_000), true);
  assert.equal(isFreshLocation({ timestamp: 69_999 }, 100_000), false);
  assert.equal(isFreshLocation({ timestamp: 105_001 }, 100_000), false);
});
