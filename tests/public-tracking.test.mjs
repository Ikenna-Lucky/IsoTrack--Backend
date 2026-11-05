import assert from "node:assert/strict";
import { test } from "node:test";
import { publicTrackingView } from "../src/lib/public-tracking.ts";

test("public tracking strips private fields and replaces free-text event messages", () => {
  const view = publicTrackingView({
    id: "internal-shipment",
    trackingId: "IST-test",
    status: "assigned",
    scheduledPickup: null,
    estimatedDelivery: null,
    actualDelivery: null,
    description: "secret package",
    pickupAddress: { street: "secret street" },
    deliveryAddress: { email: "secret email" },
    currentLocation: { lat: 6.5, lng: 3.4, timestamp: 123 },
    driver: {
      id: "internal-driver",
      currentLocation: { lat: 7, lng: 4 },
      user: { name: "Driver", passwordHash: "secret" },
    },
    events: [
      {
        status: "assigned",
        createdAt: "2026-11-05T00:00:00Z",
        message: "secret message",
        location: { lat: 7, lng: 4 },
        id: "internal-event",
      },
    ],
  });
  assert.equal(view.currentLocation, undefined);
  assert.equal(view.driver, undefined);
  assert.equal(view.pickupAddress, undefined);
  assert.equal(view.deliveryAddress, undefined);
  assert.equal(view.description, undefined);
  assert.deepEqual(view.events, [
    {
      status: "assigned",
      createdAt: "2026-11-05T00:00:00Z",
      message: "Driver assigned",
    },
  ]);
  assert.equal(view.trackingId, "IST-test");
  assert.equal(view.status, "assigned");
  assert.equal(JSON.stringify(view).includes("internal-"), false);
  assert.equal(JSON.stringify(view).includes("secret"), false);
});
