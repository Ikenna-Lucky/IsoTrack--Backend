import { z } from "zod";

const envSchema = z.object({
  // App
  PORT: z.coerce.number().default(8000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_URL: z.string().url().default("http://localhost:8000"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),

  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Auth
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

  // Redis
  UPSTASH_REDIS_URL: z.string().min(1, "UPSTASH_REDIS_URL is required"),

  // Email
  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required"),
  EMAIL_FROM: z.string().default("IsoTrack <noreply@isotrack.app>"),

  // SMS
  TWILIO_ACCOUNT_SID: z.string().min(1, "TWILIO_ACCOUNT_SID is required"),
  TWILIO_AUTH_TOKEN: z.string().min(1, "TWILIO_AUTH_TOKEN is required"),
  TWILIO_PHONE_NUMBER: z.string().min(1, "TWILIO_PHONE_NUMBER is required"),

  // Paystack
  PAYSTACK_SECRET_KEY: z.string().min(1, "PAYSTACK_SECRET_KEY is required"),
  PAYSTACK_PUBLIC_KEY: z.string().min(1, "PAYSTACK_PUBLIC_KEY is required"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
