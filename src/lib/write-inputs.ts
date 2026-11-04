import { z } from "zod";

const address = z
  .object({
    street: z.string().min(1).max(300),
    city: z.string().min(1).max(100),
    state: z.string().min(1).max(100).default("Lagos"),
  })
  .strict();
export const shipmentInput = z
  .object({
    recipientEmail: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase())
      .optional(),
    description: z.string().trim().min(1).max(2000),
    weightKg: z.number().finite().positive().max(1000000),
    pickupAddress: address,
    deliveryAddress: address,
    customerId: z.string().min(1).max(64).optional(),
    customerEmail: z
      .string()
      .trim()
      .email()
      .transform((value) => value.toLowerCase())
      .optional(),
    scheduledPickup: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString())
      .optional(),
    priceKobo: z.number().int().positive().max(2147483647),
  })
  .strict();
export const checkoutInput = z
  .object({ shipmentId: z.string().min(1).max(64) })
  .strict();
export type ShipmentInput = z.infer<typeof shipmentInput>;
export type CheckoutInput = z.infer<typeof checkoutInput>;
