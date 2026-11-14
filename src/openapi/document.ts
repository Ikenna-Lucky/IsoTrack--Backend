import type { OpenAPIV3 } from "openapi-types";
import {
  schemas,
  ref,
  object,
  array,
  text,
  integer,
  boolean,
} from "./schemas.ts";

type Field = OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;
const envelope = (data: Field): OpenAPIV3.SchemaObject =>
  object(
    { success: { type: "boolean", enum: [true] }, data, message: text() },
    ["success", "data"],
  );
const messageOnly = object({
  success: { type: "boolean", enum: [true] },
  message: text(),
});
const nullData: OpenAPIV3.SchemaObject = {
  type: "string",
  nullable: true,
  enum: [null],
};
const json = (
  schema: Field,
  description: string,
  example?: unknown,
): OpenAPIV3.ResponseObject => ({
  description,
  content: {
    "application/json": {
      schema,
      ...(example === undefined ? {} : { example }),
    },
  },
});
const page = (item: string, pagination = "CursorPagination") =>
  object({
    success: { type: "boolean", enum: [true] },
    data: array(ref(item)),
    pagination: ref(pagination),
  });
const retryHeader: OpenAPIV3.HeaderObject = {
  description: "Minimum seconds to wait before retrying.",
  schema: integer({ minimum: 1 }),
};
const replayHeader: OpenAPIV3.HeaderObject = {
  description:
    "true when returning the recorded result of an earlier matching request.",
  schema: boolean,
};
const cookieHeader: OpenAPIV3.HeaderObject = {
  description:
    "HttpOnly iso_refresh_token cookie. Production: Secure; SameSite=None; Path=/. Not returned in JSON or readable by JavaScript.",
  schema: text(),
};
const failures: Record<string, string> = {
  "400":
    "Invalid body, key or pagination. Some older Zod-validated endpoints return {success:false,error:{name:'ZodError',issues:[...]}} instead of a string error code.",
  "401": "Missing, expired, revoked or invalid session/credentials.",
  "403":
    "Role or action forbidden. Role guards may return error=INTERNAL_SERVER_ERROR at this status; do not interpret that code as HTTP 500.",
  "404":
    "Missing or inaccessible resource. Ownership failures intentionally do not reveal resource existence.",
  "408": "Request body was not received before its deadline.",
  "409":
    "Business-rule, concurrency, credential or idempotency conflict; inspect error and reload/reconcile before a new action.",
  "410":
    "Idempotency record expired. Do not reuse the key or blindly create a replacement action; reconcile the original outcome.",
  "413":
    "Request body exceeds the endpoint limit (outer maximum 16 KiB, except Stripe webhook 256 KiB). A narrower Hono body-limit response may be plain text.",
  "415":
    "Compressed request bodies are unsupported. Send ordinary uncompressed JSON.",
  "422":
    "Valid input shape but invalid workflow transition or unavailable linked customer.",
  "429": "Rate limit exceeded. Respect Retry-After; do not loop immediately.",
  "500":
    "Unexpected server failure; use X-Request-Id when reporting the issue. An uncertain write outcome must be retried with the same idempotency key/body.",
  "502":
    "Payment provider request/response failed. Preserve original payment reference and request key; verify/reconcile before starting again.",
  "503":
    "Required service or feature unavailable. Protected routes fail closed when request budgets cannot be checked.",
};
const errorExamples: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  408: "REQUEST_TIMEOUT",
  409: "CONFLICT",
  410: "IDEMPOTENCY_EXPIRED",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_CONTENT_ENCODING",
  422: "UNPROCESSABLE_ENTITY",
  429: "RATE_LIMITED",
  500: "INTERNAL_SERVER_ERROR",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
};
function errors(statuses: number[]): OpenAPIV3.ResponsesObject {
  return Object.fromEntries(
    [...new Set([...statuses, 408, 413, 415, 500])].map((status) => [
      String(status),
      {
        ...json(
          status === 400
            ? { oneOf: [ref("Error"), ref("ValidationError")] }
            : ref("Error"),
          `${failures[status]!} Example illustrates the error shape; use operation-specific codes described above.`,
          { success: false, error: errorExamples[status] },
        ),
        ...(status === 429 || status === 503
          ? { headers: { "Retry-After": retryHeader } }
          : {}),
        ...(status === 413
          ? {
              content: {
                "application/json": {
                  schema: ref("Error"),
                  example: {
                    success: false,
                    error: "PAYLOAD_TOO_LARGE",
                    message: "Request body too large",
                  },
                },
                "text/plain": { schema: text() },
              },
            }
          : {}),
      },
    ]),
  );
}
const paths: OpenAPIV3.PathsObject = {};
interface Endpoint {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  id: string;
  tag: string;
  summary: string;
  description: string;
  data?: Field;
  response?: OpenAPIV3.SchemaObject;
  status?: number;
  input?: string;
  example?: unknown;
  resultExample?: unknown;
  public?: boolean;
  cookie?: boolean;
  cookieAuth?: boolean;
  idempotent?: boolean;
  parameters?: OpenAPIV3.ParameterObject[];
  failures?: number[];
}
const idempotency: OpenAPIV3.ParameterObject = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  description:
    "Generate once per logical action (crypto.randomUUID() is suitable); preserve the same key AND body for uncertain retries. A changed body requires a new action/key after reconciling the original. Scope includes account and operation; 24-hour request window, expired keys stay unusable.",
  schema: text({
    minLength: 16,
    maxLength: 128,
    pattern: "^[A-Za-z0-9_-]{16,128}$",
  }),
  example: "87e46d18-f005-4f2b-9871-6463a5502092",
};
const cursorParameters: OpenAPIV3.ParameterObject[] = [
  {
    name: "limit",
    in: "query",
    description:
      "Decimal 1–50, default 20. No leading zeros, duplicate or unknown query parameters.",
    schema: integer({ minimum: 1, maximum: 50, default: 20 }),
  },
  {
    name: "cursor",
    in: "query",
    description:
      "Opaque nextCursor from the previous response. Bound to account, role, endpoint and applicable filter/shipment. Preserve exactly; reset on scope changes.",
    schema: text({
      minLength: 1,
      maxLength: 1024,
      pattern: "^[A-Za-z0-9_-]+$",
    }),
  },
];
function add(endpoint: Endpoint) {
  const defaultFailures = endpoint.public ? [400] : [400, 401, 403, 404, 409];
  if (
    /^\/api\/v1\/(shipments|payments|track)(?:\/|$)/.test(endpoint.path) ||
    endpoint.path === "/api/v1/auth/deactivate"
  )
    defaultFailures.push(429, 503);
  const status = endpoint.status ?? 200;
  const response = endpoint.response ?? envelope(endpoint.data ?? nullData);
  const ok = json(response, "Successful operation.", endpoint.resultExample);
  const headers: Record<string, OpenAPIV3.HeaderObject> = {};
  if (endpoint.idempotent) headers["Idempotency-Replayed"] = replayHeader;
  if (endpoint.cookie) headers["Set-Cookie"] = cookieHeader;
  if (Object.keys(headers).length) ok.headers = headers;
  const parameters: OpenAPIV3.ParameterObject[] = [
    ...Array.from(endpoint.path.matchAll(/\{([^}]+)\}/g), (match) => ({
      name: match[1]!,
      in: "path" as const,
      required: true,
      description:
        match[1] === "trackingId"
          ? "Public tracking identifier, not the internal shipment ID."
          : match[1] === "reference"
            ? "Payment reference returned by initialize; not the Stripe session ID."
            : "Internal resource ID returned by the API.",
      schema: text({ minLength: 1 }),
    })),
    ...(endpoint.idempotent ? [idempotency] : []),
    ...(endpoint.parameters ?? []),
  ];
  const operation: OpenAPIV3.OperationObject = {
    operationId: endpoint.id,
    tags: [endpoint.tag],
    summary: endpoint.summary,
    description: endpoint.description,
    security: endpoint.cookieAuth
      ? [{ refreshCookie: [] }]
      : endpoint.public
        ? []
        : [{ bearerAuth: [] }],
    ...(parameters.length ? { parameters } : {}),
    ...(endpoint.input
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: ref(endpoint.input),
                ...(endpoint.example === undefined
                  ? {}
                  : { example: endpoint.example }),
              },
            },
          },
        }
      : {}),
    responses: {
      ...errors(endpoint.failures ?? defaultFailures),
      [status]: ok,
    },
  };
  (paths[endpoint.path] ??= {})[endpoint.method] = operation;
}

