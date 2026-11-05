import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseShipmentPage,
  parseShipmentEventPage,
  shipmentCursor,
} from "../src/lib/shipment-page.ts";
const actor = { userId: "owner", role: "business" };
const parse = (q) => parseShipmentPage(new URLSearchParams(q), actor);

test("history cursors are bound to endpoint, shipment, account and current role", () => {
  const eventPage = (q, identity = actor, id = "shipment-a") =>
    parseShipmentEventPage(new URLSearchParams(q), identity, id);
  const scope = eventPage("").scope;
  const cursor = shipmentCursor(
    scope,
    "2026-11-05T00:00:00.123456Z",
    "event-a",
  );
  assert.equal(eventPage(`cursor=${cursor}`).position.id, "event-a");
  for (const args of [
    [`cursor=${cursor}`, actor, "shipment-b"],
    [`cursor=${cursor}`, { userId: "other", role: "business" }],
    [`cursor=${cursor}`, { ...actor, role: "customer" }],
    ["includeCompleted=false"],
    ["limit=51"],
    ["cursor=bad"],
    ["limit=2&limit=3"],
    ["page=2"],
    ["", actor, "bad/id"],
  ])
    assert.throws(() => eventPage(...args));
  assert.throws(() => parse(`cursor=${cursor}`));
  const listCursor = shipmentCursor(
    parse("").scope,
    "2026-11-05T00:00:00.123456Z",
    "event-a",
  );
  assert.throws(() => eventPage(`cursor=${listCursor}`));
});
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
