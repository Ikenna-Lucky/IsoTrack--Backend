# Hosted verification — roadmap item 6

Status: implementation/local verification complete; **hosted acceptance not yet
performed**. The user does not yet have the Outlook sender or deployment URLs.
Those are environment/operator inputs, not code-generation prerequisites. Do not
mark this roadmap item complete from local tests or a successful build.

## Before the hosted run

Record the frontend/backend URLs, their release identities, test date, browser and
selected isolated environment. Confirm the frontend's API origin, backend
`FRONTEND_URL`, database/Redis isolation and migrations through 0019. Use fictional
accounts and intended recipient inboxes. Do not export credentials or email proofs
to the evidence report. Check budget and worker policy before enabling dispatch.

Follow [Microsoft Graph setup](microsoft-graph-email.md). Real verification requires
the sender's authorization in the **same database** used by the deployment. Render
free service idling/restarts can delay background processing; ordinary HTTP access
does not establish an always-running email worker.

## Real email receipt

1. Register a new review account with an inbox distinct from the sender. Check
   account creation, request acceptance, durable job status, Sent Items and actual
   recipient receipt separately. Record spam-folder placement if applicable.
2. Open its verification link on the hosted frontend. Confirm via POST, then prove
   the backend saved verification. The consumed link must fail on repeat. Request
   another link and exercise expired/invalid feedback without recording the proof.
3. Request a password reset. Receive/open it, reset, verify the old password fails
   and the new one succeeds. Previously active sessions and used proofs must fail.
   Confirm the separate password-change notice arrives.
4. With a fictional active shipment, issue a delivery code to an intended recipient.
   Verify actual receipt and expiry, replacement invalidation and correct-driver
   handover. Do not extract codes from database secrets.
5. Exercise enabled and disabled Business/Driver alert choices with intended
   recipients. Queued opt-outs must be skipped. Inspect retries/dead letters after
   an intentional provider failure without causing an uncontrolled email burst.

Provider 202, a queue `sent`/`delivered` state and Sent Items alone do not prove
recipient inbox delivery. Retain only redacted evidence and timestamps.

## Stripe sandbox settlement and recovery

Use sandbox keys/webhook signing secret from the selected sandbox. Live keys remain
unsupported. Confirm frontend/backend release pairing before checkout.

1. For a linked review shipment, initialize checkout with one idempotency key and
   exact kobo amount. Complete Stripe's sandbox checkout. Verify a signed event
   reaches the backend, one settlement is applied and shipment payment updates.
2. Confirm `paid=true`, `applied=true`, `requiresReview=false` for a settled payment.
   A redirect or provider-paid result alone must not show settled success.
3. Replay the same webhook and checkout initialization safely: one financial effect
   and no duplicate receipt. Check ownership denial from a second customer account.
4. Exercise abandoned checkout, unpaid cancellation, delayed settlement and review
   paths. A cancellation is not a refund. Uncertain/review states must prevent a
   blind replacement payment and preserve reference-based recovery.

## Actual browser cross-domain sessions

Node HTTP tests cannot establish browser cookie behavior. Run the actual frontend
origin against the selected backend origin, at least in the user's target browser.

1. Sign in, navigate, reload and open another tab. Inspect credentialed CORS and
   Secure/HttpOnly/SameSite cookie behavior without copying cookie values.
2. Exercise access-token expiry and simultaneous expired requests. One serialized
   refresh should restore usable requests; rotated credentials must stay private.
3. Test multiple tabs refreshing together, logout, password reset and account
   switching. A late old-session response must not restore an old account.
4. Test missing/foreign Origin rejection, invalid/revoked refresh and a temporarily
   unavailable backend. Failures must not produce an endless refresh loop.
5. Include the target browser's third-party-cookie restrictions/private mode. If
   cross-site cookies are blocked, record the actual failure and select an
   appropriate same-site hosting/proxy design; SameSite=None is not a universal
   exemption from browser policy.
6. Check tracking reconnect/rejoin after token rotation and private GPS denial
   after logout/account changes. Confirm responsive auth/link-page feedback too.

## Acceptance record

For each journey retain: release SHA(s), environment, UTC timestamp, test account
label, expected result, observed result, relevant redacted request/provider IDs,
and pass/fail/unverified. Record blockers separately. Do not fill a pass based on
another deployment's results. Nothing in this runbook deploys, merges or sends
mail automatically.
