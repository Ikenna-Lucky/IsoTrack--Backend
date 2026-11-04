import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { compare, hash } from "bcryptjs";
import { randomInt, randomUUID } from "node:crypto";
import { currentRequestId } from "../observability/telemetry.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { User } from "@/db/schema";
import type { OutboxStore } from "../workers/outbox-processor.ts";
import type { RegistrationInput } from "../db/queries/register-account.ts";
import { reserveAuthBudget } from "../db/queries/auth-budget.ts";
import {
  authPairKey,
  authPeerKey,
  type AuthOperation,
} from "../lib/auth-budget.ts";
import { sanitizeUser } from "../lib/public-user.ts";
import { accountPassword } from "./account-actions.ts";

const email = z.string().trim().toLowerCase().email().max(254);
const loginSchema = z
  .object({
    email,
    password: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 512),
  })
  .strict();
const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    email,
    password: accountPassword,
    role: z.enum(["business", "driver", "customer"]),
    phone: z
      .string()
      .regex(/^\+?[1-9]\d{6,14}$/)
      .optional()
      .or(z.literal("")),
    businessName: z.string().trim().min(2).max(100).optional(),
    vehicleType: z.enum(["bike", "car", "van", "truck"]).optional(),
    vehiclePlate: z.string().min(3).max(20).optional(),
  })
  .strict();
// Public dummy hash at the same cost as newly stored credentials; never hash a
// fresh dummy password per attempt or claim HTTP timing is exactly constant.
const DUMMY_HASH =
  "$2b$12$Lj1olQnAnStsbNPNatg0Q.WzP4xey46Gi2FBtz7M.ToD3qASc6SKi";
export interface AuthSecurityEvent {
  event: "authentication_attempt";
  operation: AuthOperation;
  outcome:
    | "invalid_input"
    | "invalid_credentials"
    | "denied"
    | "throttled"
    | "success"
    | "unavailable"
    | "conflict";
  requestId: string;
}
interface Dependencies {
  store: OutboxStore;
  secret: string;
  peer: (context: Context) => string | undefined;
  findUser: (email: string) => Promise<User | null>;
  register: (
    input: RegistrationInput,
    passwordHash: string,
  ) => Promise<User | null>;
  openSession: (user: User) => Promise<{
    accessToken: string;
    refreshToken: string;
    maxAge: number;
  } | null>;
  secureCookies: boolean;
  record: (event: AuthSecurityEvent) => void;
}

