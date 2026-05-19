CREATE TYPE "public"."driver_status" AS ENUM('available', 'on_delivery', 'offline');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('email', 'sms', 'push');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'success', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('pending', 'assigned', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('business', 'driver', 'customer');--> statement-breakpoint
CREATE TYPE "public"."vehicle_type" AS ENUM('bike', 'car', 'van', 'truck');--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"phone" text,
	"avatar" text,
	"is_email_verified" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"business_name" text NOT NULL,
	"logo" text,
	"address" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"vehicle_type" "vehicle_type" NOT NULL,
	"vehicle_plate" text NOT NULL,
	"status" "driver_status" DEFAULT 'offline' NOT NULL,
	"current_location" jsonb,
	"rating" real DEFAULT 5 NOT NULL,
	"total_deliveries" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"tracking_id" text NOT NULL,
	"status" "shipment_status" DEFAULT 'pending' NOT NULL,
	"business_id" text NOT NULL,
	"driver_id" text,
	"customer_id" text,
	"description" text NOT NULL,
	"weight_kg" real NOT NULL,
	"dimensions" jsonb,
	"pickup_address" jsonb NOT NULL,
	"delivery_address" jsonb NOT NULL,
	"current_location" jsonb,
	"scheduled_pickup" timestamp with time zone,
	"actual_pickup" timestamp with time zone,
	"estimated_delivery" timestamp with time zone,
	"actual_delivery" timestamp with time zone,
	"price_kobo" integer NOT NULL,
	"is_paid" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_tracking_id_unique" UNIQUE("tracking_id")
);
--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"status" "shipment_status" NOT NULL,
	"message" text NOT NULL,
	"location" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"paystack_reference" text,
	"amount_kobo" integer NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"channel" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_paystack_reference_unique" UNIQUE("paystack_reference")
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "drivers_user_id_idx" ON "drivers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "drivers_status_idx" ON "drivers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "drivers_vehicle_type_idx" ON "drivers" USING btree ("vehicle_type");--> statement-breakpoint
CREATE INDEX "shipments_tracking_id_idx" ON "shipments" USING btree ("tracking_id");--> statement-breakpoint
CREATE INDEX "shipments_business_id_idx" ON "shipments" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "shipments_driver_id_idx" ON "shipments" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "shipments_customer_id_idx" ON "shipments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "shipments_status_idx" ON "shipments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shipments_created_at_idx" ON "shipments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "shipment_events_shipment_id_idx" ON "shipment_events" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_events_created_at_idx" ON "shipment_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_id_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_is_read_idx" ON "notifications" USING btree ("is_read");--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "payments_shipment_id_idx" ON "payments" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payments_paystack_reference_idx" ON "payments" USING btree ("paystack_reference");