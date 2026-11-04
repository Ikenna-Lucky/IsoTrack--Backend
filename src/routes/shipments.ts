import { createShipmentCreationRouter } from "./idempotent-writes";
import { writes } from "@/services/writes";
import { createShipmentCommandRouter } from "./shipment-commands";
import { writeStore } from "@/services/write-store";
import { Hono } from "hono";
import { createDeliveryRouter } from "./delivery";
import { env } from "@/lib/env";

import { createShipmentListRouter } from "./shipment-list";
import { authenticate, requireRole } from "@/middleware/auth";
import { findShipmentById } from "@/db/queries/shipments";

import { success, error } from "@/lib/response";

export const shipmentsRouter = new Hono();

shipmentsRouter.use("*", authenticate);

shipmentsRouter.route("/", createShipmentListRouter(writeStore));

shipmentsRouter.route(
  "/",
  createShipmentCreationRouter({ authorize: requireRole("business"), writes }),
);

shipmentsRouter.get("/:id", async (c) => {
  const shipment = await findShipmentById(c.req.param("id"), {
    userId: c.get("userId"),
    role: c.get("userRole"),
  });
  if (!shipment) return error(c, "Shipment not found", 404);
  return success(c, { data: shipment });
});

shipmentsRouter.route("/", createShipmentCommandRouter(writeStore));
shipmentsRouter.route(
  "/",
  createDeliveryRouter(writeStore, env.DELIVERY_CODE_SECRET),
);
