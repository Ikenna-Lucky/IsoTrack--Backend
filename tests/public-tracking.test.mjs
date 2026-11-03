import assert from "node:assert/strict";
import { test } from "node:test";
import { publicTrackingView } from "../src/lib/public-tracking.ts";

test("public tracking omits live shipment and driver GPS and internal identities", () => {
  const view = publicTrackingView({
    id: "internal-shipment",
    trackingId: "IST-test",
    status: "assigned",
    currentLocation: { lat: 6.5, lng: 3.4, timestamp: 123 },
    driver: {
      id: "internal-driver",
      currentLocation: { lat: 7, lng: 4 },
      user: { name: "Driver", passwordHash: "secret" },
    },
    events: [],
  });
  assert.equal(view.currentLocation, null);
  assert.equal(view.driver.currentLocation, null);
  assert.equal(view.trackingId, "IST-test");
  assert.equal(view.status, "assigned");
  assert.equal(JSON.stringify(view).includes("internal-"), false);
  assert.equal(JSON.stringify(view).includes("secret"), false);
});
