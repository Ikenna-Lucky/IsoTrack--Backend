import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { authenticate, requireRole } from "@/middleware/auth";
import {
  findShipmentById,
  findShipmentsByBusiness,
  findShipmentsByDriver,
  findShipmentsByCustomer,
  createShipment,
  updateShipment,
  addShipmentEvent,
} from "@/db/queries/shipments";
import { db } from "@/db";
import { businesses, drivers } from "@/db/schema";
import { findUserByEmail } from "@/db/queries/users";
import { success, paginated, error } from "@/lib/response";
import { enqueueShipmentEmail } from "@/lib/queue";
import type { ShipmentMilestone } from "@/lib/email";
import { createInAppNotification, shipmentNotificationContent } from "@/lib/notifications";

export const shipmentsRouter = new Hono();

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["assigned", "cancelled"],
  assigned: ["picked_up", "failed", "cancelled"],
  picked_up: ["in_transit"],
  in_transit: ["out_for_delivery"], 
  out_for_delivery: ["delivered", "failed"],
  delivered: [],
  failed: ["pending"],
  cancelled: [],
};

const EMAIL_MILESTONES = new Set<string>([
  "assigned",
  "picked_up",
  "delivered",
  "failed",
]);

function formatNgn(kobo: number): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
  }).format(kobo / 100);
}

function addrStr(addr: unknown): string {
  const a = addr as { street?: string; city?: string } | null;
  if (!a) return "";
  return [a.street, a.city].filter(Boolean).join(", ");
}

const createShipmentSchema = z.object({
  description: z.string().min(1),
  weightKg: z.number().positive(),
  pickupAddress: z.object({
    street: z.string(),
    city: z.string(),
    state: z.string().default("Lagos"),
  }),
  deliveryAddress: z.object({
    street: z.string(),
    city: z.string(),
    state: z.string().default("Lagos"),
  }),
  customerId: z.string().optional(),
  customerEmail: z.string().email().optional(),
  scheduledPickup: z.string().datetime().optional(),
  priceKobo: z.number().int().positive(),
});

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

shipmentsRouter.post(
  "/",
  requireRole("business"),
  zValidator("json", createShipmentSchema),
  async (c) => {
    const userId = c.get("userId");
    const body = c.req.valid("json");

    const [biz] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.userId, userId))
      .limit(1);
    if (!biz) return error(c, "Business profile not found", 404);

    // ── Resolve customer by email if provided ─────────────────────────────────
    // Businesses know their customer's email; we look them up and link the
    // account so the shipment appears on the customer's dashboard automatically.
    let resolvedCustomerId: string | null = body.customerId ?? null;
    if (!resolvedCustomerId && body.customerEmail) {
      const customerUser = await findUserByEmail(body.customerEmail);
      if (customerUser && customerUser.role === "customer") {
        resolvedCustomerId = customerUser.id;
      }
      // If the email doesn't match a registered customer account we silently
      // skip — the shipment is still created; the customer can track by ID.
    }

    const trackingId = `IST-${nanoid(8).toUpperCase()}`;

    const shipment = await createShipment({
      id: nanoid(),
      trackingId,
      businessId: biz.id,
      customerId: resolvedCustomerId,
      description: body.description,
      weightKg: body.weightKg,
      pickupAddress: body.pickupAddress,
      deliveryAddress: body.deliveryAddress,
      priceKobo: body.priceKobo,
      scheduledPickup: body.scheduledPickup
        ? new Date(body.scheduledPickup)
        : null,
    });

    await addShipmentEvent({
      id: nanoid(),
      shipmentId: shipment.id,
      status: "pending",
      message: "Shipment created",
    });

    return c.json(
      { success: true, data: shipment, message: "Shipment created" },
      201,
    );
  },
);

