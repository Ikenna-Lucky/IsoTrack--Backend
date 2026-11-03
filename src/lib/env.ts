import { z } from "zod";
import { tokenDurationSeconds } from "./token-duration";

const tokenLifetime = z.string().refine((value) => {
  try { tokenDurationSeconds(value); return true; } catch { return false; }
}, "Use a positive duration (s, m, h, d), up to 365 days");

const envSchema = z.object({
  PORT: z.coerce.number().default(8000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:8000"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: tokenLifetime.default("15m"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_REFRESH_EXPIRES_IN: tokenLifetime.default("7d"),

  UPSTASH_REDIS_URL: z.string().min(1, "UPSTASH_REDIS_URL is required"),

  GMAIL_USER: z.string().email("GMAIL_USER must be a valid Gmail address"),
  GMAIL_APP_PASSWORD: z.string().min(16, "GMAIL_APP_PASSWORD must be a 16-char App Password"),
  EMAIL_FROM: z.string().default("IsoTrack <noreply@isotrack.app>"),

  // Phase 8
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
