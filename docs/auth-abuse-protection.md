# Login and registration abuse protection

The public auth router enforces PostgreSQL budgets before credential lookup or
bcrypt work. Every API instance must use the same database and JWT_SECRET. The
existing account_action_limits table from migration 0008 is required; this build
introduces no migration, dependency, Redis requirement or additional secret.
Stop older write-serving instances at rollout, since they do not enforce these
budgets. No live database or deployment was changed during development.

## Request policy

| Endpoint                   | Peer budget                               | Additional budget                                  | Body limit |
| -------------------------- | ----------------------------------------- | -------------------------------------------------- | ---------- |
| POST /api/v1/auth/login    | 30 submissions per 10-minute clock window | 10 attempts per peer/email pair in the same window | 4 KiB      |
| POST /api/v1/auth/register | 5 submissions per clock hour              | None                                               | 8 KiB      |

Peer counters include malformed and denied submissions, after the body-size check.
Login pair counters include successful and failed attempts; they are not cleared
on success. This bounds expensive work even when a caller knows one valid account.
PostgreSQL UPSERT conditional updates serialize contenders across processes.
Older statements cannot rewind an already-advanced counter. Fixed windows can
permit a burst spanning a boundary; this is not a sliding-window algorithm.

Exhausted requests return 429 and a Retry-After value in seconds to the window
boundary. Denials do not increment the counter, move its deadline, deactivate
the user or permanently lock the account. An exhausted peer/email pair does not
impose an email-only lockout on another network. Recovery routes retain their
separate budgets. Password reset does not clear these login budgets.

IPv4-mapped IPv6 is normalized to IPv4. IPv6 privacy addresses within one /64
share the same login/signup peer budget, reducing address-rotation bypass. Shared
NATs and /64 networks also share limits. These conservative defaults need traffic
measurement and deployment-specific tuning before broad public use.

Keys contain HMAC-SHA256 pseudonyms of peers and peer/email pairs, with explicit
authentication namespaces. Neither raw IPs nor email addresses are stored in
these counters. Pseudonyms are not anonymized data. JWT_SECRET rotation changes
the namespaces' hashes and effectively resets budgets; keep it consistent across
instances. Schedule the existing account-actions:purge command: its bounded
counter cleanup also removes authentication windows older than two days.

## Trusted proxy setup

TRUSTED_PROXY_IPS defaults to blank: use the actual socket peer and ignore all
forwarding headers. Configure a comma-separated list of exact immediate proxy IP
addresses only when deploying behind a controlled ingress. CIDRs, wildcards,
hostnames, ports and empty list items are rejected at startup.

An immediate peer on that allowlist must supply exactly one valid X-Real-IP.
Missing, malformed, comma-separated or scoped addresses fail closed with 503;
there is no fallback to an arbitrary forwarded chain. X-Forwarded-For and
Forwarded are not used. Untrusted direct peers cannot change their identity with
any of these headers. The same resolver now serves recovery/verification routes.

Before deployment, the trusted ingress must overwrite X-Real-IP with a verified
client address and remove the incoming client-supplied value. Restrict direct
access to the API so the ingress cannot be bypassed. For multiple hops/CDNs,
establish the authoritative client address at the trusted ingress first; this
adapter does not infer trust from a forwarded list. Do not allowlist every peer
or the public client addresses. Hosting topology, header rewriting and network
restrictions still require an actual staging rehearsal. If all clients appear
as one untrusted proxy, they will share its budget.

## Authentication and registration behavior

Only strict application/json objects are accepted. Passwords and unknown fields
are never echoed in validation errors. Unknown accounts, incorrect passwords,
inactive users and credentials changed before session issuance all return the
same 401 body. Unknown users perform a bcrypt comparison against a public dummy
hash at cost 12, matching newly stored credentials. A 350–400 ms minimum window
covers short login paths; database/network variance and legacy hash costs mean
constant-time HTTP and statistical timing resistance are not claimed.

Database/throttle/session failures return a generic 503 and no credential cookie.
The throttle store fails closed. Successful responses keep the existing access
token and HttpOnly refresh-cookie contract, and public user projection removes
passwordHash and credentialVersion. Responses use Cache-Control: no-store.
Existing refresh/logout/password endpoints retain their separate session policy.

User creation and the optional business profile now commit in one SQL statement.
An email uniqueness race creates exactly one account/profile; a profile failure
rolls back the user. Public driver signup remains forbidden; invitations are
required. Duplicate signup returns 409 with sign-in/recovery guidance and never
overwrites credentials. Registration is not enumeration-proof: 201 with a new
session versus 409 still distinguishes an existing email.

Session issuance happens after account creation. If signing/session delivery
fails or its response is lost, the complete account may already exist. Sign in
normally; a retry cannot create another account for the same email. Signup/login
do not require Idempotency-Key. Verification is still an explicit request, and
verified-email access gates are a separate rollout decision.

## Security events and remaining gates

Each admitted-size handler emits an allowlisted authentication_attempt event:
operation, outcome and a server-generated requestId. It does not log request
bodies, passwords, email addresses, IPs, JWTs, cookies or raw provider/database
errors. X-Request-Id is returned and exposed through CORS for client correlation.
Oversized bodies are rejected before this handler; these events are not a complete
audit trail. Collection, access/retention rules, aggregation and alert exercises
remain deployment work. Application-wide URL/error logging needs its own privacy
review; this change does not certify every log path in the application.

This control does not stop a distributed attack using many networks, bots creating
accounts across many peers, or volumetric traffic exhausting connections before
the application. It deliberately has no email-only hard lockout, MFA, CAPTCHA,
global edge budget or compromised-password screening. Edge protection, safe
password-policy evolution, measured bcrypt/SQL capacity, provider budgets and
deployed HTTP/Neon/Bun/proxy verification remain release gates. A zero-spend host
and locally passing tests do not establish million-user capacity.

## Local test boundaries

The auth suite applies the full migration journal in disposable PostgreSQL 17.
Two independent Hono router/server instances share it, with a third representing
an explicitly trusted proxy. Tests use actual TCP requests and the socket adapter,
bcrypt hashes, PostgreSQL session predicates and jose-signed fixture credentials.
They verify shared last-slot contention, limits/expiry/no extension, different
trusted peers, SQL races/stale windows, uniform failures, public projections,
proxy spoofing/fail-closed behavior, concurrent signup, profile rollback,
post-signup session failure recovery, credential-change races and oversized bodies.
Fast tests cover strict inputs, secret-free event fields, IP canonicalization,
IPv6 grouping, proxy configuration and CORS exposure.

Production statement builders and the new handler are exercised through a psql
adapter. Session signing is injected with real fixture keys using the production
session SQL; the production env-bound JWT signer, complete app entrypoint, hosted
Neon transport, browser cookies and actual ingress are not exercised by this suite.
The wider suites retain their earlier session/recovery/queue/socket coverage.
Design reference: [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).
