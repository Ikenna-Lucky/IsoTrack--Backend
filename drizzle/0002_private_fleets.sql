-- Repair settings columns even when the older, misdated migration was skipped.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emergency_contact" text;
--> statement-breakpoint
ALTER TABLE "drivers"
  ADD COLUMN IF NOT EXISTS "vehicle_model" text,
  ADD COLUMN IF NOT EXISTS "vehicle_color" text,
  ADD COLUMN IF NOT EXISTS "vehicle_year" text,
  ADD COLUMN IF NOT EXISTS "vehicle_insurance" text,
  ADD COLUMN IF NOT EXISTS "notification_preferences" jsonb;
--> statement-breakpoint
ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "notification_preferences" jsonb,
  ADD COLUMN IF NOT EXISTS "preferences" jsonb;
--> statement-breakpoint
-- Do not infer ownership from historic assignments: old drivers may serve
-- several businesses. Leave them unlinked until explicitly onboarded.
ALTER TABLE "drivers" ADD COLUMN "business_id" text
  CONSTRAINT "drivers_business_id_businesses_id_fk"
  REFERENCES "businesses"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_user_id_unique" ON "drivers" ("user_id");
--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_id_business_unique" UNIQUE ("id", "business_id");
--> statement-breakpoint
CREATE INDEX "drivers_business_status_idx" ON "drivers" ("business_id", "status");
--> statement-breakpoint
-- Enforce new assignments immediately while retaining legacy history. Validate
-- after an explicit legacy membership/assignment reconciliation, before release.
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_driver_business_fk"
  FOREIGN KEY ("driver_id", "business_id")
  REFERENCES "drivers" ("id", "business_id") ON DELETE RESTRICT NOT VALID;
