# Outlook email through Microsoft Graph

IsoTrack now sends account verification/recovery, password-change notices,
recipient delivery codes and shipment alerts using Microsoft Graph HTTPS. The
SMTP/Nodemailer/Gmail transport and unused Resend SDK were removed. Historical
SMTP evidence in older documents describes the previous implementation.

The current integration supports a personal Microsoft mailbox (Outlook.com,
Hotmail or Live), using the `consumers` authority and delegated `Mail.Send`.
It does not implement Microsoft 365 application-only authorization. Recipients
may use any email provider and never authorize their mailbox to IsoTrack.

## Configure later, without changing code

No sender address, hosted URL or Microsoft credential is needed to run the unit
tests or the local HTTP fixtures. Keep `NOTIFICATION_WORKERS_ENABLED=false` until
you intend to dispatch queued work.

When the sender is ready:

1. Register a Microsoft identity application that supports personal Microsoft
   accounts. Record its Application (client) ID. Enable public-client flows for
   device-code authorization and configure delegated Microsoft Graph `Mail.Send`.
   This integration does not use a client secret, mailbox password or App Password.
2. Privately set these backend environment values:

   ```dotenv
   NOTIFICATION_WORKERS_ENABLED=false
   MICROSOFT_MAIL_CLIENT_ID=<application-client-uuid>
   MICROSOFT_MAIL_SENDER=<primary-personal-outlook-address>
   MICROSOFT_MAIL_CACHE_KEY=<independent-random-64-hex-character-key>
   ```

   Generate the encryption key locally, keep it out of Git/chat/logs and retain it
   separately from database backups. Losing or changing the key requires sender
   authorization again. Use the same key/client/address on the authorizing machine
   and the intended deployment. Never reuse live keys in isolated previews.

3. Apply migration `0019_microsoft_mail_cache` using the normal migration process.
   Existing databases need the migration before sender authorization or workers.
4. Run `bun run email:authorize` from a trusted operator terminal. It displays
   Microsoft's device sign-in instructions. Open the Microsoft URL yourself and
   authorize **only the configured sender account**. Do not share the device code
   or capture it in a CI log. The command sends no mail.
5. The authorization cache is encrypted and saved in the configured database.
   For a hosted database, run authorization locally with a private environment
   file containing that deployment's settings, for example:

   ```sh
   bun --env-file=.env.outlook-operator run scripts/authorize-outlook.ts
   ```

   A local database authorization does not configure the hosted database. Copy
   environment configuration privately; never copy plaintext token-cache dumps.
   The Render free tier does not provide an interactive shell, so local operator
   authorization avoids depending on one.

6. Review existing pending/dead-letter work and intended recipients before enabling
   `NOTIFICATION_WORKERS_ENABLED=true` on the selected deployment. Restart it to
   load the configuration. Worker enablement can dispatch old queued messages.
   Keep `ACCOUNT_ACTION_SECRET` and `DELIVERY_CODE_SECRET` configured independently;
   the mail transport does not replace those proof keys.

Preview isolation still requires workers disabled. Do not relax that safeguard to
send real messages from a general preview. Use a deliberately selected mail-enabled
review deployment with isolated resources, or perform hosted delivery acceptance on
the intended deployment with explicit review accounts and recipients.

## Authorization and delivery behavior

MSAL Node obtains and refreshes tokens. Only the account matching the configured
sender is selected. An encrypted database cache survives process restarts; bounded
leases serialize refresh/cache writes across processes and fence expired owners.
Silent refresh holds a 90-second lease; interactive authorization holds up to 20
minutes. An interrupted authorization may require waiting for its lease to expire.
If consent is revoked or Microsoft requires interaction, run authorization again;
sign-in is not guaranteed to remain valid forever.

Graph receives JSON at `/v1.0/me/sendMail`, with the authorized account supplying
the From identity. Messages cannot select arbitrary sender addresses. Mail and
Microsoft token requests have deadlines, redirects are rejected and provider
response bodies/tokens are not copied into application errors. MSAL logging is
disabled in this path. A 401 triggers at most one forced token refresh and send
retry. Other uncertain sends are left to the existing durable retry policy.

HTTP 202 means Microsoft **accepted the request**, not that an inbox received it.
Existing database states named `sent`/`delivered` represent provider acceptance for
email jobs. They are not mailbox delivery receipts. Microsoft mailbox quotas,
anti-abuse checks, filtering and service outages still apply. There is no unlimited
free delivery guarantee.

Graph 429/503 Retry-After is bounded to one hour and persisted as a minimum next
attempt delay in all three email queues. Other failures retain existing exponential
backoff and five-attempt dead letters. Queued work rechecks its recipient, proof or
saved preferences before sending. A provider acceptance followed by a lost response
or worker crash can produce a duplicate. `x-isotrack-message-id` is a stable audit
correlation header, **not a Graph idempotency guarantee**.

## Frontend entry points

- Signup requests a verification email after account creation. Email request failure
  does not undo a successfully created account. This is a frontend request, not an
  atomic guarantee for every direct API registration.
- `/verify-email` requests a link or confirms the proof in its email fragment.
- `/forgot-password` requests a recovery link; `/reset-password` consumes it and
  asks the user to sign in after a successful reset.
- Proofs are kept in page memory, removed from the address bar, excluded from query
  caches and submitted only after an explicit action. Reopen the email link after
  reloading. Link-page GET requests never consume proofs. Existing single-use,
  expiry and credential/session invalidation checks remain on the backend.

No new public API endpoints were added. Swagger descriptions were updated and the
generated specification was refreshed.

## Verification scope

Local tests exercise the production Graph HTTP sender against a loopback fixture,
durable PostgreSQL/Redis queues and encrypted-cache concurrency/restart behavior.
Authorization policy tests use a substituted MSAL application; actual Microsoft
sign-in/token issuance has not been exercised. Backend TypeScript/lint, 109 unit
tests and the production build passed. Migration 0019 was applied only locally.
They do not contact Microsoft or establish inbox delivery. Real authorization,
receipt, hosted Stripe settlement and browser cross-domain sessions remain pending
the account and deployments. Follow the hosted-verification runbook.

Authoritative references: [Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0),
[MSAL Node caching](https://learn.microsoft.com/en-us/entra/msal/javascript/node/caching),
[MSAL authentication flows](https://learn.microsoft.com/en-us/entra/msal/msal-authentication-flows).
