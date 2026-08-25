import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  protectCredential,
  unprotectCredential,
} from "../src/windows-credential.mjs";

test("Windows DPAPI protects and restores a credential without returning plaintext", {
  skip: process.platform !== "win32",
}, async () => {
  const secret = `p0004-dpapi-${randomUUID()}`;
  const protectedValue = await protectCredential(secret);

  assert.ok(protectedValue.length > 20);
  assert.doesNotMatch(protectedValue, new RegExp(secret));
  assert.equal(await unprotectCredential(protectedValue), secret);
});
