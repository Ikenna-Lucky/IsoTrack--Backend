import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionRouter } from "../src/routes/sessions.ts";
import { requireSessionClaims } from "../src/lib/session-claims.ts";
import { tokenDurationSeconds } from "../src/lib/token-duration.ts";

test("token durations reject ambiguous, zero, overflowing and unbounded values", () => {
  assert.equal(tokenDurationSeconds("15m"), 900);
  assert.equal(tokenDurationSeconds("7d"), 604800);
  for (const value of ["0s", "-1d", "1.5h", "1year", "15minutes", "1d ", "366d", "9999999999999999999d"]) {
    assert.throws(() => tokenDurationSeconds(value));
  }
});

function fixture(overrides = {}) {
  const calls = [];
  const router = createSessionRouter({
    frontendOrigin: "https://app.example.test", secureCookies: true,
    verify: async () => ({ sub: "user", sid: "abcdefghijklmnopqrstu", generation: 0, exp: 2000000000 }),
    findUser: async () => ({ id: "user", isActive: true }),
    rotate: async () => { calls.push("rotate"); return { accessToken: "access", refreshToken: "next", maxAge: 100 }; },
    revoke: async () => { calls.push("revoke"); },
    sanitize: (user) => ({ id: user.id }), ...overrides,
  });
  router.onError((_, c) => c.json({ error: "SERVER_FAILURE" }, 500));
  router.get("/unrelated", (c) => c.json({ ok: true }));
  const request = (path, headers = {}) => router.request(path, { method: "POST", headers: {
    Origin: "https://app.example.test", Cookie: "iso_refresh_token=current", ...headers,
  } });
  return { request, calls, router };
}

test("session claims reject legacy tokens and malformed identifiers or generations", () => {
  for (const payload of [{}, { sid: "short" }, { sid: "abcdefghijklmnopqrstu", generation: -1 },
    { sid: "abcdefghijklmnopqrstu", generation: "0" }, { sid: "abcdefghijklmnopqrstu", generation: 1.5 },
    { sid: "abcdefghijklmnopqrstu", generation: 2147483647 }]) {
    assert.throws(() => requireSessionClaims(payload, true));
  }
  requireSessionClaims({ sid: "abcdefghijklmnopqrstu", generation: 0 }, true);
  requireSessionClaims({ sid: "abcdefghijklmnopqrstu" }, false);
});

test("cookie-authenticated session endpoints reject missing and foreign origins", async () => {
  const { request, calls, router } = fixture();
  for (const path of ["/refresh", "/logout"]) {
    for (const Origin of ["", "null", "https://evil.example.test"]) {
      assert.equal((await request(path, { Origin })).status, 403);
    }
  }
  assert.deepEqual(calls, []);
  assert.equal((await router.request("/unrelated")).status, 200);
});

test("refresh returns rotated credentials with private secure cookie and no-store", async () => {
  const response = await fixture().request("/refresh");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const cookie = response.headers.get("set-cookie");
  for (const attribute of [/iso_refresh_token=next/, /HttpOnly/, /Secure/, /SameSite=None/, /Max-Age=100/]) assert.match(cookie, attribute);
  assert.deepEqual(await response.json(), { success: true, data: { user: { id: "user" }, accessToken: "access" } });
});

test("missing and invalid refresh cookies fail without reaching rotation", async () => {
  const invalid = fixture({ verify: async () => { throw new Error("bad signature"); } });
  assert.equal((await invalid.request("/refresh")).status, 401);
  assert.deepEqual(invalid.calls, []);
  assert.equal((await fixture().request("/refresh", { Cookie: "" })).status, 401);
});

test("inactive users and revoked sessions cannot refresh", async () => {
  const inactive = fixture({ findUser: async () => ({ id: "user", isActive: false }) });
  assert.equal((await inactive.request("/refresh")).status, 401);
  assert.deepEqual(inactive.calls, []);
  const response = await fixture({ rotate: async () => null }).request("/refresh");
  assert.equal(response.status, 401);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
});

test("session storage failures stay server failures and do not clear the cookie", async () => {
  for (const dependency of ["findUser", "rotate", "revoke"]) {
    const response = await fixture({ [dependency]: async () => { throw new Error("database unavailable"); } })
      .request(dependency === "revoke" ? "/logout" : "/refresh");
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("logout revokes a verified session and tolerates missing or invalid cookies", async () => {
  const valid = fixture();
  assert.equal((await valid.request("/logout")).status, 200);
  assert.deepEqual(valid.calls, ["revoke"]);
  const invalid = fixture({ verify: async () => { throw new Error("invalid"); } });
  assert.equal((await invalid.request("/logout")).status, 200);
  assert.deepEqual(invalid.calls, []);
  assert.equal((await fixture().request("/logout", { Cookie: "" })).status, 200);
});