const prefix = "/api/v1";
const auth = `${prefix}/auth`;
add({
  method: "post",
  path: `${auth}/register`,
  id: "registerAccount",
  tag: "Authentication",
  summary: "Register a business or customer",
  public: true,
  cookie: true,
  status: 201,
  input: "RegisterInput",
  example: {
    name: "Ada Okafor",
    email: "ada@example.test",
    password: "ExamplePass123",
    role: "business",
    businessName: "Ada Deliveries",
  },
  data: ref("Session"),
  failures: [400, 403, 409, 429, 503],
  description:
    "Public driver signup returns 403. Business profile creation is atomic. Maximum 8 KiB body. Returns user/accessToken and sets refresh cookie. If account creation succeeded but session issuance failed (503), sign in rather than repeatedly registering.",
});
add({
  method: "post",
  path: `${auth}/login`,
  id: "login",
  tag: "Authentication",
  summary: "Sign in",
  public: true,
  cookie: true,
  input: "LoginInput",
  example: { email: "ada@example.test", password: "ExamplePass123" },
  data: ref("Session"),
  failures: [400, 401, 429, 503],
  description:
    "Maximum 4 KiB body. Generic invalid-credentials response for missing, inactive or wrong-password accounts. Sets a rotating HttpOnly refresh cookie; access token and safe user are returned in data.",
});
const origin: OpenAPIV3.ParameterObject = {
  name: "Origin",
  in: "header",
  required: true,
  description:
    "Must exactly equal configured FRONTEND_URL origin. Browsers set this automatically and forbid overriding it. Backend-hosted Swagger has a different origin and cannot execute this flow unless origins actually match; use the frontend or curl with its trusted Origin. Do not relax the server check.",
  schema: text({ format: "uri" }),
  example: "http://localhost:3000",
};
add({
  method: "post",
  path: `${auth}/refresh`,
  id: "refreshSession",
  cookieAuth: true,
  tag: "Authentication",
  summary: "Rotate refresh cookie and get a new session",
  public: true,
  cookie: true,
  parameters: [origin],
  data: ref("Session"),
  failures: [401, 403],
  description:
    "No JSON body. Browser fetch needs credentials:'include'. Serialize refreshes across requests/tabs: reuse of an old refresh generation revokes the session. On failed/lost refresh, clear auth and sign in. No GET /auth/me exists; use user from login/refresh. Cookie auth cannot be entered manually through Swagger's Authorize dialog.",
});
add({
  method: "post",
  path: `${auth}/logout`,
  id: "logout",
  tag: "Authentication",
  summary: "Revoke session and clear refresh cookie",
  public: true,
  cookie: true,
  parameters: [origin],
  data: nullData,
  failures: [403],
  description:
    "No body. Exact trusted Origin is required even for non-browser clients. Missing or invalid cookie is accepted idempotently. A valid cookie identifies the session to revoke. Clear frontend state and disconnect sockets.",
});
add({
  method: "patch",
  path: `${auth}/me`,
  id: "updateMyProfile",
  tag: "Account",
  summary: "Update own personal profile",
  input: "ProfileInput",
  example: { name: "Ada Okafor", phone: "+2348012345678" },
  data: ref("User"),
  description:
    "Partial update. Empty strings/null clear phone, avatar or emergencyContact. Unknown keys are stripped by the validator; role/email cannot be changed here.",
});
add({
  method: "patch",
  path: `${auth}/password`,
  id: "changePassword",
  tag: "Account",
  summary: "Change password and revoke all sessions",
  input: "PasswordInput",
  example: {
    currentPassword: "ExamplePass123",
    newPassword: "ReplacementPass123",
  },
  data: nullData,
  description:
    "Verifies current password, updates credentials atomically, invalidates existing sessions and clears the refresh cookie. Return to login on success.",
});
add({
  method: "post",
  path: `${auth}/deactivate`,
  id: "deactivateAccount",
  tag: "Account",
  summary: "Deactivate account while preserving historical records",
  input: "DeactivateInput",
  example: { currentPassword: "ExamplePass123" },
  data: object({ isActive: { type: "boolean", enum: [false] } }),
  description:
    "Maximum 2 KiB body. 401 INVALID_CREDENTIALS for wrong password. 409 blockers: CREDENTIALS_CHANGED, FLEET_OFFBOARDING_REQUIRED, ACTIVE_SHIPMENTS, UNRESOLVED_PAYMENTS. Resolve fleet/custody/payment blockers first. Success invalidates sessions; there is no public reactivation operation.",
});
add({
  method: "delete",
  path: `${auth}/me`,
  id: "rejectPermanentAccountDeletion",
  tag: "Account",
  summary: "Permanent account deletion is unavailable",
  status: 409,
  response: schemas.Error!,
  failures: [401],
  resultExample: {
    success: false,
    error: "PERMANENT_DELETION_UNAVAILABLE",
    message: "Use account deactivation; historical records are preserved",
  },
  description:
    "This route always returns 409 for an authenticated user. Use POST /auth/deactivate. It does not delete data.",
});
for (const [route, id, summary] of [
  [
    "forgot-password",
    "requestPasswordReset",
    "Request password recovery email",
  ],
  [
    "verification/request",
    "requestEmailVerification",
    "Request email verification",
  ],
] as const)
  add({
    method: "post",
    path: `${auth}/${route}`,
    id,
    tag: "Account recovery",
    summary,
    public: true,
    status: 202,
    input: "EmailInput",
    example: { email: "ada@example.test" },
    response: messageOnly,
    failures: [400, 429, 503],
    resultExample: {
      success: true,
      message: "If the account is eligible, an email will be sent.",
    },
    description:
      "Maximum 4 KiB body. 202 is deliberately identical for eligible/ineligible accounts and does not prove delivery. Email depends on configured account-action secret, worker and authorized Outlook Microsoft Graph sender. INVALID_INPUT=400; ACCOUNT_ACTION_UNAVAILABLE=503.",
  });
