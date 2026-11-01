import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInvitationToken,
  hashInvitationToken,
} from "../src/lib/invitation-token.ts";

test("invitation secrets are URL safe, 256-bit tokens with SHA-256 storage hashes", () => {
  const { token, tokenHash } = createInvitationToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.match(tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(hashInvitationToken(token), tokenHash);
  assert.notEqual(createInvitationToken().token, token);
  assert.notEqual(hashInvitationToken(`${token}x`), tokenHash);
});
