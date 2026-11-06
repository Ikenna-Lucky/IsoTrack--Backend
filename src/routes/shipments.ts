import { createShipmentCreationRouter } from "./idempotent-writes";
import { writes } from "@/services/writes";
import { createShipmentCommandRouter } from "./shipment-commands";
import { writeStore } from "@/services/write-store";
import { Hono } from "hono";
import { createShipmentExceptionRouter } from "./shipment-exceptions";
import { createDeliveryRouter } from "./delivery";
import { env } from "@/lib/env";

import { createShipmentListRouter } from "./shipment-list";
import { authenticate, requireRole } from "@/middleware/auth";
import { createShipmentDetailRouter } from "./shipment-reads";
import { apiProtection } from "../services/api-protection";

export const shipmentsRouter = new Hono();

shipmentsRouter.use(
  "*",
  apiProtection("shipments", "peer"),
  authenticate,
  apiProtection("shipments", "account"),
);

shipmentsRouter.route("/", createShipmentListRouter(writeStore));

shipmentsRouter.route(
  "/",
  createShipmentCreationRouter({ authorize: requireRole("business"), writes }),
);

shipmentsRouter.route("/", createShipmentDetailRouter(writeStore));

shipmentsRouter.route("/", createShipmentCommandRouter(writeStore));
shipmentsRouter.route("/", createShipmentExceptionRouter(writeStore));
shipmentsRouter.route(
  "/",
  createDeliveryRouter(writeStore, env.DELIVERY_CODE_SECRET),
);