add({
  method: "post",
  path: `${auth}/reset-password`,
  id: "resetPassword",
  tag: "Account recovery",
  summary: "Consume password recovery token",
  public: true,
  input: "ResetPasswordInput",
  response: messageOnly,
  failures: [400, 429, 503],
  description:
    "Maximum 4 KiB body. Token comes from the recovery email, is single-use and credential-bound. INVALID_OR_EXPIRED_TOKEN=400. Success revokes sessions and clears refresh cookie; return to login.",
});
add({
  method: "post",
  path: `${auth}/verification/confirm`,
  id: "confirmEmailVerification",
  tag: "Account recovery",
  summary: "Consume email verification token",
  public: true,
  input: "TokenInput",
  response: messageOnly,
  failures: [400, 429, 503],
  description:
    "Maximum 4 KiB body. Single-use email token, not an access JWT. INVALID_INPUT or INVALID_OR_EXPIRED_TOKEN=400; disabled/unavailable flow=503.",
});

const invitations = `${prefix}/driver-invitations`;
add({
  method: "post",
  path: invitations,
  id: "createDriverInvitation",
  tag: "Fleet invitations",
  summary: "Invite a driver to the business fleet",
  input: "InvitationInput",
  example: { email: "driver@example.test" },
  status: 201,
  data: ref("CreatedInvitation"),
  description:
    "Business owner only. Invitation expires after 48 hours. Token is shown once and must be shared securely by the owner; this endpoint does not promise an invitation email. Maximum 8 KiB body.",
});
add({
  method: "get",
  path: invitations,
  id: "listDriverInvitations",
  tag: "Fleet invitations",
  summary: "List latest 50 owned invitations",
  data: { ...array(ref("Invitation")), maxItems: 50 },
  description:
    "Business owner only. Newest first, no pagination parameters, no token/tokenHash in results. acceptedAt/revokedAt/expiresAt determine availability.",
});
add({
  method: "delete",
  path: `${invitations}/{id}`,
  id: "revokeDriverInvitation",
  tag: "Fleet invitations",
  summary: "Revoke pending invitation",
  data: object({ id: text() }),
  description:
    "Business owner only; 404 if foreign, missing, accepted or already revoked.",
});
add({
  method: "post",
  path: `${invitations}/accept`,
  id: "acceptDriverInvitation",
  tag: "Fleet invitations",
  summary: "Create driver account from an invitation",
  public: true,
  status: 201,
  input: "AcceptInvitationInput",
  example: {
    token: "A".repeat(43),
    email: "driver@example.test",
    name: "Tunde Bello",
    password: "ExamplePass123",
    vehicleType: "bike",
    vehiclePlate: "LAG-123AB",
  },
  data: ref("Membership"),
  failures: [400, 404, 409],
  description:
    "No login required. Must match invitation email and valid token. Creates account and fleet membership atomically, but DOES NOT create a session. Sign in afterward. Maximum 8 KiB body. Existing accounts use accept-existing instead.",
});
add({
  method: "post",
  path: `${invitations}/accept-existing`,
  id: "acceptExistingDriverInvitation",
  tag: "Fleet invitations",
  summary: "Enroll existing unlinked driver",
  input: "AcceptExistingInvitationInput",
  example: { token: "A".repeat(43) },
  data: ref("Membership"),
  description:
    "Authenticated driver only. Identity comes from session, never client-supplied user ID. Account email must match invitation and driver must be eligible/unlinked. Incompatible account/invitation=409. Maximum 8 KiB body.",
});

