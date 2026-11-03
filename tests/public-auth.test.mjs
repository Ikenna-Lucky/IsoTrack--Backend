import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import {
  canonicalIp,
  budgetPeer,
  trustedProxyAddresses,
  createPeerResolver,
} from "../src/lib/request-peer.ts";
import { authPairKey, authPeerKey } from "../src/lib/auth-budget.ts";
import { createPublicAuthRouter } from "../src/routes/public-auth.ts";

test("peer resolution accepts only exact trusted proxies and one canonical X-Real-IP", async () => {
  assert.equal(canonicalIp("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(
    canonicalIp("2001:0DB8:0000:0000:0000:0000:0000:0001"),
    "2001:db8::1",
  );
  for (const invalid of [
    "127.0.0.1, 8.8.8.8",
    "127.1",
    "[::1]",
    "fe80::1%eth0",
    " 127.0.0.1",
    "example.test",
  ])
    assert.equal(canonicalIp(invalid), undefined);
  for (const invalid of ["*", "10.0.0.0/8", "127.0.0.1,"])
    assert.throws(() => trustedProxyAddresses(invalid));
  const app = new Hono();
  const trusted = createPeerResolver(
    () => "::ffff:127.0.0.1",
    trustedProxyAddresses("127.0.0.1"),
  );
  const direct = createPeerResolver(() => "127.0.0.1", new Set());
  app.get("/", (c) =>
    c.json({ trusted: trusted(c) ?? null, direct: direct(c) }),
  );
  assert.deepEqual(
    await (
      await app.request("/", {
        headers: { "X-Real-IP": "203.0.113.1", "X-Forwarded-For": "8.8.8.8" },
      })
    ).json(),
    { trusted: "203.0.113.1", direct: "127.0.0.1" },
  );
  assert.equal(
    (
      await (
        await app.request("/", {
          headers: { "X-Real-IP": "203.0.113.1,8.8.8.8" },
        })
      ).json()
    ).trusted,
    null,
  );
  assert.equal((await (await app.request("/")).json()).trusted, null);
});

test("auth budgets pseudonymize peers and identities, and group IPv6 privacy addresses by /64", () => {
  const secret = "public-auth-fixture-secret-minimum-32";
  assert.equal(
    budgetPeer("2001:db8:1:2::123"),
    budgetPeer("2001:db8:1:2:ffff:ffff:ffff:ffff"),
  );
  assert.notEqual(budgetPeer("2001:db8:1:2::1"), budgetPeer("2001:db8:1:3::1"));
  assert.equal(
    authPeerKey(secret, "login", "::ffff:127.0.0.1"),
    authPeerKey(secret, "login", "127.0.0.1"),
  );
  const key = authPairKey(secret, "127.0.0.1", "private@example.test");
  assert.ok(
    !key.includes("private@example.test") && !key.includes("127.0.0.1"),
  );
  assert.notEqual(
    key,
    authPairKey(secret, "127.0.0.2", "private@example.test"),
  );
  assert.notEqual(
    authPeerKey(secret, "login", "127.0.0.1"),
    authPeerKey(secret, "register", "127.0.0.1"),
  );
  assert.throws(() => budgetPeer("invalid"));
});

test("auth boundaries reject bodies before expensive work and fail closed without leaking credentials", async () => {
  let work = 0;
  const events = [];
  const app = createPublicAuthRouter({
    secret: "test",
    peer: () => "127.0.0.1",
    store: { execute: async () => [{ allowed: true, retryAfter: 10 }] },
    secureCookies: true,
    findUser: async () => {
      work++;
      throw new Error("private database password secret");
    },
    register: async () => {
      work++;
      return null;
    },
    openSession: async () => {
      work++;
      return null;
    },
    record: (event) => events.push(event),
  });
  const post = (path, body, headers = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  for (const body of [
    { email: "bad", password: "SENSITIVE_PASSWORD" },
    { email: "a@example.test", password: "x", role: "admin" },
    { email: "a@example.test", password: "x".repeat(129) },
  ]) {
    const response = await post("/login", body);
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes("SENSITIVE_PASSWORD"));
  }
  assert.equal(
    (await post("/login", { padding: "x".repeat(5000) })).status,
    413,
  );
  assert.equal(
    (await post("/register", { padding: "x".repeat(9000) })).status,
    413,
  );
  assert.equal(
    (
      await post("/register", {
        email: "a@example.test",
        password: "SENSITIVE_PASSWORD",
        name: "New Member",
        role: "admin",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await app.request("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(work, 0);
  const response = await post("/login", {
    email: "private@example.test",
    password: "SENSITIVE_PASSWORD",
  });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("secret"));
  const logs = JSON.stringify(events);
  assert.ok(
    !logs.includes("private@example.test") &&
      !logs.includes("SENSITIVE_PASSWORD") &&
      !logs.includes("127.0.0.1"),
  );
  assert.ok(
    events.every(
      (event) =>
        Object.keys(event).sort().join(",") ===
        "event,operation,outcome,requestId",
    ),
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
});
