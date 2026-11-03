ALTER TABLE "payments" RENAME COLUMN "paystack_reference" TO "provider_reference";
--> statement-breakpoint
ALTER TABLE "payments" RENAME CONSTRAINT "payments_paystack_reference_unique" TO "payments_provider_reference_unique";
--> statement-breakpoint
ALTER INDEX "payments_paystack_reference_idx" RENAME TO "payments_provider_reference_idx";
--> statement-breakpoint
-- Old records retain their provider identity; only new rows default to Stripe.
ALTER TABLE "payments" ADD COLUMN "provider" text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "provider" SET DEFAULT 'stripe';
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "stripe_session_id" text CONSTRAINT "payments_stripe_session_id_unique" UNIQUE;
