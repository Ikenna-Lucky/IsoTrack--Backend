import type { OpenAPIV3 } from "openapi-types";

type Schema = OpenAPIV3.SchemaObject;
type Field = Schema | OpenAPIV3.ReferenceObject;
export const ref = (name: string): OpenAPIV3.ReferenceObject => ({
  $ref: `#/components/schemas/${name}`,
});
export const object = (
  properties: Record<string, Field>,
  required: string[] = Object.keys(properties),
  additionalProperties = false,
): Schema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties,
});
export const array = (items: Field): Schema => ({ type: "array", items });
export const text = (options: Omit<Schema, "type"> = {}): Schema => ({
  type: "string",
  ...options,
});
export const integer = (options: Omit<Schema, "type"> = {}): Schema => ({
  type: "integer",
  ...options,
});
export const boolean: Schema = { type: "boolean" };
export const date = (nullable = false): Schema =>
  text({ format: "date-time", nullable });
const nullableText = () => text({ nullable: true });
const id = text({ minLength: 1, maxLength: 128 });
const email = text({
  format: "email",
  maxLength: 254,
  description:
    "Trimmed and normalized to lowercase on account/invitation input.",
});
const password = text({
  format: "password",
  minLength: 8,
  maxLength: 72,
  pattern: "(?=[\\s\\S]*[A-Z])(?=[\\s\\S]*[0-9])",
  description:
    "At least one uppercase ASCII letter and one digit. Also limited to 72 UTF-8 bytes; character count alone is insufficient.",
});
const version = integer({
  minimum: 0,
  maximum: 2147483646,
  description:
    "Current shipment.version from the latest read. Reload on SHIPMENT_VERSION_CONFLICT; reassess the action before submitting a new request.",
});
const vehicleType = text({ enum: ["bike", "car", "van", "truck"] });
const driverStatus = text({ enum: ["available", "on_delivery", "offline"] });
export const shipmentStatuses = [
  "pending",
  "assigned",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "failed",
  "cancelled",
];
const shipmentStatus = text({ enum: shipmentStatuses });
const failureReason = text({
  enum: [
    "recipient_unavailable",
    "recipient_refused",
    "address_incorrect",
    "recipient_code_unavailable",
    "package_damaged",
    "vehicle_issue",
    "other",
  ],
});
const note = text({
  maxLength: 1000,
  default: "",
  description: "Trimmed. Required and nonempty when failure reason is other.",
});
const coordinates = object({
  lat: { type: "number", minimum: -90, maximum: 90 },
  lng: { type: "number", minimum: -180, maximum: 180 },
});
const address = object(
  {
    street: text({ minLength: 1, maxLength: 300 }),
    city: text({ minLength: 1, maxLength: 100 }),
    state: text({ minLength: 1, maxLength: 100, default: "Lagos" }),
  },
  ["street", "city"],
);
const contact = object({
  id,
  name: text(),
  email,
  phone: nullableText(),
  avatar: nullableText(),
});
const user = object({
  ...contact.properties,
  role: text({ enum: ["business", "driver", "customer"] }),
  emergencyContact: nullableText(),
  isEmailVerified: boolean,
  isActive: boolean,
  createdAt: date(),
  updatedAt: date(),
});
const vehicleFields = {
  vehicleType,
  vehiclePlate: text({ minLength: 3, maxLength: 20 }),
  vehicleModel: text({ maxLength: 60, nullable: true }),
  vehicleColor: text({ maxLength: 30, nullable: true }),
  vehicleYear: text({ maxLength: 4, nullable: true }),
  vehicleInsurance: text({ maxLength: 60, nullable: true }),
};
const driverFields = {
  id,
  businessId: text({ nullable: true }),
  userId: id,
  ...vehicleFields,
  status: driverStatus,
  currentLocation: { ...coordinates, nullable: true },
  rating: { type: "number" as const },
  totalDeliveries: integer(),
  createdAt: date(),
  updatedAt: date(),
};
const preferences = object(
  {
    timezone: text({ example: "Africa/Lagos" }),
    currency: text({
      example: "NGN",
      description: "Display preference only. Checkout remains NGN.",
    }),
    language: text({ example: "en" }),
    dateFormat: text({ example: "DD/MM/YYYY" }),
    compactView: boolean,
    autoRefresh: boolean,
  },
  [],
);
const notificationPreferences = (names: string[], firstChannel: string) =>
  object(
    Object.fromEntries(
      names.map((name) => [
        name,
        object({ [firstChannel]: boolean, email: boolean }),
      ]),
    ),
    [],
  );