for (const [path, id, summary] of [
  ["", "listFleetDrivers", "List own fleet drivers"],
  [
    "/available",
    "listAvailableFleetDrivers",
    "List available active fleet drivers",
  ],
] as const)
  add({
    method: "get",
    path: `${prefix}/drivers${path}`,
    id,
    tag: "Drivers",
    summary,
    response: page("FleetDriver"),
    parameters: cursorParameters,
    description:
      "Business owner only. Cursor pagination; no public/cross-business directory. Available and full lists have separate cursor scopes. Fleet list user is a limited contact projection, not the full account object.",
  });
add({
  method: "get",
  path: `${prefix}/drivers/me`,
  id: "getMyDriverProfile",
  tag: "Drivers",
  summary: "Get own driver profile",
  data: ref("DriverProfile"),
  description:
    "Driver only. Includes full safe user and stored notification preferences. businessId may be null for legacy unlinked drivers.",
});
add({
  method: "patch",
  path: `${prefix}/drivers/me`,
  id: "updateMyVehicle",
  tag: "Drivers",
  summary: "Update own vehicle details",
  input: "VehicleInput",
  example: { vehicleType: "bike", vehiclePlate: "LAG-123AB" },
  data: ref("Driver"),
  description:
    "Driver only. Partial update. Empty/null optional vehicle strings clear them; vehicleType/vehiclePlate must remain valid when supplied. Response is the driver record without nested user.",
});
add({
  method: "patch",
  path: `${prefix}/drivers/me/status`,
  id: "updateMyDriverStatus",
  tag: "Drivers",
  summary: "Set availability",
  input: "DriverStatusInput",
  example: { status: "available" },
  data: ref("Driver"),
  description:
    "Driver only. Fleet membership required unless changing to offline. Availability status alone does not assign, pick up or deliver a shipment.",
});
add({
  method: "patch",
  path: `${prefix}/drivers/me/location`,
  id: "updateMyDriverLocation",
  tag: "Drivers",
  summary: "Update driver profile location",
  input: "CoordinatesInput",
  example: { lat: 6.5244, lng: 3.3792 },
  data: nullData,
  description:
    "Driver only. Accepts ONLY lat/lng. Updates driver profile location, not shipment live tracking. Use authenticated Socket.IO driver:location for shipment tracking.",
});
for (const method of ["get", "patch"] as const)
  add({
    method,
    path: `${prefix}/drivers/me/notifications`,
    id:
      method === "get"
        ? "getMyDriverNotificationPreferences"
        : "updateMyDriverNotificationPreferences",
    tag: "Drivers",
    summary: `${method === "get" ? "Read" : "Update"} driver notification preferences`,
    ...(method === "patch"
      ? {
          input: "DriverNotifications",
          example: { newDelivery: { push: true, email: true } },
        }
      : {}),
    data: ref("DriverNotifications"),
    description:
      "Driver only. PATCH atomically merges supplied event objects; include both push and email for each changed event. GET/PATCH responses include defaults. newDelivery, deliveryComplete and deliveryFailed control assignment, confirmed-handover and actual failed-attempt notifications. push means dashboard inbox, not browser/device push. Email and in-app delivery are independent and rechecked at dispatch against current choices, assignment, active account and fleet membership. Opt-outs suppress queued delivery; existing inbox records remain. Emails already sending cannot be recalled. pickupReminder, customerMessage, ratingReceived, payoutProcessed and weeklyReport are stored compatibility fields without delivery. Notification workers and mail transport must be configured. No historical backfill.",
  });
add({
  method: "get",
  path: `${prefix}/drivers/{id}`,
  id: "getFleetDriver",
  tag: "Drivers",
  summary: "Get an owned fleet driver's profile",
  data: ref("DriverProfile"),
  description:
    "Business owner only. Driver must belong to own fleet; foreign and missing IDs both return 404. Includes safe user, not credentials.",
});

