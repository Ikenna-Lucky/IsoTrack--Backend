import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { paymentStatusEnum } from "./enums";
import { shipments } from "./shipments";

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "restrict" }),
    paystackReference: text("paystack_reference").unique(),
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
    index("payments_shipment_id_idx").on(t.shipmentId),
    index("payments_status_idx").on(t.status),
    index("payments_paystack_reference_idx").on(t.paystackReference),
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
