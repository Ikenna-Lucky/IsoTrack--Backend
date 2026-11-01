import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { SignJWT } from "jose";
import { verifySessionToken } from "../src/lib/token-verification.ts";
import { createAuthenticationMiddleware } from "../src/middleware/authentication.ts";

const secret = new TextEncoder().encode(
  "isolated-test-key-at-least-32-characters",
);
async function token({
  payload = {},
  claims = {},
  algorithm = "HS256",
  key = secret,
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    type: "access",
    role: "driver",
    sub: "user-1",
    iat: now,
    exp: now + 60,
    ...payload,
    ...claims,
  })
    .setProtectedHeader({ alg: algorithm })
    .sign(key);
}

function application(
  findUser = async () => ({ id: "user-1", role: "driver", isActive: true }),
  handler,
) {
  let lookups = 0;
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : c.json({ error: "SERVER_FAILURE" }, 500),
  );
  app.use(
    "*",
    createAuthenticationMiddleware({
      verifyToken: (value) => verifySessionToken(value, secret, "access"),
      findUser: async (id) => {
        lookups++;
        assert.equal(id, "user-1");
        return findUser();
      },
    }),
  );
  app.get(
    "/",
    handler ??
      ((c) => c.json({ id: c.get("userId"), role: c.get("userRole") })),
  );
  return { app, lookups: () => lookups };
}
const request = (app, value) =>
  app.request("/", {
    headers: value === undefined ? {} : { Authorization: value },
  });

test("signed access tokens attach current database identity and role", async () => {
  const { app } = application(async () => ({
    id: "user-1",
    role: "business",
    isActive: true,
  }));
  const response = await request(app, `Bearer ${await token()}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "user-1", role: "business" });
});

test("missing and malformed authorization never query the user store", async () => {
  const { app, lookups } = application();
  for (const header of [
    undefined,
    "Basic abc",
    "Bearer",
    "Bearer abc extra",
    "Bearer malformed",
  ]) {
    assert.equal((await request(app, header)).status, 401);
  }
  assert.equal(lookups(), 0);
});

test("expired tokens, bad signatures, wrong algorithm and refresh tokens are rejected", async () => {
  const { app, lookups } = application();
  for (const options of [
    { claims: { exp: 1 } },
    { key: new TextEncoder().encode("a-different-key-at-least-32-characters") },
    { algorithm: "HS384" },
    { payload: { type: "refresh" } },
    { payload: { type: "unknown" } },
  ]) {
    assert.equal(
      (await request(app, `Bearer ${await token(options)}`)).status,
      401,
    );
  }
  assert.equal(lookups(), 0);
});

test("tokens require subject, issued-at, expiry and a known access role", async () => {
  const { app, lookups } = application();
  for (const payload of [
    { sub: undefined },
    { sub: " " },
    { iat: undefined },
    { exp: undefined },
    { role: "admin" },
    { role: undefined },
    { role: ["driver"] },
    { iat: "yesterday" },
  ]) {
    assert.equal(
      (await request(app, `Bearer ${await token({ payload })}`)).status,
      401,
    );
  }
  assert.equal(lookups(), 0);
});

test("inactive and deleted users cannot access protected routes", async () => {
  for (const user of [
    null,
    { id: "user-1", role: "driver", isActive: false },
  ]) {
    const { app } = application(async () => user);
    assert.equal((await request(app, `Bearer ${await token()}`)).status, 401);
  }
});

test("database failures remain server failures rather than authentication failures", async () => {
  const { app } = application(async () => {
    throw new Error("database unavailable");
  });
  const response = await request(app, `Bearer ${await token()}`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "SERVER_FAILURE" });
});

test("protected handler errors retain their status", async () => {
  for (const [error, status] of [
    [new Error("handler failed"), 500],
    [new HTTPException(403), 403],
  ]) {
    const { app } = application(undefined, () => {
      throw error;
    });
    assert.equal(
      (await request(app, `Bearer ${await token()}`)).status,
      status,
    );
  }
});

test("refresh verification enforces claims and rejects access tokens", async () => {
  const refresh = await token({
    payload: { type: "refresh", role: undefined },
  });
  assert.equal(
    (await verifySessionToken(refresh, secret, "refresh")).sub,
    "user-1",
  );
  await assert.rejects(verifySessionToken(await token(), secret, "refresh"));
  await assert.rejects(
    verifySessionToken(
      await token({ payload: { type: "refresh", exp: undefined } }),
      secret,
      "refresh",
    ),
  );
});