const businessNotices = object(
  Object.fromEntries(
    [
      "shipmentCreated",
      "driverAssigned",
      "pickedUp",
      "outForDelivery",
      "delivered",
      "failed",
      "driverOnline",
      "weeklyReport",
    ].map((name) => [name, object({ email: boolean, sms: boolean })]),
  ),
  [],
);
const driverNotices = notificationPreferences(
  [
    "newDelivery",
    "pickupReminder",
    "deliveryComplete",
    "deliveryFailed",
    "customerMessage",
    "ratingReceived",
    "payoutProcessed",
    "weeklyReport",
  ],
  "push",
);
const shipment = object(
  {
    id,
    trackingId: text(),
    status: shipmentStatus,
    version: integer({ minimum: 0 }),
    businessId: id,
    driverId: nullableText(),
    customerId: nullableText(),
    recipientEmail: text({
      format: "email",
      nullable: true,
      description:
        "Included only for the owning business. Omitted for drivers/customers. Independent of linked customer account.",
    }),
    description: text(),
    weightKg: { type: "number" },
    dimensions: {
      type: "object",
      nullable: true,
      additionalProperties: true,
      description: "Legacy JSON dimensions; not accepted by shipment creation.",
    },
    pickupAddress: { ...address, required: ["street", "city", "state"] },
    deliveryAddress: { ...address, required: ["street", "city", "state"] },
    currentLocation: {
      ...coordinates,
      nullable: true,
      additionalProperties: true,
    },
    scheduledPickup: date(true),
    actualPickup: date(true),
    estimatedDelivery: date(true),
    actualDelivery: date(true),
    priceKobo: integer({
      description: "Integer NGN minor units: 100 kobo = 1 naira.",
    }),
    isPaid: boolean,
    failureReason: {
      ...failureReason,
      enum: [...failureReason.enum!, null],
      nullable: true,
    },
    failedAt: date(true),
    attemptNumber: integer({ minimum: 1, maximum: 3 }),
    returnState: text({
      enum: ["none", "requested", "in_transit", "received"],
    }),
    returnedAt: date(true),
    createdAt: date(),
    updatedAt: date(),
  },
  [
    "id",
    "trackingId",
    "status",
    "version",
    "businessId",
    "driverId",
    "customerId",
    "description",
    "weightKg",
    "dimensions",
    "pickupAddress",
    "deliveryAddress",
    "currentLocation",
    "scheduledPickup",
    "actualPickup",
    "estimatedDelivery",
    "actualDelivery",
    "priceKobo",
    "isPaid",
    "failureReason",
    "failedAt",
    "attemptNumber",
    "returnState",
    "returnedAt",
    "createdAt",
    "updatedAt",
  ],
);
const event = object({
  id,
  shipmentId: id,
  status: shipmentStatus,
  message: text(),
  location: { ...coordinates, nullable: true, additionalProperties: true },
  createdAt: date(),
});
const relatedDriver = {
  ...object({ id, vehicleType, vehiclePlate: text(), user: contact }),
  nullable: true,
};
const relatedCustomer = { ...contact, nullable: true };
const readRelations = { customer: relatedCustomer, driver: relatedDriver };
const payment = object({
  id,
  amountKobo: integer(),
  status: text({ enum: ["pending", "success", "failed", "refunded"] }),
  channel: nullableText(),
  paidAt: date(true),
  createdAt: date(),
});
const checkoutState = text({
  enum: [
    "untracked",
    "creating",
    "open",
    "processing",
    "expired",
    "failed",
    "settled",
    "review",
  ],
});

