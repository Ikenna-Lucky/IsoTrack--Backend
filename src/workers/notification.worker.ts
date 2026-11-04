import nodemailer from "nodemailer";
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
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
  });
  const runtime = createOutboxRuntime(
    outboxStore,
    env.UPSTASH_REDIS_URL,
    async (email) => {
      await transporter.sendMail({
        from: env.EMAIL_FROM,
        ...renderNotificationEmail(email, env.FRONTEND_URL),
      });
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
            await transporter.sendMail({ from: env.EMAIL_FROM, ...email });
          },
        ),
        () => reportDependency("account_email"),
      )
    : async () => {};
  if (!env.ACCOUNT_ACTION_SECRET) reportDependency("account_action");
  return {
    close: async () => {
      await Promise.all([runtime.close(), closeAccountEmails()]);
      transporter.close();
    },
  };
}
