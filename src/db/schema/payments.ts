import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { paymentStatusEnum } from "./enums";
import { shipments } from "./shipments";

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "restrict" }),
    reference: text("provider_reference").unique(),
    provider: text("provider").default("stripe").notNull(),
    stripeSessionId: text("stripe_session_id").unique(),
    checkoutState: text("checkout_state").default("untracked").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    reviewReason: text("review_reason"),
    refundId: text("refund_id").unique(),
    refundRecordedBy: text("refund_recorded_by"),
    refundRecordedAt: timestamp("refund_recorded_at", { withTimezone: true }),
    reconcileAfter: timestamp("reconcile_after", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reconcileToken: text("reconcile_token"),
    reconcileUntil: timestamp("reconcile_until", { withTimezone: true }),
    amountKobo: integer("amount_kobo").notNull(),
    status: paymentStatusEnum("status").default("pending").notNull(),
    channel: text("channel"), // card, bank, ussd, etc.
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "payments_checkout_state_check",
      sql`${t.checkoutState} in ('untracked','creating','open','processing','expired','failed','settled','review')`,
    ),
    index("payments_reconciliation_idx")
      .on(t.reconcileAfter)
      .where(
        sql`${t.provider}='stripe' and ${t.status}='pending' and ${t.checkoutState}<>'review'`,
      ),
    index("payments_shipment_id_idx").on(t.shipmentId),
    index("payments_status_idx").on(t.status),
    index("payments_provider_reference_idx").on(t.reference),
  ],
);

export const paymentsRelations = relations(payments, ({ one }) => ({
  shipment: one(shipments, {
    fields: [payments.shipmentId],
    references: [shipments.id],
  }),
}));

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;

export const paymentCheckoutGuards = pgTable(
  "payment_checkout_guards",
  {
    shipmentId: text("shipment_id")
      .primaryKey()
      .references(() => shipments.id, { onDelete: "restrict" }),
    paymentId: text("payment_id").references(() => payments.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("payment_checkout_guards_payment_idx").on(t.paymentId)],
);

export const shipmentPaymentReceipts = pgTable("shipment_payment_receipts", {
  shipmentId: text("shipment_id")
    .primaryKey()
    .references(() => shipments.id, { onDelete: "restrict" }),
  paymentId: text("payment_id")
    .notNull()
    .unique()
    .references(() => payments.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
