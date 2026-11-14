import { z } from "zod";
import { EmailRetryAfter } from "./email-retry.ts";
const emailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(998),
  text: z.string(),
  html: z.string().optional(),
  messageId: z.string().max(200).optional(),
});
export type GraphEmail = z.infer<typeof emailSchema>;
export function createGraphEmailSender(
  token: (forceRefresh?: boolean) => Promise<string>,
  request: typeof fetch = fetch,
  endpoint = "https://graph.microsoft.com/v1.0/me/sendMail",
) {
  let retryAt = 0;
  return async (input: GraphEmail) => {
    const email = emailSchema.parse(input);
    if (Date.now() < retryAt) throw new EmailRetryAfter(retryAt - Date.now());
    const body = JSON.stringify({
      message: {
        subject: email.subject,
        body: {
          contentType: email.html ? "HTML" : "Text",
          content: email.html ?? email.text,
        },
        toRecipients: [{ emailAddress: { address: email.to } }],
        ...(email.messageId
          ? {
              internetMessageHeaders: [
                { name: "x-isotrack-message-id", value: email.messageId },
              ],
            }
          : {}),
      },
      saveToSentItems: true,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        const accessToken = await token(attempt === 1);
        response = await request(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body,
        });
      } catch {
        throw new Error("Microsoft email request could not be confirmed.");
      }
      // Graph returns no message body. Acceptance is not proof of inbox delivery.
      if (response.status === 202) return;
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        continue;
      }
      if (response.status === 429 || response.status === 503) {
        const raw = response.headers.get("Retry-After") ?? "";
        const seconds = /^\d+$/.test(raw)
          ? Number(raw)
          : (Date.parse(raw) - Date.now()) / 1000;
        retryAt =
          Date.now() +
          Math.max(
            1000,
            Math.min(
              3600000,
              Number.isFinite(seconds) ? seconds * 1000 : 60000,
            ),
          );
      }
      await response.body?.cancel();
      if (retryAt > Date.now()) throw new EmailRetryAfter(retryAt - Date.now());
      throw new Error(
        "Microsoft email request rejected (HTTP " + response.status + ").",
      );
    }
  };
}
