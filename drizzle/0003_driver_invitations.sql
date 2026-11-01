CREATE TABLE "driver_invitations" (
  "id" text PRIMARY KEY NOT NULL,
  "business_id" text NOT NULL CONSTRAINT "driver_invitations_business_id_businesses_id_fk" REFERENCES "businesses"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "token_hash" text NOT NULL CONSTRAINT "driver_invitations_token_hash_unique" UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "driver_invitations_terminal_state" CHECK ("accepted_at" IS NULL OR "revoked_at" IS NULL),
  CONSTRAINT "driver_invitations_expiry" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE INDEX "driver_invitations_business_created_idx" ON "driver_invitations" ("business_id", "created_at");
