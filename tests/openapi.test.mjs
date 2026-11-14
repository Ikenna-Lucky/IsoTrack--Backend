import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import SwaggerParser from "@apidevtools/swagger-parser";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { openApiDocument } from "../src/openapi/document.ts";
import { createApiDocsRouter } from "../src/routes/api-docs.ts";
import { createSessionRouter } from "../src/routes/sessions.ts";
import { createShipmentListRouter } from "../src/routes/shipment-list.ts";
import { createShipmentDetailRouter } from "../src/routes/shipment-reads.ts";
import { createShipmentCommandRouter } from "../src/routes/shipment-commands.ts";
import { createShipmentExceptionRouter } from "../src/routes/shipment-exceptions.ts";
import { createDeliveryRouter } from "../src/routes/delivery.ts";
import {
  createCollectionRouter,
  createNotificationMutationRouter,
} from "../src/routes/collections.ts";
import { createPublicTrackingRouter } from "../src/routes/public-tracking.ts";
import { shipmentInput, checkoutInput } from "../src/lib/write-inputs.ts";

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat("password", true);
// OpenAPI 3.0 uses boolean exclusiveMinimum/Maximum; JSON Schema uses numeric bounds.
function jsonSchema(value) {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, jsonSchema(item)]),
  );
  for (const [exclusive, inclusive] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof result[exclusive] === "boolean") {
      if (result[exclusive]) {
        result[exclusive] = result[inclusive];
        delete result[inclusive];
      } else delete result[exclusive];
    }
  }
  return result;
}
ajv.addSchema(
  jsonSchema({ $id: "isotrack", components: openApiDocument.components }),
);
const validate = (schema, value) => {
  const check = ajv.compile(
    jsonSchema({ ...schema, components: openApiDocument.components }),
  );
  assert.equal(check(value), true, JSON.stringify(check.errors));
};
const responseBody = async (path, method, response) => {
  const contract =
    openApiDocument.paths[path][method].responses[response.status];
  assert.ok(contract, `Undocumented ${method} ${path}: ${response.status}`);
  const body = await response.json();
  validate(contract.content["application/json"].schema, body);
  return body;
};
const source = (path) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("OpenAPI is structurally valid, uniquely named and exported without drift", async () => {
  await SwaggerParser.validate(structuredClone(openApiDocument));
  assert.deepEqual(
    JSON.parse(
      readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"),
    ),
    openApiDocument,
  );
  const ids = Object.values(openApiDocument.paths).flatMap((path) =>
    Object.values(path).map((operation) => operation.operationId),
  );
  assert.equal(new Set(ids).size, ids.length);
  for (const schema of Object.values(openApiDocument.components.schemas)) {
    if (schema.example !== undefined) validate(schema, schema.example);
  }
  for (const path of Object.values(openApiDocument.paths))
    for (const operation of Object.values(path)) {
      assert.ok(operation.description);
      const media = operation.requestBody?.content["application/json"];
      if (media?.example) validate(media.schema, media.example);
      for (const response of Object.values(operation.responses)) {
        const media = response.content?.["application/json"];
        if (media?.example) validate(media.schema, media.example);
      }
    }
});

