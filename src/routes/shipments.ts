import { createShipmentCreationRouter } from "./idempotent-writes";
import { writes } from "@/services/writes";
import { shipmentTransitions } from "@/db/queries/shipment-access";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import { authenticate, requireRole } from "@/middleware/auth";
import {
  findShipmentById,
  findShipmentsByBusiness,
  findShipmentsByDriver,
  findShipmentsByCustomer,
  transitionShipment,
} from "@/db/queries/shipments";
import { db } from "@/db";
import { businesses, drivers } from "@/db/schema";

import { success, paginated, error } from "@/lib/response";

export const shipmentsRouter = new Hono();

const VALID_TRANSITIONS = shipmentTransitions;

const updateStatusSchema = z.object({
  status: z.enum([
    "pending",
    "assigned",
    "picked_up",
    "in_transit",
    "out_for_delivery",
    "delivered",
    "failed",
    "cancelled",
  ]),
  note: z.string().optional(),
});

const assignDriverSchema = z.object({ driverId: z.string() });

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

shipmentsRouter.patch(
  "/:id/status",
  requireRole("business", "driver"),
  zValidator("json", updateStatusSchema),
  async (c) => {
    const id = c.req.param("id")!;
    const { status: newStatus, note } = c.req.valid("json");

    const shipment = await findShipmentById(id, {
      userId: c.get("userId"),
      role: c.get("userRole"),
    });
    if (!shipment) return error(c, "Shipment not found", 404);

    if (newStatus === "assigned") {
      return error(
        c,
        "Use the driver assignment endpoint to assign a shipment",
        422,
      );
    }
    if (
      c.get("userRole") === "driver" &&
      ["pending", "cancelled"].includes(newStatus)
    ) {
      return error(c, "Only the business can retry or cancel a shipment", 403);
    }

    const allowed = VALID_TRANSITIONS[shipment.status] ?? [];
    if (!allowed.includes(newStatus)) {
      return error(
        c,
        `Cannot transition from "${shipment.status}" to "${newStatus}"`,
        422,
      );
    }

    const updated = await transitionShipment(
      { userId: c.get("userId"), role: c.get("userRole") },
      {
        shipmentId: id,
        expectedStatus: shipment.status,
        status: newStatus,
        eventId: nanoid(),
        message: note ?? "",
      },
    );
    if (!updated)
      return error(c, "Shipment changed; reload before trying again", 409);

    return success(c, { data: updated, message: "Status updated" });
  },
);

shipmentsRouter.patch(
  "/:id/assign",
  requireRole("business"),
  zValidator("json", assignDriverSchema),
  async (c) => {
    const id = c.req.param("id")!;
    const { driverId } = c.req.valid("json");

    const shipment = await findShipmentById(id, {
      userId: c.get("userId"),
      role: c.get("userRole"),
    });
    if (!shipment) return error(c, "Shipment not found", 404);
    if (shipment.status !== "pending")
      return error(c, "Only pending shipments can be assigned", 422);

    const [driver] = await db
      .select()
      .from(drivers)
      .where(
        and(
          eq(drivers.id, driverId),
          eq(drivers.businessId, shipment.businessId),
        ),
      )
      .limit(1);
    if (!driver) return error(c, "Driver not found", 404);

    const updated = await transitionShipment(
      { userId: c.get("userId"), role: c.get("userRole") },
      {
        shipmentId: id,
        expectedStatus: "pending",
        status: "assigned",
        driverId,
        eventId: nanoid(),
        message: `Assigned to driver ${driverId}`,
      },
    );
    if (!updated)
      return error(
        c,
        "Shipment or driver changed; reload before trying again",
        409,
      );

    return success(c, { data: updated, message: "Driver assigned" });
  },
);

shipmentsRouter.delete("/:id", requireRole("business"), async (c) => {
  const shipment = await findShipmentById(c.req.param("id")!, {
    userId: c.get("userId"),
    role: c.get("userRole"),
  });
  if (!shipment) return error(c, "Shipment not found", 404);

  const allowed = VALID_TRANSITIONS[shipment.status] ?? [];
  if (!allowed.includes("cancelled")) {
    return error(
      c,
      `Shipments with status "${shipment.status}" cannot be cancelled`,
      422,
    );
  }

  const updated = await transitionShipment(
    { userId: c.get("userId"), role: c.get("userRole") },
    {
      shipmentId: shipment.id,
      expectedStatus: shipment.status,
      status: "cancelled",
      eventId: nanoid(),
      message: "Shipment cancelled by business",
    },
  );
  if (!updated)
    return error(c, "Shipment changed; reload before trying again", 409);
  return success(c, { data: null, message: "Shipment cancelled" });
});
