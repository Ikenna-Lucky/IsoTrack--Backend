import { env } from "../src/lib/env";
import { database } from "../src/db";
import { createMicrosoftMail } from "../src/services/microsoft-mail";
async function main() {
  if (env.NOTIFICATION_WORKERS_ENABLED)
    throw new Error(
      "Disable notification workers during sender authorization.",
    );
  console.log(
    "Authorize only the Outlook mailbox configured in MICROSOFT_MAIL_SENDER. This does not send email.",
  );
  await createMicrosoftMail(env, database).authorize((message) =>
    console.log(message),
  );
  console.log(
    "Outlook sender authorization saved encrypted in the configured database.",
  );
}
main()
  .catch(() => {
    console.error(
      "Outlook authorization failed. Check configuration, database migration and sender account. Provider error details omitted.",
    );
    process.exitCode = 1;
  })
  .finally(() => database.close());
