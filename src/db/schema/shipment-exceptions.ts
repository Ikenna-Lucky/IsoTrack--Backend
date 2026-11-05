import {
  pgTable,
  text,
  integer,
  timestamp,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { shipments } from "./shipments";
import { shipmentEvents } from "./shipment-events";
export const shipmentExceptions = pgTable(
  "shipment_exceptions",
  {
    id: text("id")
      .primaryKey()
      .references(() => shipmentEvents.id, { onDelete: "cascade" }),
    shipmentId: text("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    reason: text("reason"),
    note: text("note").notNull(),
    version: integer("version").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("shipment_exceptions_version_unique").on(t.shipmentId, t.version),
    check(
      "shipment_exceptions_action_check",
      sql`${t.action} in ('fail','retry','return_request','return_start','return_receive','cancel_failed')`,
    ),
    check(
      "shipment_exceptions_reason_check",
      sql`${t.reason} in ('recipient_unavailable','recipient_refused','address_incorrect','recipient_code_unavailable','package_damaged','vehicle_issue','other')`,
    ),
    check("shipment_exceptions_note_check", sql`length(${t.note})<=1000`),
    check("shipment_exceptions_version_check", sql`${t.version}>0`),
    check(
      "shipment_exceptions_attempt_number_check",
      sql`${t.attemptNumber} between 1 and 3`,
    ),
  ],
);