export function createPublicAuthRouter(deps: Dependencies) {
  const app = new Hono();
  for (const operation of ["login", "register"] as const) {
    const path = `/${operation}`;
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    });
    app.use(
      path,
      bodyLimit({
        maxSize: operation === "login" ? 4096 : 8192,
        onError: (c) =>
          c.json(
            {
              success: false,
              error: "BODY_TOO_LARGE",
              message: "Request body too large",
            },
            413,
          ),
      }),
    );
    app.post(path, async (c) => {
      const requestId = currentRequestId() ?? randomUUID();
      c.header("X-Request-Id", requestId);
      const record = (outcome: AuthSecurityEvent["outcome"]) =>
        deps.record({
          event: "authentication_attempt",
          operation,
          outcome,
          requestId,
        });
      const fail = (
        status: 400 | 401 | 403 | 409 | 429 | 503,
        code: string,
        message: string,
      ) => c.json({ success: false, error: code, message }, status);
      const throttled = (seconds: number) => {
        record("throttled");
        c.header("Retry-After", String(seconds));
        return fail(429, "RATE_LIMITED", "Too many attempts. Try again later.");
      };
      const reserve = async (key: string, limit: number, seconds: number) => {
        const result = (
          await deps.store.execute(reserveAuthBudget(key, limit, seconds))
        )[0];
        if (
          !result ||
          typeof result.allowed !== "boolean" ||
          !Number.isFinite(Number(result.retryAfter))
        )
          throw new Error("Invalid throttle result");
        return {
          allowed: result.allowed,
          retryAfter: Math.max(1, Math.ceil(Number(result.retryAfter))),
        };
      };
      try {
        const peer = deps.peer(c);
        if (!peer) throw new Error("Missing trusted peer");
        const peerBudget = await reserve(
          authPeerKey(deps.secret, operation, peer),
          operation === "login" ? 30 : 5,
          operation === "login" ? 600 : 3600,
        );
        if (!peerBudget.allowed) return throttled(peerBudget.retryAfter);
        let input: unknown;
        if (
          c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
        ) {
          record("invalid_input");
          return fail(400, "BAD_REQUEST", "Invalid request");
        }
        try {
          input = await c.req.json();
        } catch {
          record("invalid_input");
          return fail(400, "BAD_REQUEST", "Invalid request");
        }
        if (operation === "login") {
          const parsed = loginSchema.safeParse(input);
          if (!parsed.success) {
            record("invalid_input");
            return fail(400, "BAD_REQUEST", "Invalid request");
          }
          const pairBudget = await reserve(
            authPairKey(deps.secret, peer, parsed.data.email),
            10,
            600,
          );
          if (!pairBudget.allowed) return throttled(pairBudget.retryAfter);
          const started = performance.now();
          const user = await deps.findUser(parsed.data.email);
          const matches = await compare(
            parsed.data.password,
            user?.passwordHash ?? DUMMY_HASH,
          );
          // Equalize short paths without claiming statistical timing resistance.
          await delay(
            Math.max(0, 350 + randomInt(0, 51) - (performance.now() - started)),
          );
          if (!user || !matches || !user.isActive) {
            record("invalid_credentials");
            return fail(401, "UNAUTHORIZED", "Invalid email or password");
          }
          const session = await deps.openSession(user);
          if (!session) {
            record("invalid_credentials");
            return fail(401, "UNAUTHORIZED", "Invalid email or password");
          }
          setCookie(c, "iso_refresh_token", session.refreshToken, {
            httpOnly: true,
            secure: deps.secureCookies,
            sameSite: deps.secureCookies ? "None" : "Lax",
            path: "/",
            maxAge: session.maxAge,
          });
          record("success");
          return c.json({
            success: true,
            message: "Logged in successfully",
            data: {
              user: sanitizeUser(user),
              accessToken: session.accessToken,
            },
          });
        }
        const parsed = registerSchema.safeParse(input);
        if (!parsed.success) {
          record("invalid_input");
          return fail(400, "BAD_REQUEST", "Invalid request");
        }
        if (parsed.data.role === "driver") {
          record("denied");
          return fail(
            403,
            "FORBIDDEN",
            "Drivers must join through a business invitation",
          );
        }
        const passwordHash = await hash(parsed.data.password, 12);
        const user = await deps.register(parsed.data, passwordHash);
        if (!user) {
          record("conflict");
          return fail(
            409,
            "CONFLICT",
            "Unable to create account. Sign in or recover your account.",
          );
        }
        const session = await deps.openSession(user);
        if (!session) {
          record("unavailable");
          return fail(
            503,
            "SERVICE_UNAVAILABLE",
            "Please sign in to complete account access.",
          );
        }
        setCookie(c, "iso_refresh_token", session.refreshToken, {
          httpOnly: true,
          secure: deps.secureCookies,
          sameSite: deps.secureCookies ? "None" : "Lax",
          path: "/",
          maxAge: session.maxAge,
        });
        record("success");
        return c.json(
          {
            success: true,
            message: "Account created successfully",
            data: {
              user: sanitizeUser(user),
              accessToken: session.accessToken,
            },
          },
          201,
        );
      } catch {
        record("unavailable");
        return fail(
          503,
          "SERVICE_UNAVAILABLE",
          "Authentication is temporarily unavailable. Try again later.",
        );
      }
    });
  }
  return app;
}