test("every current HTTP route has a contract, and documented routes exist", () => {
  const entrypoint = ts.createSourceFile(
    "index.ts",
    source("index.ts"),
    ts.ScriptTarget.Latest,
    true,
  );
  const mounted = new Set();
  let mountedV1 = false;
  const inspectMount = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "route" &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      if (node.expression.expression.getText(entrypoint) === "v1")
        mounted.add(node.arguments[0].text);
      if (
        node.expression.expression.getText(entrypoint) === "app" &&
        node.arguments[1]?.getText(entrypoint) === "v1"
      )
        mountedV1 = node.arguments[0].text === "/api/v1";
    }
    ts.forEachChild(node, inspectMount);
  };
  inspectMount(entrypoint);
  assert.equal(
    mountedV1,
    true,
    "The OpenAPI API prefix must match the mounted application",
  );
  const documentedGroups = new Set(
    Object.keys(openApiDocument.paths)
      .filter((path) => path.startsWith("/api/v1/"))
      .map((path) => `/${path.split("/")[3]}`),
  );
  assert.deepEqual([...mounted].sort(), [...documentedGroups].sort());
  const groups = {
    auth: "/auth",
    "public-auth": "/auth",
    sessions: "/auth",
    "account-actions": "/auth",
    "account-deactivation": "/auth",
    business: "/business",
    drivers: "/drivers",
    "driver-invitations": "/driver-invitations",
    "existing-driver-invitation": "/driver-invitations",
    shipments: "/shipments",
    "shipment-list": "/shipments",
    "shipment-commands": "/shipments",
    "shipment-exceptions": "/shipments",
    delivery: "/shipments",
    payments: "/payments",
    "stripe-webhook": "/payments",
    notifications: "/notifications",
    tracking: "/track",
    "public-tracking": "/track",
  };
  const actual = new Set();
  for (const filename of readdirSync(
    new URL("../src/routes/", import.meta.url),
  )) {
    if (!filename.endsWith(".ts") || filename === "api-docs.ts") continue;
    const module = filename.slice(0, -3);
    const tree = ts.createSourceFile(
      filename,
      source(`routes/${filename}`),
      ts.ScriptTarget.Latest,
      true,
    );
    const walk = (node, factory) => {
      if (ts.isFunctionDeclaration(node)) factory = node.name?.text;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text.toLowerCase();
        if (["get", "post", "patch", "delete"].includes(method)) {
          const receiver = node.expression.expression.getText(tree);
          // Only Hono receivers; exclude request/header access and maps.
          if (
            [
              "app",
              "router",
              "authRouter",
              "businessRouter",
              "driversRouter",
              "driverInvitationsRouter",
              "paymentsRouter",
            ].includes(receiver)
          ) {
            const argument = node.arguments[0];
            let entries;
            if (ts.isStringLiteral(argument)) {
              const group =
                module === "shipment-reads"
                  ? factory === "createBusinessAnalyticsRouter"
                    ? "/business"
                    : "/shipments"
                  : module === "idempotent-writes"
                    ? factory === "createCheckoutInitializationRouter"
                      ? "/payments"
                      : "/shipments"
                    : module === "collections"
                      ? "/notifications"
                      : groups[module];
              assert.ok(group, `Map new route module ${module}`);
              entries = [group + (argument.text === "/" ? "" : argument.text)];
            } else if (module === "public-auth")
              entries = ["/auth/login", "/auth/register"];
            else if (module === "account-actions")
              entries = [
                "/auth/forgot-password",
                "/auth/reset-password",
                "/auth/verification/request",
                "/auth/verification/confirm",
              ];
            else if (
              module === "collections" &&
              factory === "createCollectionRouter"
            )
              entries = ["/drivers", "/drivers/available", "/notifications"];
            else assert.fail(`Resolve dynamic ${method} route in ${module}`);
            for (const path of entries)
              actual.add(
                `${method} /api/v1${path.replace(/:([A-Za-z]+)/g, "{$1}")}`,
              );
          }
        }
      }
      ts.forEachChild(node, (child) => walk(child, factory));
    };
    walk(tree);
  }
  for (const module of ["health", "release"]) {
    const tree = ts.createSourceFile(
      module,
      source(`observability/${module}.ts`),
      ts.ScriptTarget.Latest,
      true,
    );
    const walk = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "get" &&
        ts.isStringLiteral(node.arguments[0])
      )
        actual.add(`get ${node.arguments[0].text}`);
      ts.forEachChild(node, walk);
    };
    walk(tree);
  }
  const documented = new Set(
    Object.entries(openApiDocument.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method} ${path}`),
    ),
  );
  assert.deepEqual([...documented].sort(), [...actual].sort());
});

// Evaluate only existing pure validator declarations; do not import routers that
// initialize environment/database connections just to verify their input schema.
function validators(module, names, bindings = {}) {
  const tree = ts.createSourceFile(
    module,
    source(module),
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = tree.statements
    .filter(ts.isVariableStatement)
    .filter((statement) =>
      statement.declarationList.declarations.some((declaration) =>
        names.includes(declaration.name.getText(tree)),
      ),
    );
  assert.equal(
    declarations.length,
    names.length,
    `Validator declaration changed in ${module}`,
  );
  const code = ts.transpileModule(
    `${declarations.map((statement) => statement.getText(tree).replace(/^export\s+/, "")).join("\n")}\nglobalThis.result={${names.join(",")}};`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;
  const context = { z, Buffer, ...bindings };
  vm.runInNewContext(code, context, { timeout: 1000 });
  return context.result;
}

test("documented input constraints agree with production validators on examples and rejection cases", () => {
  const account = validators("routes/account-actions.ts", [
    "accountPassword",
    "emailInput",
    "tokenInput",
    "resetInput",
  ]);
  const auth = validators(
    "routes/public-auth.ts",
    ["email", "loginSchema", "registerSchema"],
    account,
  );
  const commands = validators("routes/shipment-commands.ts", [
    "version",
    "statusInput",
    "assignInput",
    "cancelInput",
  ]);
  const delivery = validators("routes/delivery.ts", [
    "version",
    "id",
    "issue",
    "confirm",
  ]);
  const exceptions = validators("routes/shipment-exceptions.ts", [
    "version",
    "reason",
    "input",
  ]);
  const drivers = validators("routes/drivers.ts", [
    "statusSchema",
    "locationSchema",
    "vehicleSchema",
    "notifPrefsSchema",
  ]);
  const business = validators("routes/business.ts", [
    "updateProfileSchema",
    "notifPrefsSchema",
    "preferencesSchema",
  ]);
  const profile = validators(
    "routes/auth.ts",
    ["updateMeSchema", "changePasswordSchema"],
    account,
  );
  const invitations = validators("routes/driver-invitations.ts", [
    "email",
    "acceptanceSchema",
  ]);
  const deactivation = validators("routes/account-deactivation.ts", ["input"]);
  const pairs = {
    LoginInput: auth.loginSchema,
    RegisterInput: auth.registerSchema,
    EmailInput: account.emailInput,
    TokenInput: account.tokenInput,
    ResetPasswordInput: account.resetInput,
    ProfileInput: profile.updateMeSchema,
    PasswordInput: profile.changePasswordSchema,
    DeactivateInput: deactivation.input,
    AssignInput: commands.assignInput,
    StatusInput: commands.statusInput,
    CancelInput: commands.cancelInput,
    IssueDeliveryCodeInput: delivery.issue,
    ConfirmDeliveryInput: delivery.confirm,
    ExceptionInput: exceptions.input,
    VehicleInput: drivers.vehicleSchema,
    DriverStatusInput: drivers.statusSchema,
    CoordinatesInput: drivers.locationSchema,
    DriverNotifications: drivers.notifPrefsSchema,
    BusinessProfileInput: business.updateProfileSchema,
    BusinessNotifications: business.notifPrefsSchema,
    BusinessPreferences: business.preferencesSchema,
    AcceptInvitationInput: invitations.acceptanceSchema,
    ShipmentInput: shipmentInput,
    CheckoutInput: checkoutInput,
  };
  for (const [name, production] of Object.entries(pairs)) {
    const check = ajv.compile({ $ref: `isotrack#/components/schemas/${name}` });
    const examples = Object.values(openApiDocument.paths)
      .flatMap((path) =>
        Object.values(path).map(
          (operation) => operation.requestBody?.content["application/json"],
        ),
      )
      .filter(
        (media) =>
          media?.schema.$ref === `#/components/schemas/${name}` &&
          media.example,
      )
      .map((media) => media.example);
    const componentExample = openApiDocument.components.schemas[name].example;
    for (const value of [
      ...examples,
      ...(componentExample === undefined ? [] : [componentExample]),
      {},
      { unexpected: true },
      null,
      "invalid",
    ])
      assert.equal(
        check(value),
        production.safeParse(value).success,
        `${name}: ${JSON.stringify(value)}`,
      );
  }
  for (const [name, value] of [
    [
      "ConfirmDeliveryInput",
      { expectedVersion: 1, challengeId: "challenge", code: "01234567" },
    ],
    [
      "ConfirmDeliveryInput",
      { expectedVersion: 1, challengeId: "challenge", code: 12345678 },
    ],
    ["AssignInput", { expectedVersion: -1, driverId: "driver" }],
    ["CoordinatesInput", { lat: 91, lng: 3 }],
    ["VehicleInput", { vehicleType: "spaceship" }],
    ["StatusInput", { expectedVersion: 0, status: "assigned" }],
    ["ExceptionInput", { action: "fail", expectedVersion: 1, reason: "other" }],
    [
      "ExceptionInput",
      { action: "fail", expectedVersion: 1, reason: "other", note: " " },
    ],
    [
      "ExceptionInput",
      {
        action: "fail",
        expectedVersion: 1,
        reason: "other",
        note: "Unexpected road closure",
      },
    ],
    [
      "ShipmentInput",
      {
        ...openApiDocument.paths["/api/v1/shipments"].post.requestBody.content[
          "application/json"
        ].example,
        priceKobo: 1.5,
      },
    ],
  ])
    assert.equal(
      ajv.compile({ $ref: `isotrack#/components/schemas/${name}` })(value),
      pairs[name].safeParse(value).success,
      `${name}: ${JSON.stringify(value)}`,
    );
});

