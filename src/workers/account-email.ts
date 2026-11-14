import { randomUUID } from "node:crypto";
import { z } from "zod";
import { emailRetrySeconds } from "../lib/email-retry.ts";
import type { OutboxStore } from "./outbox-processor.ts";
import { actionToken, actionHash } from "../lib/account-action-token.ts";
import {
  claimAccountEmails,
  accountEmailContext,
  finishAccountEmail,
} from "../db/queries/account-actions.ts";

export interface AccountEmail {
  to: string;
  subject: string;
  text: string;
  messageId: string;
}
const contextSchema = z.object({
  email: z.string().email(),
  purpose: z.enum(["reset_password", "verify_email", "password_changed"]),
  tokenHash: z.string().nullable(),
});
export function renderAccountEmail(
  id: string,
  purpose: "reset_password" | "verify_email" | "password_changed",
  email: string,
  key: string,
  frontend: string,
): AccountEmail {
  const base = new URL(frontend);
  if (
    base.protocol !== "https:" &&
    !(
      base.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(base.hostname)
    )
  )
    throw new Error("Account links require HTTPS");
  if (base.username || base.password)
    throw new Error("Account link credentials forbidden");
  const url = new URL(
    purpose === "reset_password" ? "/reset-password" : "/verify-email",
    base.origin,
  );
  if (purpose !== "password_changed")
    url.hash = new URLSearchParams({
      token: actionToken(id, purpose, key),
    }).toString();
  return {
    to: email,
    subject:
      purpose === "password_changed"
        ? "Your IsoTrack password was changed"
        : purpose === "reset_password"
          ? "Reset your IsoTrack password"
          : "Verify your IsoTrack email",
    text:
      purpose === "password_changed"
        ? "Your IsoTrack password was reset. All existing sessions have been invalidated. If you did not make this change, request another password reset from the IsoTrack sign-in page and contact the account administrator."
        : `${purpose === "reset_password" ? "Reset your password within 30 minutes" : "Verify your email within 24 hours"}:\n${url.href}\n\nIf you did not request this, you can ignore this email.`,
    messageId: `<account-${id}@isotrack.invalid>`,
  };
}

export function createAccountEmailProcessor(
  store: OutboxStore,
  key: string,
  frontend: string,
  send: (email: AccountEmail) => Promise<void>,
) {
  return async () => {
    const lease = randomUUID();
    const rows = await store.execute(claimAccountEmails(lease));
    // Limit concurrent sends; completion remains fenced if a lease expires.
    await Promise.all(
      rows.map(async (row) => {
        const id = String(row.id);
        try {
          const value = (
            await store.execute(accountEmailContext(id, lease))
          )[0];
          if (!value) {
            await store.execute(finishAccountEmail(id, lease, "skipped"));
            return;
          }
          const context = contextSchema.parse(value);
          if (
            context.purpose !== "password_changed" &&
            actionHash(actionToken(id, context.purpose, key)) !==
              context.tokenHash
          ) {
            await store.execute(finishAccountEmail(id, lease, "skipped"));
            return;
          }
          await send(
            renderAccountEmail(
              id,
              context.purpose,
              context.email,
              key,
              frontend,
            ),
          );
          if (
            !(await store.execute(finishAccountEmail(id, lease, "sent"))).length
          )
            throw new Error("Account email lease lost");
        } catch (cause) {
          await store.execute(
            finishAccountEmail(id, lease, "failed", emailRetrySeconds(cause)),
          );
        }
      }),
    );
  };
}

export function startAccountEmailDispatcher(
  processBatch: () => Promise<void>,
  report: () => void,
) {
  let stopped = false;
  let running = false;
  let pending = Promise.resolve();
  const tick = () => {
    if (stopped || running) return;
    running = true;
    pending = processBatch()
      .catch(report)
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