export const schemas: Record<string, Schema> = {
  Error: object(
    {
      success: { type: "boolean", enum: [false] },
      error: text(),
      message: text(),
      details: { type: "object", additionalProperties: text() },
    },
    ["success"],
  ),
  ValidationError: object({
    success: { type: "boolean", enum: [false] },
    error: object({
      name: text({ enum: ["ZodError"] }),
      issues: array(
        object(
          {
            code: text(),
            path: array({ oneOf: [text(), integer()] }),
            message: text(),
          },
          ["code", "path", "message"],
          true,
        ),
      ),
    }),
  }),
  Address: address,
  User: user,
  Session: object({
    user: ref("User"),
    accessToken: text({
      description:
        "Short-lived Bearer JWT. Keep in memory. Refresh token is only in the HttpOnly cookie.",
    }),
  }),
  LoginInput: object({
    email,
    password: text({
      minLength: 1,
      maxLength: 128,
      format: "password",
      description: "Maximum 512 UTF-8 bytes.",
    }),
  }),
  RegisterInput: object(
    {
      name: text({ minLength: 2, maxLength: 100 }),
      email,
      password,
      role: text({
        enum: ["business", "customer", "driver"],
        description:
          "Use business or customer. driver is recognized but always rejected with 403; use invitation acceptance instead.",
      }),
      phone: text({ pattern: "^(\\+?[1-9]\\d{6,14})?$" }),
      businessName: text({
        minLength: 2,
        maxLength: 100,
        description:
          "Optional for business; defaults to the person's name. Ignored for customers.",
      }),
      vehicleType: {
        ...vehicleType,
        description:
          "Legacy accepted field; does not enable driver registration.",
      },
      vehiclePlate: text({
        minLength: 3,
        maxLength: 20,
        description:
          "Legacy accepted field; does not enable driver registration.",
      }),
    },
    ["name", "email", "password", "role"],
  ),
  ProfileInput: object(
    {
      name: text({ minLength: 2, maxLength: 100 }),
      phone: text({ pattern: "^(\\+?[1-9]\\d{6,14})?$", nullable: true }),
      avatar: text({
        nullable: true,
        description:
          "Stored string; empty string or null clears it. URL format is not validated by this endpoint.",
      }),
      emergencyContact: text({ maxLength: 20, nullable: true }),
    },
    [],
    true,
  ),
  PasswordInput: object(
    {
      currentPassword: text({ minLength: 1, format: "password" }),
      newPassword: password,
    },
    ["currentPassword", "newPassword"],
    true,
  ),
  DeactivateInput: object({
    currentPassword: text({
      minLength: 1,
      maxLength: 72,
      format: "password",
      description: "Maximum 72 UTF-8 bytes.",
    }),
  }),
  EmailInput: object({ email }),
  TokenInput: object({
    token: text({
      minLength: 87,
      maxLength: 87,
      description: "Single-use token from the recovery/verification email.",
    }),
  }),
  ResetPasswordInput: object({
    token: text({ minLength: 87, maxLength: 87 }),
    newPassword: password,
  }),
  InvitationInput: object({ email }),
  AcceptInvitationInput: object({
    token: text({ pattern: "^[A-Za-z0-9_-]{43}$" }),
    email,
    name: text({ minLength: 2, maxLength: 100 }),
    password,
    vehicleType,
    vehiclePlate: text({ minLength: 3, maxLength: 20 }),
  }),
  AcceptExistingInvitationInput: object({
    token: text({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  }),
  Membership: object({ userId: id, driverId: id, businessId: id }),
  Invitation: object({
    id,
    email,
    expiresAt: date(),
    createdAt: date(),
    acceptedAt: date(true),
    revokedAt: date(true),
  }),
  CreatedInvitation: object({
    id,
    email,
    expiresAt: date(),
    token: text({
      description:
        "Shown once. Owner shares it privately with the named recipient; it is not returned by listing.",
    }),
  }),
  VehicleInput: object(vehicleFields, [], true),
  DriverStatusInput: object({ status: driverStatus }, ["status"], true),
  CoordinatesInput: coordinates,
  DriverNotifications: {
    ...driverNotices,
    additionalProperties: true,
    description:
      "Optional event keys; supplied event requires push and email booleans. Stored preferences do not guarantee channel implementation.",
  },
  BusinessNotifications: {
    ...businessNotices,
    additionalProperties: true,
    description:
      "Optional event keys; supplied event requires email and sms booleans. Stored preferences do not guarantee channel implementation.",
  },
  BusinessPreferences: { ...preferences, additionalProperties: true },
  BusinessProfileInput: object(
    {
      businessName: text({ minLength: 2, maxLength: 100 }),
      address: object(
        { street: text(), city: text(), state: text() },
        ["street", "city", "state"],
        true,
      ),
    },
    [],
    true,
  ),
  Business: object({
    id,
    userId: id,
    businessName: text(),
    logo: nullableText(),
    address: { type: "object", nullable: true, additionalProperties: true },
    notificationPreferences: { ...businessNotices, nullable: true },
    preferences: { ...preferences, nullable: true },
    createdAt: date(),
    updatedAt: date(),
  }),
  BusinessProfile: object({
    id,
    userId: id,
    businessName: text(),
    logo: nullableText(),
    address: { type: "object", nullable: true, additionalProperties: true },
    notificationPreferences: { ...businessNotices, nullable: true },
    preferences: { ...preferences, nullable: true },
    createdAt: date(),
    updatedAt: date(),
    user: ref("User"),
  }),
  Driver: object({
    ...driverFields,
    notificationPreferences: { ...driverNotices, nullable: true },
  }),
  DriverProfile: object({
    ...driverFields,
    notificationPreferences: { ...driverNotices, nullable: true },
    user: ref("User"),
  }),
  FleetDriver: object({
    ...driverFields,
    user: object({ ...contact.properties, isActive: boolean }),
  }),
  ShipmentInput: object(
    {
      recipientEmail: email,
      description: text({ minLength: 1, maxLength: 2000 }),
      weightKg: {
        type: "number",
        minimum: 0,
        exclusiveMinimum: true,
        maximum: 1000000,
      },
      pickupAddress: ref("Address"),
      deliveryAddress: ref("Address"),
      customerId: text({ minLength: 1, maxLength: 64 }),
      customerEmail: text({
        format: "email",
        description:
          "Links an existing active customer account. Optional; does not create an account. If both ID and email are sent they must match.",
      }),
      scheduledPickup: text({
        format: "date-time",
        description:
          "ISO 8601 timestamp with timezone offset; normalized to UTC.",
      }),
      priceKobo: integer({ minimum: 1, maximum: 2147483647 }),
    },
    [
      "description",
      "weightKg",
      "pickupAddress",
      "deliveryAddress",
      "priceKobo",
    ],
  ),
  Shipment: shipment,
  ShipmentListItem: object(
    {
      ...shipment.properties,
      ...readRelations,
      events: array(ref("ShipmentEvent")),
    },
    [...shipment.required!, "customer", "driver", "events"],
  ),
  ShipmentDetail: object(
    {
      ...shipment.properties,
      ...readRelations,
      payment: {
        ...payment,
        nullable: true,
        description: "Latest payment summary; always null for drivers.",
      },
      events: { ...array(ref("ShipmentEvent")), maxItems: 50 },
      eventsTruncated: boolean,
    },
    [
      ...shipment.required!,
      "customer",
      "driver",
      "payment",
      "events",
      "eventsTruncated",
    ],
  ),
  ShipmentEvent: event,
  AssignInput: object({ expectedVersion: version, driverId: id }),
  StatusInput: object(
    {
      expectedVersion: version,
      status: text({
        enum: [
          "pending",
          "picked_up",
          "in_transit",
          "out_for_delivery",
          "delivered",
          "failed",
          "cancelled",
        ],
        description:
          "Schema accepts these values; business rules further restrict transitions. New delivered commands return DELIVERY_CONFIRMATION_REQUIRED. New pending/failed commands require the exceptions endpoint.",
      }),
      note,
    },
    ["expectedVersion", "status"],
  ),
  CancelInput: object({ expectedVersion: version }),
  ExceptionInput: {
    oneOf: [
      object(
        {
          action: text({ enum: ["fail"] }),
          expectedVersion: version,
          reason: {
            ...failureReason,
            enum: failureReason.enum!.filter((reason) => reason !== "other"),
          },
          note,
        },
        ["action", "expectedVersion", "reason"],
      ),
      object(
        {
          action: text({ enum: ["fail"] }),
          expectedVersion: version,
          reason: text({ enum: ["other"] }),
          note: { ...note, minLength: 1, pattern: "\\S" },
        },
        ["action", "expectedVersion", "reason", "note"],
      ),
      object(
        {
          action: text({
            enum: [
              "retry",
              "return_request",
              "return_start",
              "return_receive",
              "cancel_failed",
            ],
          }),
          expectedVersion: version,
          note,
        },
        ["action", "expectedVersion"],
      ),
    ],
    description:
      "fail: owner/assigned driver. retry, return_request, return_receive, cancel_failed: owner. return_start: assigned driver. reason=other requires a nonempty note. Retry permits at most three total attempts; return custody must be resolved first.",
  },
  ShipmentException: object({
    id,
    shipmentId: id,
    actorId: id,
    action: text({
      enum: [
        "fail",
        "retry",
        "return_request",
        "return_start",
        "return_receive",
        "cancel_failed",
      ],
    }),
    reason: {
      ...failureReason,
      enum: [...failureReason.enum!, null],
      nullable: true,
    },
    note: text(),
    version: integer(),
    attemptNumber: integer(),
    createdAt: date(),
  }),
  IssueDeliveryCodeInput: object({
    expectedVersion: { ...version, maximum: 2147483645 },
    recipientEmail: email,
  }),
  ConfirmDeliveryInput: object({
    expectedVersion: { ...version, maximum: 2147483645 },
    challengeId: text({ pattern: "^[A-Za-z0-9_-]{1,128}$" }),
    code: text({
      pattern: "^\\d{8}$",
      description:
        "Eight decimal characters; preserve leading zeros. Never log or persist this code in the frontend.",
    }),
  }),
  DeliveryChallenge: object({
    challengeId: id,
    version: integer(),
    expiresAt: date(),
  }),
  ActiveDeliveryChallenge: object({
    challengeId: id,
    version: integer(),
    expiresAt: date(),
    deliveryState: text({
      enum: ["pending", "processing", "sent", "skipped", "dead"],
      description:
        "Email dispatch state; sent does not prove recipient receipt.",
    }),
  }),
  CheckoutInput: object({ shipmentId: text({ minLength: 1, maxLength: 64 }) }),
  Checkout: object({
    reference: text(),
    authorizationUrl: text({
      format: "uri",
      description:
        "HTTPS Stripe-hosted checkout URL. Preserve reference before redirecting.",
    }),
    sessionId: text(),
    amountKobo: integer(),
  }),
  PaymentVerification: object(
    {
      paid: boolean,
      reference: text(),
      channel: text({ enum: ["stripe_checkout"] }),
      status: text({ enum: ["paid", "unpaid", "no_payment_required"] }),
      applied: boolean,
      checkoutState,
      requiresReview: boolean,
    },
    ["paid", "reference", "channel", "status", "applied", "requiresReview"],
  ),
  PaymentCancellation: object(
    { reference: text(), checkoutState, requiresReview: boolean },
    ["reference", "requiresReview"],
  ),
  CursorPagination: object({
    limit: integer({ minimum: 1, maximum: 50 }),
    hasMore: boolean,
    nextCursor: text({ nullable: true }),
  }),
  ExceptionPagination: object({
    limit: integer({ minimum: 1, maximum: 50 }),
    hasMore: boolean,
    nextBeforeVersion: integer({ nullable: true }),
  }),
  Notification: object({
    id,
    userId: id,
    type: text({ enum: ["email", "sms", "push"] }),
    title: text(),
    message: text(),
    isRead: boolean,
    status: text({ enum: ["pending", "sent", "failed"] }),
    metadata: text({
      nullable: true,
      description: "JSON encoded as a string, not an object.",
    }),
    createdAt: date(),
  }),
  Analytics: object({
    statusBreakdown: {
      type: "object",
      additionalProperties: integer(),
      description: "Counts keyed by status; zero-count statuses may be absent.",
    },
    totalShipments: integer(),
    totalRevenueKobo: integer({
      description:
        "Sum of all shipment prices, including unpaid/cancelled shipments. Not settled revenue or driver earnings.",
    }),
    recentShipments: {
      ...array(
        object({ ...shipment.properties, ...readRelations }, [
          ...shipment.required!,
          "customer",
          "driver",
        ]),
      ),
      maxItems: 10,
    },
  }),
  PublicTracking: object({
    trackingId: text(),
    status: shipmentStatus,
    scheduledPickup: date(true),
    estimatedDelivery: date(true),
    actualDelivery: date(true),
    events: {
      ...array(
        object({ status: shipmentStatus, createdAt: date(), message: text() }),
      ),
      maxItems: 20,
    },
    eventsTruncated: boolean,
  }),
};

// Synthetic examples describe wire shapes; these are not shared accounts or tokens.
const exampleTime = "2026-11-12T10:00:00.000Z";
const contactExample = {
  id: "user_example",
  name: "Ada Okafor",
  email: "ada@example.test",
  phone: "+2348012345678",
  avatar: null,
};
const userExample = {
  ...contactExample,
  role: "business",
  emergencyContact: null,
  isEmailVerified: false,
  isActive: true,
  createdAt: exampleTime,
  updatedAt: exampleTime,
};
const driverExample = {
  id: "driver_example",
  businessId: "business_example",
  userId: "driver_user_example",
  vehicleType: "bike",
  vehiclePlate: "LAG-123AB",
  vehicleModel: null,
  vehicleColor: null,
  vehicleYear: null,
  vehicleInsurance: null,
  notificationPreferences: null,
  status: "available",
  currentLocation: null,
  rating: 5,
  totalDeliveries: 0,
  createdAt: exampleTime,
  updatedAt: exampleTime,
};
const businessExample = {
  id: "business_example",
  userId: "user_example",
  businessName: "Ada Deliveries",
  logo: null,
  address: null,
  notificationPreferences: null,
  preferences: null,
  createdAt: exampleTime,
  updatedAt: exampleTime,
};
const shipmentExample = {
  id: "shipment_example",
  trackingId: "IST-EXAMPLE",
  status: "pending",
  version: 0,
  businessId: "business_example",
  driverId: null,
  customerId: null,
  recipientEmail: "recipient@example.test",
  description: "Box of books",
  weightKg: 2.5,
  dimensions: null,
  pickupAddress: { street: "12 Example Street", city: "Ikeja", state: "Lagos" },
  deliveryAddress: { street: "8 Sample Road", city: "Yaba", state: "Lagos" },
  currentLocation: null,
  scheduledPickup: null,
  actualPickup: null,
  estimatedDelivery: null,
  actualDelivery: null,
  priceKobo: 250000,
  isPaid: false,
  failureReason: null,
  failedAt: null,
  attemptNumber: 1,
  returnState: "none",
  returnedAt: null,
  createdAt: exampleTime,
  updatedAt: exampleTime,
};
const eventExample = {
  id: "event_example",
  shipmentId: "shipment_example",
  status: "pending",
  message: "Shipment created",
  location: null,
  createdAt: exampleTime,
};
const challengeExample = {
  challengeId: "challenge_example",
  version: 5,
  expiresAt: "2026-11-12T10:20:00.000Z",
};
const examples: Record<string, unknown> = {
  User: userExample,
  Session: { user: userExample, accessToken: "example-access-jwt-from-login" },
  Driver: driverExample,
  DriverProfile: {
    ...driverExample,
    user: {
      ...userExample,
      id: "driver_user_example",
      name: "Tunde Bello",
      email: "driver@example.test",
      role: "driver",
    },
  },
  FleetDriver: {
    ...Object.fromEntries(
      Object.entries(driverExample).filter(
        ([key]) => key !== "notificationPreferences",
      ),
    ),
    user: {
      ...contactExample,
      id: "driver_user_example",
      name: "Tunde Bello",
      email: "driver@example.test",
      isActive: true,
    },
  },
  Business: businessExample,
  BusinessProfile: { ...businessExample, user: userExample },
  BusinessPreferences: {
    timezone: "Africa/Lagos",
    currency: "NGN",
    language: "en",
    dateFormat: "DD/MM/YYYY",
    compactView: false,
    autoRefresh: true,
  },
  BusinessNotifications: { delivered: { email: true, sms: false } },
  DriverNotifications: { newDelivery: { push: true, email: true } },
  Shipment: shipmentExample,
  ShipmentListItem: {
    ...shipmentExample,
    customer: null,
    driver: null,
    events: [],
  },
  ShipmentDetail: {
    ...shipmentExample,
    customer: null,
    driver: null,
    payment: null,
    events: [eventExample],
    eventsTruncated: false,
  },
  ShipmentEvent: eventExample,
  ShipmentException: {
    id: "exception_example",
    shipmentId: "shipment_example",
    actorId: "driver_user_example",
    action: "fail",
    reason: "recipient_unavailable",
    note: "No recipient at address",
    version: 5,
    attemptNumber: 1,
    createdAt: exampleTime,
  },
  DeliveryChallenge: challengeExample,
  ActiveDeliveryChallenge: { ...challengeExample, deliveryState: "sent" },
  Membership: {
    userId: "driver_user_example",
    driverId: "driver_example",
    businessId: "business_example",
  },
  CreatedInvitation: {
    id: "invitation_example",
    email: "driver@example.test",
    expiresAt: "2026-11-14T10:00:00.000Z",
    token: "A".repeat(43),
  },
  Invitation: {
    id: "invitation_example",
    email: "driver@example.test",
    expiresAt: "2026-11-14T10:00:00.000Z",
    createdAt: exampleTime,
    acceptedAt: null,
    revokedAt: null,
  },
  Checkout: {
    reference: "IST-PAY-example",
    authorizationUrl: "https://checkout.stripe.com/c/pay/cs_test_example",
    sessionId: "cs_test_example",
    amountKobo: 250000,
  },
  PaymentVerification: {
    paid: true,
    reference: "IST-PAY-example",
    channel: "stripe_checkout",
    status: "paid",
    applied: true,
    checkoutState: "settled",
    requiresReview: false,
  },
  PaymentCancellation: {
    reference: "IST-PAY-example",
    checkoutState: "expired",
    requiresReview: false,
  },
  CursorPagination: { limit: 20, hasMore: false, nextCursor: null },
  ExceptionPagination: { limit: 20, hasMore: false, nextBeforeVersion: null },
  Notification: {
    id: "notification_example",
    userId: "user_example",
    type: "push",
    title: "Shipment created",
    message: "Shipment created",
    isRead: false,
    status: "pending",
    metadata: '{"shipmentId":"shipment_example"}',
    createdAt: exampleTime,
  },
  PublicTracking: {
    trackingId: "IST-EXAMPLE",
    status: "pending",
    scheduledPickup: null,
    estimatedDelivery: null,
    actualDelivery: null,
    events: [
      {
        status: "pending",
        createdAt: exampleTime,
        message: "Shipment created",
      },
    ],
    eventsTruncated: false,
  },
  Analytics: {
    statusBreakdown: { pending: 1 },
    totalShipments: 1,
    totalRevenueKobo: 250000,
    recentShipments: [{ ...shipmentExample, customer: null, driver: null }],
  },
  TokenInput: { token: "A".repeat(87) },
  ResetPasswordInput: {
    token: "A".repeat(87),
    newPassword: "ReplacementPass123",
  },
};
for (const [name, example] of Object.entries(examples))
  schemas[name]!.example = example;
