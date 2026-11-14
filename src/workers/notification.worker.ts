import { createMicrosoftMail } from "../services/microsoft-mail";
import { database } from "../db";
import { createDeliveryEmailProcessor } from "./delivery-email";
import { reportDependency } from "../observability/runtime";
import { env } from "@/lib/env";
import { outboxStore } from "@/db/outbox-store";
import { renderNotificationEmail } from "@/lib/notification-email";
import { createOutboxRuntime } from "./outbox-runtime";
import {
  createAccountEmailProcessor,
  startAccountEmailDispatcher,
} from "./account-email";

export function startNotificationWorker() {
  const mail = createMicrosoftMail(env, database);
  const runtime = createOutboxRuntime(
    outboxStore,
    env.UPSTASH_REDIS_URL,
    async (email) => {
      await mail.send(renderNotificationEmail(email, env.FRONTEND_URL));
    },
    reportDependency,
  );
  const closeAccountEmails = env.ACCOUNT_ACTION_SECRET
    ? startAccountEmailDispatcher(
        createAccountEmailProcessor(
          outboxStore,
          env.ACCOUNT_ACTION_SECRET,
          env.FRONTEND_URL,
          async (email) => {
            await mail.send(email);
          },
        ),
        () => reportDependency("account_email"),
      )
    : async () => {};
  if (!env.ACCOUNT_ACTION_SECRET) reportDependency("account_action");
  const closeDeliveryEmails = env.DELIVERY_CODE_SECRET
    ? startAccountEmailDispatcher(
        createDeliveryEmailProcessor(
          outboxStore,
          env.DELIVERY_CODE_SECRET,
          async (email) => {
            await mail.send(email);
          },
        ),
        () => reportDependency("delivery_email"),
      )
    : async () => {};
  return {
    close: async () => {
      await Promise.all([
        runtime.close(),
        closeAccountEmails(),
        closeDeliveryEmails(),
      ]);
    },
  };
}
