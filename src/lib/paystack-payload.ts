import { z } from "zod";

export const paystackTransactionSchema = z.object({
  reference: z.string().min(1).max(200),
  status: z.string().min(1).max(40),
  amount: z.number().int().positive().max(2_147_483_647),
  currency: z.string().length(3),
  channel: z.string().min(1).max(50),
  paid_at: z.string().datetime({ offset: true }).nullable(),
});

export interface SuccessfulPayment {
  reference: string;
  amountKobo: number;
  currency: string;
  channel: string;
  paidAt: string;
}

export function parsePaystackVerification(raw: unknown, reference: string) {
  const envelope = z.object({ status: z.literal(true), data: z.object({
    reference: z.string(), status: z.string().min(1).max(40),
    channel: z.string().nullable().optional(),
  }).passthrough() }).safeParse(raw);
  if (!envelope.success || envelope.data.data.reference !== reference) return null;
  const data = envelope.data.data;
  if (data.status !== "success") {
    return { paid: false, reference, channel: data.channel ?? null, status: data.status, charge: null };
  }
  const charge = paystackTransactionSchema.safeParse(data);
  if (!charge.success || !charge.data.paid_at) return null;
  return { paid: true, reference, channel: charge.data.channel, status: data.status,
    charge: { reference, amountKobo: charge.data.amount, currency: charge.data.currency,
      channel: charge.data.channel, paidAt: charge.data.paid_at } satisfies SuccessfulPayment };
}
