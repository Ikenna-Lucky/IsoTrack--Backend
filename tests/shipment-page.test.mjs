import assert from "node:assert/strict";
import { test } from "node:test";
import { parseShipmentPage, shipmentCursor } from "../src/lib/shipment-page.ts";
const actor = { userId: "owner", role: "business" };
const parse = (q) => parseShipmentPage(new URLSearchParams(q), actor);
test("pagination defaults and bounded decimal limits", () => {
  assert.equal(parse("").limit, 20);
  assert.equal(parse("limit=50").limit, 50);
  for (const q of [
    "limit=0",
    "limit=51",
    "limit=-1",
    "limit=1.5",
    "limit=01",
    "limit=NaN",
    "limit=1e1",
    "limit=",
    "limit=1&limit=2",
    "page=1",
    "pageSize=20",
    "unknown=1",
    "includeCompleted=false",
  ])
    assert.throws(
      () => parse(q),
      (e) => e.code === "INVALID_PAGINATION",
    );
});
test("cursor retains microseconds, binds identity/filter and rejects malformed payloads", () => {
  const page = parse("");
  const time = "2026-11-01T12:00:00.123456Z";
  const cursor = shipmentCursor(page.scope, time, "shipment-a");
  assert.equal(parse(`cursor=${cursor}`).position.time, time);
  assert.throws(() =>
    parseShipmentPage(new URLSearchParams({ cursor }), {
      userId: "other",
      role: "business",
    }),
  );
  for (const value of [
    "!",
    "",
    cursor + "=",
    "A".repeat(1025),
    Buffer.from(
      JSON.stringify({
        v: 1,
        scope: page.scope,
        time: "2026-02-30T12:00:00.000000Z",
        id: "a",
      }),
    ).toString("base64url"),
  ])
    assert.throws(() =>
      parseShipmentPage(new URLSearchParams({ cursor: value }), actor),
    );
  const driver = { userId: "rider", role: "driver" };
  const active = parseShipmentPage(new URLSearchParams(), driver);
  const driverCursor = shipmentCursor(active.scope, time, "a");
  assert.throws(() =>
    parseShipmentPage(
      new URLSearchParams({ cursor: driverCursor, includeCompleted: "true" }),
      driver,
    ),
  );
});
