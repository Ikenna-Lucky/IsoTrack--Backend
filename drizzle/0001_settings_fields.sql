-- Migration: add settings fields to users and drivers
-- Generated for IsoTrack settings page features

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "emergency_contact" text;

ALTER TABLE "drivers"
  ADD COLUMN IF NOT EXISTS "vehicle_model"           text,
  ADD COLUMN IF NOT EXISTS "vehicle_color"              text,
  ADD COLUMN IF NOT EXISTS "vehicle_year"               text,
  ADD COLUMN IF NOT EXISTS "vehicle_insurance"          text,
  ADD COLUMN IF NOT EXISTS "notification_preferences"   jsonb;
