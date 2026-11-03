import { z } from "zod";

export interface SuccessfulPayment {
  reference: string;
  sessionId: string;
  amountKobo: number;
  currency: string;
  channel: string;
  paidAt: string;
}

const sessionSchema = z.object({
  id: z.string().startsWith("cs_"), object: z.literal("checkout.session"),
  mode: z.literal("payment"), client_reference_id: z.string().min(1),
  metadata: z.object({ reference: z.string().min(1) }),
  status: z.enum(["open", "complete", "expired"]),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
  amount_total: z.number().int().positive().max(2_147_483_647), currency: z.string().length(3),
});

export function parseStripeSession(raw: unknown, reference?: string, paidAt = new Date().toISOString()) {
  const parsed = sessionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const session = parsed.data;
  if (session.metadata.reference !== session.client_reference_id ||
      (reference !== undefined && session.client_reference_id !== reference)) return null;
  const paid = session.payment_status === "paid" && session.status === "complete";
  return { paid, reference: session.client_reference_id, sessionId: session.id,
    status: session.payment_status, channel: "stripe_checkout", charge: paid ? {
      reference: session.client_reference_id, sessionId: session.id, amountKobo: session.amount_total,
      currency: session.currency.toUpperCase(), channel: "stripe_checkout", paidAt,
    } satisfies SuccessfulPayment : null };
}
