import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createBusinessAnalyticsRouter } from "../src/routes/shipment-reads.ts";

test("analytics refuses unsafe totals instead of rounding database money", async () => {
  for (const total of ["9007199254740992", "9007199254740993"]) {
    const app = new Hono();
    app.onError((_, c) => c.json({ error: "SERVER_FAILURE" }, 500));
    app.use("*", async (c, next) => {
      c.set("userId", "owner");
      c.set("userRole", "business");
      await next();
    });
    app.route(
      "/business",
      createBusinessAnalyticsRouter({
        execute: async () => [{ totalShipments: "1", totalRevenueKobo: total }],
      }),
    );
    assert.equal((await app.request("/business/analytics")).status, 500);
  }
});
