import { createShipmentCreationRouter } from "./idempotent-writes";
import { writes } from "@/services/writes";
import { createShipmentCommandRouter } from "./shipment-commands";
import { writeStore } from "@/services/write-store";
import { Hono } from "hono";

import { eq } from "drizzle-orm";
import { authenticate, requireRole } from "@/middleware/auth";
import {
  findShipmentById,
  findShipmentsByBusiness,
  findShipmentsByDriver,
  findShipmentsByCustomer,
} from "@/db/queries/shipments";
import { db } from "@/db";
import { businesses, drivers } from "@/db/schema";

import { success, paginated, error } from "@/lib/response";

export const shipmentsRouter = new Hono();

shipmentsRouter.use("*", authenticate);

shipmentsRouter.get("/", async (c) => {
  const role = c.get("userRole");
  const userId = c.get("userId");
  const { page, pageSize } = c.req.query();

  if (role === "business") {
    const [biz] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.userId, userId))
      .limit(1);
    if (!biz) return error(c, "Business profile not found", 404);
    const result = await findShipmentsByBusiness(biz.id, {
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
    return paginated(c, result);
  }

  if (role === "driver") {
    const [driver] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.userId, userId))
      .limit(1);
    if (!driver) return error(c, "Driver profile not found", 404);
    const includeCompleted = c.req.query("includeCompleted") === "true";
    const data = await findShipmentsByDriver(driver.id, { includeCompleted });
    return success(c, { data });
  }

  if (role === "customer") {
    const data = await findShipmentsByCustomer(userId);
    return success(c, { data });
  }

  return error(c, "Unauthorized role", 403);
});

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