const date = "2026-11-12T10:00:00.000Z";
const shipment = {
  id: "shipment_example",
  trackingId: "IST-EXAMPLE",
  status: "out_for_delivery",
  version: 4,
  businessId: "business_example",
  driverId: "driver_example",
  customerId: null,
  recipientEmail: "recipient@example.test",
  description: "Box of books",
  weightKg: 2.5,
  dimensions: null,
  pickupAddress: { street: "12 Example Street", city: "Ikeja", state: "Lagos" },
  deliveryAddress: { street: "8 Sample Road", city: "Yaba", state: "Lagos" },
  currentLocation: null,
  scheduledPickup: null,
  actualPickup: date,
  estimatedDelivery: null,
  actualDelivery: null,
  priceKobo: 250000,
  isPaid: false,
  failureReason: null,
  failedAt: null,
  attemptNumber: 1,
  returnState: "none",
  returnedAt: null,
  createdAt: date,
  updatedAt: date,
};
const raw = Object.fromEntries(
  Object.entries(shipment).map(([key, value]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    value,
  ]),
);
function app(router, role = "business") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", "user_example");
    c.set("userRole", role);
    await next();
  });
  app.route("/", router);
  return app;
}

test("real read handlers produce documented shipment, notification and tracking shapes", async () => {
  const list = app(
    createShipmentListRouter({
      execute: async () => [
        {
          shipment: raw,
          time: "2026-11-12T10:00:00.000000Z",
          customer: null,
          driver: null,
          events: [],
        },
      ],
    }),
  );
  await responseBody("/api/v1/shipments", "get", await list.request("/"));
  const detail = app(
    createShipmentDetailRouter({
      execute: async () => [
        {
          ...shipment,
          customer: null,
          driver: null,
          payment: null,
          events: [],
          eventsTruncated: false,
        },
      ],
    }),
  );
  await responseBody(
    "/api/v1/shipments/{id}",
    "get",
    await detail.request("/shipment_example"),
  );
  const history = app(
    createShipmentDetailRouter({ execute: async () => [{ events: [] }] }),
  );
  await responseBody(
    "/api/v1/shipments/{id}/events",
    "get",
    await history.request("/shipment_example/events"),
  );
  const notification = {
    id: "notice_example",
    userId: "user_example",
    type: "push",
    title: "Shipment created",
    message: "Shipment created",
    isRead: false,
    status: "pending",
    metadata: null,
    createdAt: date,
  };
  const notices = app(
    createCollectionRouter(
      {
        execute: async () => [
          { payload: notification, time: "2026-11-12T10:00:00.000000Z" },
        ],
      },
      "notifications",
    ),
  );
  await responseBody(
    "/api/v1/notifications",
    "get",
    await notices.request("/"),
  );
  const readAll = app(
    createNotificationMutationRouter({
      execute: async () => [{ updated: 3, hasMore: false }],
    }),
  );
  await responseBody(
    "/api/v1/notifications/read-all",
    "patch",
    await readAll.request("/read-all", { method: "PATCH" }),
  );
  const tracking = createPublicTrackingRouter({
    execute: async () => [
      {
        trackingId: "IST-EXAMPLE",
        status: "out_for_delivery",
        scheduledPickup: null,
        estimatedDelivery: null,
        actualDelivery: null,
        events: [],
      },
    ],
  });
  await responseBody(
    "/api/v1/track/{trackingId}",
    "get",
    await tracking.request("/IST-EXAMPLE"),
  );
  await responseBody(
    "/api/v1/track/{trackingId}",
    "get",
    await tracking.request("/IST-EXAMPLE?secret=1"),
  );
});

