import { z } from "zod";
import { tokenDurationSeconds } from "./token-duration";
import { trustedProxyAddresses } from "./request-peer";
import { assertPreviewIsolation } from "./preview-isolation";
import { validateStripeConfig } from "./stripe-config";
import { databaseConfig } from "./database-config";
import {
  microsoftMailFields,
  microsoftMailConfig,
} from "./microsoft-mail-config";

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
    DEPLOYMENT_ENV: z.enum(["local", "preview", "production"]).default("local"),
    RELEASE_SHA: z
      .string()
      .regex(/^(unknown|[a-f0-9]{40})$/)
      .default("unknown"),
    NOTIFICATION_WORKERS_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    PREVIEW_DATABASE_HOST: z.string().optional(),
    LIVE_DATABASE_HOST: z.string().optional(),
    PREVIEW_REDIS_HOST: z.string().optional(),
    LIVE_REDIS_HOST: z.string().optional(),
    PREVIEW_APP_HOST: z.string().optional(),
    LIVE_APP_HOST: z.string().optional(),
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
    DATABASE_DRIVER: z.enum(["neon", "postgres"]).default("neon"),
    RETENTION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
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

    ...microsoftMailFields,

    // Phase 8
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_PHONE_NUMBER: z.string().optional(),
    STRIPE_MODE: z.enum(["disabled", "sandbox"]).default("disabled"),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.NOTIFICATION_WORKERS_ENABLED) {
      try {
        microsoftMailConfig(value);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["MICROSOFT_MAIL_CLIENT_ID"],
          message:
            "Email workers require Outlook client ID, sender address and cache encryption key. Authorize the sender before enabling workers.",
        });
      }
    }
    try {
      databaseConfig(value);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message:
          "Invalid database adapter or target; local postgres requires a loopback URL and non-production environment",
      });
    }
    try {
      validateStripeConfig(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_MODE"],
        message:
          error instanceof Error
            ? error.message
            : "Invalid Stripe configuration",
      });
    }
    if (value.DEPLOYMENT_ENV === "preview") {
      try {
        assertPreviewIsolation(value);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["DEPLOYMENT_ENV"],
          message:
            "Preview requires isolated hosts, a release SHA, disabled notification workers/retention and valid sandbox payment settings",
        });
      }
    }
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