for (const [route, tag, input, read, update, readId, updateId, example] of [
  [
    "profile",
    "Business",
    "BusinessProfileInput",
    "BusinessProfile",
    "Business",
    "getBusinessProfile",
    "updateBusinessProfile",
    {
      businessName: "Ada Deliveries",
      address: { street: "12 Example Street", city: "Ikeja", state: "Lagos" },
    },
  ],
  [
    "notifications",
    "Business",
    "BusinessNotifications",
    "BusinessNotifications",
    "BusinessNotifications",
    "getBusinessNotificationPreferences",
    "updateBusinessNotificationPreferences",
    { delivered: { email: true, sms: false } },
  ],
  [
    "preferences",
    "Business",
    "BusinessPreferences",
    "BusinessPreferences",
    "BusinessPreferences",
    "getBusinessPreferences",
    "updateBusinessPreferences",
    { timezone: "Africa/Lagos", compactView: false },
  ],
] as const) {
  add({
    method: "get",
    path: `${prefix}/business/${route}`,
    id: readId,
    tag,
    summary: `Read business ${route}`,
    data: ref(read),
    description:
      "Business owner only. Missing/ambiguous legacy business profile may require operator reconciliation (409). Profile GET includes safe user; settings reads merge defaults with stored values.",
  });
  add({
    method: "patch",
    path: `${prefix}/business/${route}`,
    id: updateId,
    tag,
    summary: `Update business ${route}`,
    input,
    example,
    data: ref(update),
    description:
      "Business owner only. Partial update. Preference writes merge at top level; provide both channel booleans for any supplied event. Notification preference PATCH returns stored JSON (possibly partial), whereas GET applies defaults. Currency preference does not change NGN checkout currency. Business shipment email preferences are checked before enqueue and dispatch for shipmentCreated, driverAssigned, pickedUp, outForDelivery, delivered and failed. In-app notifications remain enabled. SMS, driverOnline and weeklyReport delivery are not implemented; stored choices do not enable those channels. Emails already sending cannot be recalled.",
  });
}
add({
  method: "get",
  path: `${prefix}/business/analytics`,
  id: "getBusinessAnalytics",
  tag: "Business",
  summary: "Read business shipment aggregates",
  data: ref("Analytics"),
  description:
    "Business owner only. totalRevenueKobo sums ALL shipment prices, not paid/settled revenue. recentShipments contains at most 10 newest summaries with customer/driver projections, no events/payment. No date-range or pagination parameters are implemented.",
});