test("real command/delivery handlers match documented bodies, replay headers and errors", async () => {
  const commands = app(
    createShipmentCommandRouter({
      execute: async () => [{ response: raw, replayed: true }],
    }),
  );
  const options = {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "example-request-key-0001",
    },
    body: JSON.stringify({ expectedVersion: 4, driverId: "driver_example" }),
  };
  const assigned = await commands.request("/shipment_example/assign", options);
  assert.equal(assigned.headers.get("Idempotency-Replayed"), "true");
  await responseBody("/api/v1/shipments/{id}/assign", "patch", assigned);
  await responseBody(
    "/api/v1/shipments/{id}/assign",
    "patch",
    await commands.request("/shipment_example/assign", {
      ...options,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const conflict = app(
    createShipmentCommandRouter({
      execute: async () => [
        { error: "SHIPMENT_VERSION_CONFLICT", status: 409 },
      ],
    }),
  );
  await responseBody(
    "/api/v1/shipments/{id}/assign",
    "patch",
    await conflict.request("/shipment_example/assign", options),
  );
  const challenge = {
    challengeId: "challenge_example",
    version: 5,
    expiresAt: date,
  };
  const issue = app(
    createDeliveryRouter(
      { execute: async () => [{ response: challenge, replayed: false }] },
      "ab".repeat(32),
    ),
  );
  await responseBody(
    "/api/v1/shipments/{id}/delivery-code",
    "post",
    await issue.request("/shipment_example/delivery-code", {
      ...options,
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 4,
        recipientEmail: "recipient@example.test",
      }),
    }),
  );
  const confirm = app(
    createDeliveryRouter(
      {
        execute: async () => [
          {
            response: {
              shipment: { ...raw, status: "delivered", actual_delivery: date },
            },
            replayed: false,
          },
        ],
      },
      "ab".repeat(32),
    ),
    "driver",
  );
  const confirmed = await responseBody(
    "/api/v1/shipments/{id}/confirm-delivery",
    "post",
    await confirm.request("/shipment_example/confirm-delivery", {
      ...options,
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 5,
        challengeId: "challenge_example",
        code: "01234567",
      }),
    }),
  );
  assert.equal("recipientEmail" in confirmed.data, false);
  const exception = app(
    createShipmentExceptionRouter({
      execute: async () => [{ response: raw, replayed: false }],
    }),
  );
  await responseBody(
    "/api/v1/shipments/{id}/exceptions",
    "post",
    await exception.request("/shipment_example/exceptions", {
      ...options,
      method: "POST",
      body: JSON.stringify({
        action: "fail",
        expectedVersion: 4,
        reason: "recipient_unavailable",
      }),
    }),
  );
});

