import { z } from "zod";
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );
export const microsoftMailFields = {
  MICROSOFT_MAIL_CLIENT_ID: optional(z.string().uuid()),
  MICROSOFT_MAIL_SENDER: optional(z.string().email()),
  MICROSOFT_MAIL_CACHE_KEY: optional(z.string().regex(/^[a-f0-9]{64}$/i)),
};
export function microsoftMailConfig(value: Record<string, unknown>) {
  return z
    .object({
      MICROSOFT_MAIL_CLIENT_ID: z.string().uuid(),
      MICROSOFT_MAIL_SENDER: z.string().email(),
      MICROSOFT_MAIL_CACHE_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
    })
    .parse(value);
}