shipmentsRouter.get("/:id", async (c) => {
  const shipment = await findShipmentById(c.req.param("id"));
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

    const shipment = await findShipmentById(id);
    if (!shipment) return error(c, "Shipment not found", 404);

    const allowed = VALID_TRANSITIONS[shipment.status] ?? [];
    if (!allowed.includes(newStatus)) {
      return error(
        c,
        `Cannot transition from "${shipment.status}" to "${newStatus}"`,
        422,
      );
    }

    const timestamps: Record<string, Date> = {};
    if (newStatus === "picked_up") timestamps.actualPickup = new Date();
    if (newStatus === "delivered") timestamps.actualDelivery = new Date();

    const updated = await updateShipment(id, {
      status: newStatus,
      ...timestamps,
    });
    if (!updated) return error(c, "Failed to update shipment", 500);

    await addShipmentEvent({
      id: nanoid(),
      shipmentId: id,
      status: newStatus,
      message: note ?? "",
    });

    // Write in-app notification for the business owner
    const bizRow = await db
      .select({ userId: businesses.userId })
      .from(businesses)
      .where(eq(businesses.id, shipment.businessId))
      .limit(1);
    if (bizRow[0]) {
      const { title, message } = shipmentNotificationContent(
        newStatus,
        shipment.trackingId ?? "",
        shipment.driver?.user?.name,
      );
      void createInAppNotification({
        userId:   bizRow[0].userId,
        title,
        message,
        metadata: { trackingId: shipment.trackingId ?? "", status: newStatus },
      });
    }

    if (EMAIL_MILESTONES.has(newStatus) && shipment.customer?.email) {
      enqueueShipmentEmail(newStatus as ShipmentMilestone, {
        trackingId: shipment.trackingId ?? "",
        customerName: shipment.customer.name,
        customerEmail: shipment.customer.email,
        pickup: addrStr(shipment.pickupAddress),
        delivery: addrStr(shipment.deliveryAddress),
        packageType: shipment.description,
        amount: formatNgn(shipment.priceKobo),
        driverName: shipment.driver?.user?.name ?? "",
      }).catch((err: Error) =>
        console.error("[Queue] enqueue failed:", err.message),
      );
    }

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

    const shipment = await findShipmentById(id);
    if (!shipment) return error(c, "Shipment not found", 404);
    if (shipment.status !== "pending")
      return error(c, "Only pending shipments can be assigned", 422);

    const [driver] = await db
      .select()
      .from(drivers)
      .where(eq(drivers.id, driverId))
      .limit(1);
    if (!driver) return error(c, "Driver not found", 404);

    const updated = await updateShipment(id, { driverId, status: "assigned" });

    await addShipmentEvent({
      id: nanoid(),
      shipmentId: id,
      status: "assigned",
      message: `Assigned to driver ${driverId}`,
    });

    // Write in-app notification for the business owner
    const bizRowAssign = await db
      .select({ userId: businesses.userId })
      .from(businesses)
      .where(eq(businesses.id, shipment.businessId))
      .limit(1);
    if (bizRowAssign[0]) {
      const { title, message } = shipmentNotificationContent(
        "assigned",
        shipment.trackingId ?? "",
        driver.vehiclePlate,
      );
      void createInAppNotification({
        userId:   bizRowAssign[0].userId,
        title,
        message,
        metadata: { trackingId: shipment.trackingId ?? "", status: "assigned" },
      });
    }

    if (shipment.customer?.email) {
      enqueueShipmentEmail("assigned", {
        trackingId: shipment.trackingId ?? "",
        customerName: shipment.customer.name,
        customerEmail: shipment.customer.email,
        pickup: addrStr(shipment.pickupAddress),
        delivery: addrStr(shipment.deliveryAddress),
        packageType: shipment.description,
        amount: formatNgn(shipment.priceKobo),
        driverName: driver.vehiclePlate ?? "",
      }).catch((err: Error) =>
        console.error("[Queue] enqueue failed:", err.message),
      );
    }

    return success(c, { data: updated, message: "Driver assigned" });
  },
);

shipmentsRouter.delete("/:id", requireRole("business"), async (c) => {
  const shipment = await findShipmentById(c.req.param("id")!);
  if (!shipment) return error(c, "Shipment not found", 404);

  const allowed = VALID_TRANSITIONS[shipment.status] ?? [];
  if (!allowed.includes("cancelled")) {
    return error(
      c,
      `Shipments with status "${shipment.status}" cannot be cancelled`,
      422,
    );
  }

  await updateShipment(shipment.id, { status: "cancelled" });
  await addShipmentEvent({
    id: nanoid(),
    shipmentId: shipment.id,
    status: "cancelled",
    message: "Shipment cancelled by business",
  });

  return success(c, { data: null, message: "Shipment cancelled" });
});