test("real session handler agrees with documented cookie/Origin contract", async () => {
  const user = {
    id: "user_example",
    name: "Ada Okafor",
    email: "ada@example.test",
    role: "business",
    phone: null,
    avatar: null,
    emergencyContact: null,
    isEmailVerified: false,
    isActive: true,
    createdAt: date,
    updatedAt: date,
  };
  const router = createSessionRouter({
    frontendOrigin: "https://app.example.test",
    secureCookies: true,
    verify: async () => ({
      sub: user.id,
      sid: "session_example",
      generation: 0,
    }),
    findUser: async () => user,
    rotate: async () => ({
      accessToken: "example-access-token",
      refreshToken: "example-refresh-token",
      maxAge: 100,
    }),
    revoke: async () => {},
    sanitize: (value) => value,
  });
  const response = await router.request("/refresh", {
    method: "POST",
    headers: {
      Origin: "https://app.example.test",
      Cookie: "iso_refresh_token=example",
    },
  });
  assert.match(response.headers.get("Set-Cookie"), /HttpOnly/);
  await responseBody("/api/v1/auth/refresh", "post", response);
  await responseBody(
    "/api/v1/auth/refresh",
    "post",
    await router.request("/refresh", { method: "POST" }),
  );
});

test("Swagger and spec are served locally with working assets and no external validator", async () => {
  const router = new Hono();
  router.use("*", secureHeaders());
  router.route("/", createApiDocsRouter());
  assert.equal((await router.request("/docs")).status, 302);
  const html = await router.request("/docs/");
  assert.equal(html.status, 200);
  assert.match(
    html.headers.get("Content-Security-Policy"),
    /script-src 'self'/,
  );
  const markup = await html.text();
  assert.doesNotMatch(markup, /https?:\/\//);
  for (const path of [
    "/docs/assets/swagger-ui.css",
    "/docs/assets/swagger-ui-bundle.js",
    "/docs/assets/config.js",
  ]) {
    const response = await router.request(path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 100);
  }
  assert.deepEqual(
    await (await router.request("/openapi.json")).json(),
    openApiDocument,
  );
  assert.equal((await router.request("/docs/assets/package.json")).status, 404);
  const config = await (await router.request("/docs/assets/config.js")).text();
  assert.match(config, /persistAuthorization: false/);
  assert.match(config, /validatorUrl: null/);
  const preview = createApiDocsRouter(false);
  assert.match(
    await (await preview.request("/docs/assets/config.js")).text(),
    /supportedSubmitMethods: \[\]/,
  );
  assert.match(
    await (await preview.request("/docs/")).text(),
    /API execution is disabled/,
  );
});