const shipments = `${prefix}/shipments`;
const writeFailures = [400, 401, 403, 404, 409, 410, 422, 429, 503];
add({
  method: "get",
  path: shipments,
  id: "listShipments",
  tag: "Shipments",
  summary: "List accessible shipments",
  response: page("ShipmentListItem"),
  parameters: [
    ...cursorParameters,
    {
      name: "includeCompleted",
      in: "query",
      description:
        "Driver only. Default false excludes terminal work except failed packages still in custody. Business/customer must omit this parameter, even false.",
      schema: boolean,
    },
  ],
  description:
    "Owner: own business shipments. Driver: current assignment in own fleet. Customer: linked customerId. Newest first; cursor pagination only (page/pageSize/status/search are rejected). List events: business=[], driver latest 1, customer latest 3; use detail/history for more. recipientEmail only for business.",
});
add({
  method: "post",
  path: shipments,
  id: "createShipment",
  tag: "Shipments",
  summary: "Create shipment",
  status: 201,
  input: "ShipmentInput",
  example: {
    description: "Box of books",
    weightKg: 2.5,
    pickupAddress: {
      street: "12 Example Street",
      city: "Ikeja",
      state: "Lagos",
    },
    deliveryAddress: { street: "8 Sample Road", city: "Yaba", state: "Lagos" },
    priceKobo: 250000,
    recipientEmail: "recipient@example.test",
  },
  data: ref("Shipment"),
  idempotent: true,
  failures: writeFailures,
  description:
    "Business owner only. Maximum 16 KiB body. Price is positive integer kobo. Optional customerId/customerEmail link an existing active customer; recipientEmail is separate and creates no account. No driver/status/dimensions accepted. Creates initial event atomically. Retry with original key/body; never generate a replacement key just because the network timed out.",
});
add({
  method: "get",
  path: `${shipments}/{id}`,
  id: "getShipment",
  tag: "Shipments",
  summary: "Get shipment detail",
  data: ref("ShipmentDetail"),
  description:
    "Owning business, assigned fleet driver or linked customer. Returns latest 50 events, newest first, and eventsTruncated. Latest payment summary is null for driver. recipientEmail omitted for driver/customer. Full older history is in /events.",
});
add({
  method: "get",
  path: `${shipments}/{id}/events`,
  id: "listShipmentEvents",
  tag: "Shipments",
  summary: "Read shipment history",
  response: page("ShipmentEvent"),
  parameters: cursorParameters,
  description:
    "Same participant access as detail. Cursor also bound to shipment ID. Newest first; returns sanitized operational messages, not private exception notes.",
});
add({
  method: "patch",
  path: `${shipments}/{id}/assign`,
  id: "assignShipmentDriver",
  tag: "Shipment commands",
  summary: "Assign active driver from own fleet",
  input: "AssignInput",
  example: { expectedVersion: 0, driverId: "driver_example" },
  data: ref("Shipment"),
  idempotent: true,
  failures: writeFailures,
  description:
    "Business owner only. Assignment requires pending status and an active driver in the same fleet. The command does not enforce driver availability status; /drivers/available is a discovery filter. DRIVER_UNAVAILABLE=409. Maximum 4 KiB command body. Use returned version for the next action.",
});
add({
  method: "patch",
  path: `${shipments}/{id}/status`,
  id: "updateShipmentStatus",
  tag: "Shipment commands",
  summary: "Advance ordinary shipment status",
  input: "StatusInput",
  example: {
    expectedVersion: 1,
    status: "picked_up",
    note: "Collected from sender",
  },
  data: ref("Shipment"),
  idempotent: true,
  failures: writeFailures,
  description:
    "Owning business or assigned fleet driver. Normal progression: assigned → picked_up → in_transit → out_for_delivery. Use /confirm-delivery for delivered (otherwise 422 DELIVERY_CONFIRMATION_REQUIRED), /exceptions for failed/retry (otherwise 422 USE_EXCEPTION_ENDPOINT). Cancellation is owner-only before pickup. Invalid transitions=422; stale version=409 SHIPMENT_VERSION_CONFLICT. Maximum 4 KiB. After reload/reassessment, a changed command needs a fresh key.",
});
add({
  method: "delete",
  path: `${shipments}/{id}`,
  id: "cancelShipment",
  tag: "Shipment commands",
  summary: "Cancel shipment before pickup",
  input: "CancelInput",
  example: { expectedVersion: 0 },
  data: ref("Shipment"),
  idempotent: true,
  failures: writeFailures,
  description:
    "Business owner only. This DELETE has a required JSON body and cancels rather than deleting history. Pending/assigned only; held packages require exception/return workflow. Maximum 4 KiB.",
});
add({
  method: "get",
  path: `${shipments}/{id}/exceptions`,
  id: "listShipmentExceptions",
  tag: "Shipment exceptions",
  summary: "Read private failure and return audit",
  response: page("ShipmentException", "ExceptionPagination"),
  parameters: [
    { ...cursorParameters[0]! },
    {
      name: "beforeVersion",
      in: "query",
      schema: integer({ minimum: 1, maximum: 2147483647 }),
      description:
        "Use nextBeforeVersion from previous page. This endpoint uses version pagination, NOT cursor. Unknown/duplicate parameters rejected.",
    },
  ],
  description:
    "Owning business or current assigned driver only; customer denied. Newest version first. Private actor IDs, notes and reasons must not be copied into public tracking views.",
});
add({
  method: "post",
  path: `${shipments}/{id}/exceptions`,
  id: "executeShipmentException",
  tag: "Shipment exceptions",
  summary: "Record failure, retry or return custody action",
  input: "ExceptionInput",
  example: {
    action: "fail",
    expectedVersion: 3,
    reason: "recipient_unavailable",
    note: "No recipient at address",
  },
  data: ref("Shipment"),
  idempotent: true,
  failures: writeFailures,
  description:
    "Maximum 4 KiB. fail: owner/current driver. retry, return_request, return_receive, cancel_failed: owner. return_start: current driver. retry allows at most three attempts; a picked-up failed package needs return custody resolved before retry. Return keeps status=failed with separate returnState. No refund, address change or return fee is performed. Conflicts=409; invalid exception transition/reason=422.",
});
add({
  method: "get",
  path: `${shipments}/{id}/delivery-code`,
  id: "getActiveDeliveryChallenge",
  tag: "Delivery confirmation",
  summary: "Read active delivery challenge metadata",
  data: ref("ActiveDeliveryChallenge"),
  description:
    "Owning business/current assigned driver. Returns current, unexpired, unlocked challenge only; otherwise 404. Never returns the code, hash or recipient email. Refresh metadata after a resend.",
});
add({
  method: "post",
  path: `${shipments}/{id}/delivery-code`,
  id: "issueDeliveryCode",
  tag: "Delivery confirmation",
  summary: "Email recipient a delivery confirmation code",
  input: "IssueDeliveryCodeInput",
  example: { expectedVersion: 4, recipientEmail: "recipient@example.test" },
  data: ref("DeliveryChallenge"),
  idempotent: true,
  failures: writeFailures,
  description:
    "Owning business only; out_for_delivery with an active fleet driver assigned. Maximum 2 KiB body. Response NEVER contains the code. Email code expires 20 minutes after issuance. Recipient changes advance version; use response.version. Resend revokes previous challenge. Minimum 1 minute between sends, max 3/hour/shipment and 60/hour/business; DELIVERY_RATE_LIMIT=409. Missing configuration=503 DELIVERY_UNAVAILABLE.",
});
add({
  method: "post",
  path: `${shipments}/{id}/confirm-delivery`,
  id: "confirmDelivery",
  tag: "Delivery confirmation",
  summary: "Confirm physical handover using recipient code",
  input: "ConfirmDeliveryInput",
  example: {
    expectedVersion: 5,
    challengeId: "challenge_example",
    code: "01234567",
  },
  data: {
    ...schemas.Shipment,
    description:
      "Delivered shipment; recipientEmail is always omitted from this driver response.",
  },
  idempotent: true,
  failures: writeFailures,
  description:
    "Assigned fleet driver only. Maximum 2 KiB. Successful confirmation marks delivered and records history atomically. Wrong attempts are recorded idempotently: retrying the same wrong key/body does not count another guess; a newly entered code needs a NEW key. Five distinct wrong attempts lock the challenge. Expired/revoked/locked=409 DELIVERY_CODE_UNAVAILABLE. No override/bypass route.",
});

