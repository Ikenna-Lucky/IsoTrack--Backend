import { z } from "zod";
import { tokenDurationSeconds } from "./token-duration";
import { trustedProxyAddresses } from "./request-peer";

const tokenLifetime = z.string().refine((value) => {
  try {
    tokenDurationSeconds(value);
    return true;
  } catch {
    return false;
  }
}, "Use a positive duration (s, m, h, d), up to 365 days");

const envSchema = z
  .object({
    PORT: z.coerce.number().default(8000),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    APP_URL: z.string().url().default("http://localhost:8000"),
    FRONTEND_URL: z.string().url().default("http://localhost:3000"),
    TRUSTED_PROXY_IPS: z
      .string()
      .default("")
      .refine((value) => {
        try {
          trustedProxyAddresses(value);
          return true;
        } catch {
          return false;
        }
      }, "Use comma-separated exact proxy IP addresses, without CIDRs or wildcards"),

    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    METRICS_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{32,128}$/)
        .optional(),
    ),

    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    JWT_EXPIRES_IN: tokenLifetime.default("15m"),
    JWT_REFRESH_SECRET: z
      .string()
      .min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
    JWT_REFRESH_EXPIRES_IN: tokenLifetime.default("7d"),
    ACCOUNT_ACTION_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
    ),

    UPSTASH_REDIS_URL: z.string().min(1, "UPSTASH_REDIS_URL is required"),
    DELIVERY_CODE_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
    ),

    GMAIL_USER: z.string().email("GMAIL_USER must be a valid Gmail address"),
    GMAIL_APP_PASSWORD: z
      .string()
      .min(16, "GMAIL_APP_PASSWORD must be a 16-char App Password"),
    EMAIL_FROM: z.string().default("IsoTrack <noreply@isotrack.app>"),

    // Phase 8
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_PHONE_NUMBER: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.ACCOUNT_ACTION_SECRET) {
      let frontend: URL;
      try {
        frontend = new URL(value.FRONTEND_URL);
      } catch {
        return;
      }
      if (
        frontend.username ||
        frontend.password ||
        (frontend.protocol !== "https:" &&
          !(
            frontend.protocol === "http:" &&
            value.NODE_ENV !== "production" &&
            ["localhost", "127.0.0.1"].includes(frontend.hostname)
          ))
      ) {
        context.addIssue({
          code: "custom",
          path: ["FRONTEND_URL"],
          message:
            "Account email links require a trusted HTTPS origin (localhost HTTP in development only)",
        });
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
