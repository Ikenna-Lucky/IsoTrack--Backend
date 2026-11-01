import assert from "node:assert/strict";
import { test } from "node:test";
import { shipmentContactColumns } from "../src/db/queries/user-columns.ts";

test("shipment contacts expose only approved contact fields", () => {
  assert.deepEqual(Object.keys(shipmentContactColumns).sort(), [
    "avatar", "email", "id", "name", "phone",
  ]);
  assert.ok(Object.values(shipmentContactColumns).every((value) => value === true));
  for (const field of ["passwordHash", "emergencyContact", "isActive", "isEmailVerified"]) {
    assert.equal(Object.hasOwn(shipmentContactColumns, field), false);
  }
});