const payments = `${prefix}/payments`;
add({
  method: "post",
  path: `${payments}/initialize`,
  id: "initializeCheckout",
  tag: "Payments",
  summary: "Create or replay Stripe sandbox checkout",
  input: "CheckoutInput",
  example: { shipmentId: "shipment_example" },
  data: ref("Checkout"),
  idempotent: true,
  failures: [...writeFailures, 502],
  description:
    "Owning business or linked customer. Maximum 4 KiB body. Sandbox only, NGN, one active checkout per shipment. Preserve returned reference and redirect to authorizationUrl. Return URL currently points to /customer/shipments even for a business caller; frontend must handle this existing contract. CHECKOUT_ALREADY_ACTIVE/CHECKOUT_CLOSED/NOT_PAYABLE/RECONCILIATION_REQUIRED=409. Never infer payment from the redirect.",
});
add({
  method: "get",
  path: `${payments}/verify/{reference}`,
  id: "verifyPayment",
  tag: "Payments",
  summary: "Verify checkout and reconcile payment state",
  data: ref("PaymentVerification"),
  failures: [401, 403, 404, 409, 429, 502, 503],
  description:
    "Owning business or linked customer. Reads provider and reconciles server state. paid means Stripe reports paid; applied means accepted against this shipment. requiresReview means operator attention; do not display settled success from paid alone. status is Stripe payment_status, not internal pending/success. Driver access denied.",
});
add({
  method: "post",
  path: `${payments}/{reference}/cancel`,
  id: "cancelCheckout",
  tag: "Payments",
  summary: "Request cancellation and reconcile checkout",
  data: ref("PaymentCancellation"),
  failures: [401, 403, 404, 429, 502, 503],
  description:
    "Owning business or linked customer. No JSON body or Idempotency-Key required. This reconciles/expires an unpaid checkout; it is NOT a payment refund. A 200 does not guarantee funds were not received; inspect checkoutState/requiresReview. On uncertainty verify the original reference before a new checkout.",
});
add({
  method: "post",
  path: `${payments}/webhook`,
  id: "receiveStripeWebhook",
  tag: "Provider callbacks",
  summary: "Receive signed Stripe sandbox events",
  public: true,
  response: text(),
  failures: [400, 503],
  description:
    "SERVER-TO-SERVER ONLY; frontend must never call this. Requires original raw Stripe JSON and Stripe-Signature; no Bearer auth. Maximum 256 KiB. Handles checkout.session.completed, async_payment_succeeded, expired, async_payment_failed; other verified events return OK. Signature tolerance 300 seconds; live events rejected. Responses are plain text.",
});
const webhook = paths[`${payments}/webhook`]!.post!;
webhook.parameters = [
  {
    name: "Stripe-Signature",
    in: "header",
    required: true,
    schema: text(),
    description:
      "Stripe-generated signature over the original unmodified request bytes.",
  },
];
webhook.requestBody = {
  required: true,
  content: {
    "application/json": {
      schema: object(
        {
          id: text(),
          object: text({ enum: ["event"] }),
          type: text(),
          created: integer(),
          livemode: { type: "boolean", enum: [false] },
          data: object({
            object: { type: "object", additionalProperties: true },
          }),
        },
        ["id", "object", "type", "created", "livemode", "data"],
        true,
      ),
    },
  },
};
for (const status of ["200", "400", "503"])
  webhook.responses[status] = {
    description: status === "200" ? "OK" : failures[status]!,
    content: { "text/plain": { schema: text() } },
  };

const notifications = `${prefix}/notifications`;
add({
  method: "get",
  path: notifications,
  id: "listNotifications",
  tag: "Notifications",
  summary: "Read own notifications",
  response: page("Notification"),
  parameters: cursorParameters,
  description:
    "All authenticated roles, own records only. Newest first with cursor pagination. metadata is a nullable JSON-encoded string. Notification delivery is not a Socket.IO notification stream.",
});
add({
  method: "patch",
  path: `${notifications}/read-all`,
  id: "markAllNotificationsRead",
  tag: "Notifications",
  summary: "Mark a batch of own unread notifications as read",
  data: object({
    updated: integer({ minimum: 0, maximum: 500 }),
    hasMore: boolean,
  }),
  description:
    "No body. Changes at most 500 rows per call. Repeat while hasMore=true, with appropriate UI progress; concurrent/new notifications can remain.",
});
add({
  method: "patch",
  path: `${notifications}/{id}/read`,
  id: "markNotificationRead",
  tag: "Notifications",
  summary: "Mark own notification as read",
  data: object({ id: text(), isRead: { type: "boolean", enum: [true] } }),
  description: "No body. Foreign and missing notifications both return 404.",
});
add({
  method: "delete",
  path: `${notifications}/{id}`,
  id: "deleteNotification",
  tag: "Notifications",
  summary: "Delete own notification",
  data: nullData,
  description:
    "No body. Deletes this notification only; foreign/missing returns 404.",
});
add({
  method: "get",
  path: `${prefix}/track/{trackingId}`,
  id: "getPublicTracking",
  tag: "Public tracking",
  summary: "Read limited public tracking",
  public: true,
  data: ref("PublicTracking"),
  failures: [400, 404, 429, 503],
  description:
    "No auth. Tracking ID: 1–64 letters/digits/_/-, normalized to uppercase; ANY query parameter is rejected. Returns status/times and latest 20 generic events only. No precise GPS, names, contacts, addresses, prices, notes or driver IDs. no-store and noindex,nofollow. Access to authenticated details requires a participant session.",
});

for (const [path, operationId, summary, schema] of [
  [
    "/health",
    "getServiceHealth",
    "Read service identity",
    object({
      status: text({ enum: ["ok"] }),
      service: text(),
      version: text(),
      timestamp: text({ format: "date-time" }),
    }),
  ],
  [
    "/health/live",
    "getLiveness",
    "Check process liveness",
    object({ status: text({ enum: ["ok"] }) }),
  ],
  [
    "/health/ready",
    "getReadiness",
    "Check database-backed readiness",
    object({ status: text({ enum: ["ready", "not_ready"] }) }),
  ],
  [
    "/health/release",
    "getReleaseIdentity",
    "Read deployment identity",
    object({ environment: text(), sha: text() }),
  ],
] as const) {
  paths[path] = {
    get: {
      operationId,
      tags: ["Operations"],
      summary,
      security: [],
      description:
        "Operational endpoint outside /api/v1. Readiness depends on database and drain state; Redis failure can still leave budget-protected application routes unavailable.",
      responses: {
        "200": json(schema, "Service response."),
        ...(path === "/health/ready"
          ? { "503": json(schema, "Not ready or draining.") }
          : {}),
      },
    },
  };
}
paths["/metrics"] = {
  get: {
    operationId: "getPrivateMetrics",
    tags: ["Operations"],
    summary: "Scrape private Prometheus metrics",
    description:
      "Operator only. Uses a separate METRICS_TOKEN, NOT a user access JWT. Disabled (404) when no token is configured. Not a frontend API.",
    security: [{ metricsToken: [] }],
    responses: Object.fromEntries(
      [200, 401, 404].map((status) => [
        status,
        {
          description:
            status === 200
              ? "Prometheus text exposition."
              : status === 401
                ? "Unauthorized"
                : "Not found",
          content: { "text/plain": { schema: text() } },
        },
      ]),
    ),
  },
};

