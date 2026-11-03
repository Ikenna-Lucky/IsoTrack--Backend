# Authentication sessions

Each login or registration creates an independent PostgreSQL session. Signed access
and refresh tokens carry its random `sid`; refresh tokens also carry a generation.
No raw tokens are stored. The database is authoritative: protected HTTP requests
reject missing, expired, revoked or credential-invalidated sessions. Database
outages remain server errors and never fall back to accepting a token alone.

## Refresh and logout contract

- Refresh tokens are single use. A successful refresh increments the generation
  atomically and replaces the HTTP-only cookie. Rotation keeps the original session
  expiry; the default lifetime is seven days, not a sliding seven-day extension.
- A previously used generation revokes that session, including access tokens from
  it. Other devices remain signed in. Two concurrent refreshes produce at most one
  successful rotation, and the second request revokes that session.
- Clients must serialize refresh requests, including across tabs sharing the
  cookie. There is no retry grace window. A lost response or duplicate request may
  require another login. Backend changes do not implement client coordination.
- `POST /api/v1/auth/refresh` and `/logout` require `Origin` equal to the origin of
  `FRONTEND_URL`, even for CLI clients. Missing, `null` and foreign origins receive 403. CORS alone is not the cookie request protection.
- Logout revokes the session identified by a verified refresh cookie, then clears
  that cookie. Missing/invalid cookies are an idempotent success. Storage failure
  returns a server error without pretending revocation succeeded. A client that
  has lost its cookie must clear its local access token; this endpoint cannot
  revoke an unidentified session. Expired sessions already fail authorization.
- Password changes invalidate all devices and clear the current refresh cookie.
  The client must return to login. A compare-and-set password update rejects a
  stale concurrent change with 409.
- Responses from the session endpoints use `Cache-Control: no-store`.

The strict replay policy follows the rotation/revocation approach described in
[RFC 9700 section 4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2).
This application is not claiming OAuth conformance.

## Credential invalidation

Migration `0005_auth_sessions.sql` adds a database trigger that increments a user's
credential version when their password hash or active status changes. A session's
version must match the current user version. Deactivation therefore invalidates
existing sessions permanently, even after reactivation; password changes also
invalidate a login or refresh racing that change. Changes to ordinary profile
fields do not invalidate sessions. Current roles still come from the database.

Authorization checks apply to new protected HTTP requests. Requests already
authorized may finish after revocation. Socket.IO now checks these sessions at
connection, during handled events, before GPS delivery and on periodic idle checks.
See tracking.md for its timing, reconnect contract and remaining deployment gates.

## Rollout and cleanup

1. Back up the database and apply migrations through `npm run db:migrate` using Bun.
   Do not substitute `db:push`: schema push does not install the credential trigger.
2. Deploy the backend after migration. All legacy tokens lack a session identifier
   and will be rejected; users must log in again. No new environment secrets are
   required. Existing JWT secrets remain in use.
3. Verify refresh, logout and password-change journeys in the target environment.
   Deploying the migration alone does not secure an older running backend.
4. Schedule `npm run sessions:purge` with Bun in the deployment environment, for
   example hourly. Each invocation deletes at most 100,000 records in batches of
   5,000, with `SKIP LOCKED`. Only sessions expired more than seven days ago qualify;
   active sessions and recent records remain. The expiry index supports selection.
   Observe deletion counts and adjust scheduling to measured volume. Scheduling is
   not configured by this repository change.

If rolling the application back, retain the additive schema and trigger. Rolling
back to the former stateless implementation restores its revocation weaknesses;
it is not a security-preserving rollback. Do not drop these tables as a routine
rollback. Migration execution against production has not been performed.

## Verification boundaries

Fast tests exercise claim validation, bounded lifetimes, origin enforcement,
cookie attributes, no-store responses, invalid credentials and storage failures.
PostgreSQL integration tests execute the actual migration and production SQL for
single-use rotation, concurrent replay, ownership, logout, password invalidation,
deactivation/reactivation, expiry, deletion, cleanup and credential-change races.
HTTP refresh/replay/logout tests combine the production session router,
authentication middleware, real jose signatures and real PostgreSQL statements.

The integration transport is a psql test adapter, not deployed Neon HTTP. The full
login/password HTTP routes, browser coordination, production migration, deployed
configuration and remote CI remain unverified. Device management,
session audit telemetry and issuer/audience policy remain future hardening work.
Socket verification and deployment limits are recorded in tracking.md. No
production workload capacity is claimed.

Password recovery and email verification now have separate HTTP/database/SMTP
tests, including signed-session denial after reset and email-change invalidation.
Their peer/resend budgets apply only to the account-action endpoints. Login and
registration now have separate PostgreSQL limits and a shared trusted-proxy
resolver; see auth-abuse-protection.md. See account-recovery.md for recovery
contracts, configuration, frontend adoption and verification boundaries.