export const openApiDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "IsoTrack Backend API",
    version: "1.0.0",
    description: `HTTP contract for IsoTrack private fleet delivery operations on this backend branch. Paths include /api/v1; the server URL is the backend origin, not the frontend URL. Sandbox payments only. Public driver registration, driver payouts, permanent account deletion, general refunds, file uploads and arbitrary shipment edits are not implemented.

Integration order: register/login → obtain role-specific profile → invite/enroll driver → create shipment → assign → progress status → issue recipient code → driver confirms → verify payment separately. Business manages shipments; customer is a linked account, recipient is an independent email identity.

Authentication: pass accessToken as Authorization: Bearer YOUR_ACCESS_TOKEN. Use credentials:include for login/refresh/logout. Refresh cookie is HttpOnly; exact trusted frontend Origin is required for refresh/logout. Backend-hosted Swagger cannot spoof that browser header. Use the frontend or curl for cookie flows. Authorize accepts the access token only. No GET /auth/me endpoint.

Writes: preserve the same Idempotency-Key and JSON for uncertain retries where required. Use latest expectedVersion for commands; reload and reassess on 409. Never hide conflicts with automatic new keys. Money is integer kobo (100 = NGN 1). Dates are ISO 8601 timestamps. Lists use opaque cursor pagination unless explicitly documented otherwise.

Errors reflect current behavior, including older Zod validation objects and role guards that return INTERNAL_SERVER_ERROR with HTTP 403. Branch on HTTP status and documented operation error codes; message is optional. Respect Retry-After. X-Request-Id is exposed for support. CORS only allows configured frontend origin; it does not grant authorization.

Socket.IO is a separate protocol at /socket.io, not an HTTP REST operation. Connect with auth:{token:accessToken}. Emit shipment:join / shipment:leave with a tracking ID STRING; acknowledgements are {ok:true} or {ok:false,code}. Server emits shipment:joined {trackingId}. Assigned drivers emit driver:location {trackingId,lat,lng,timestamp,heading?,speed?}; authorized subscribers receive accepted locations. timestamp is Unix milliseconds (30 seconds behind to 5 seconds ahead), heading is 0 inclusive to 360 exclusive, speed is 0..100. Coordinates use latitude -90..90, longitude -180..180. Unknown fields are rejected. Limits: five connections/user, 20 subscriptions/socket, ten requests/second and one in-flight event/socket. Handle UNAUTHORIZED, FORBIDDEN, INVALID_PAYLOAD, RATE_LIMITED, BUSY, SUBSCRIPTION_LIMIT, LOCATION_REJECTED and UNAVAILABLE acknowledgements and reconnect with a new token after refresh. Updates are volatile, not guaranteed history. Anonymous recipients cannot subscribe to precise GPS. Further workflow notes are in docs/api-reference.md.

The standalone documentation preview is read-only and needs no services. Starting the full API still requires its database/Redis configuration.`,
  },
  servers: [
    {
      url: "/",
      description:
        "Same backend origin serving this document. Paths already contain /api/v1.",
    },
  ],
  tags: [
    [
      "Authentication",
      "Login, rotating sessions and browser cookie requirements.",
    ],
    [
      "Account",
      "Personal profile, credential changes and account deactivation.",
    ],
    ["Account recovery", "Single-use recovery and verification email flows."],
    [
      "Fleet invitations",
      "Invitation-only driver enrollment into one private fleet.",
    ],
    ["Drivers", "Own fleet reads and driver self-service."],
    ["Business", "Owner profile, preferences and operational aggregates."],
    ["Shipments", "Scoped shipment creation and reads."],
    ["Shipment commands", "Versioned idempotent assignment and progression."],
    [
      "Shipment exceptions",
      "Private failure, retry and return custody workflows.",
    ],
    [
      "Delivery confirmation",
      "Recipient email code issuance and driver handover confirmation.",
    ],
    [
      "Payments",
      "Stripe sandbox checkout and verification; no driver payouts.",
    ],
    ["Notifications", "Own in-app notification records and read states."],
    ["Public tracking", "Minimal unauthenticated shipment tracking."],
    ["Provider callbacks", "Signed provider callbacks; not browser APIs."],
    [
      "Operations",
      "Service probes and private operator metrics outside /api/v1.",
    ],
  ].map(([name, description]) => ({ name: name!, description: description! })),
  paths,
  components: {
    securitySchemes: {
      metricsToken: {
        type: "http",
        scheme: "bearer",
        description:
          "Operator METRICS_TOKEN; unrelated to user access tokens. Do not share it with frontend code.",
      },
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Paste accessToken from login/refresh, without the Bearer prefix. Server rechecks active session, current account and permissions.",
      },
      refreshCookie: {
        type: "apiKey",
        in: "cookie",
        name: "iso_refresh_token",
        description:
          "Browser-managed HttpOnly cookie. Requires exact trusted Origin on refresh/logout. Swagger cannot manually set Cookie headers.",
      },
    },
    schemas,
  },
};
