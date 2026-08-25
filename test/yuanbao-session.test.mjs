import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { YuanbaoSessionService } from "../src/yuanbao-session.mjs";

async function waitForState(service, expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await service.status();
    if (status.state === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`session did not reach ${expected}`);
}

test("Yuanbao session captures only into an encrypted local record and can be forgotten", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-yuanbao-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let capturedProfileDir;
  const service = new YuanbaoSessionService(root, {
    browserFinder: async () => "C:\\fixture\\msedge.exe",
    cookieCapture: async ({ profileDir }) => {
      capturedProfileDir = profileDir;
      return "hy_token=fake-login; other=fake";
    },
    protect: async (value) => {
      assert.match(value, /hy_token=fake-login/);
      return "dpapi-ciphertext-fixture";
    },
    unprotect: async (value) => {
      assert.equal(value, "dpapi-ciphertext-fixture");
      return "hy_token=fake-login; other=fake";
    },
  });

  const started = await service.startLogin();
  assert.equal(started.state, "waiting-for-login");
  const ready = await waitForState(service, "ready");
  assert.equal(ready.configured, true);
  assert.match(capturedProfileDir, /yuanbao-login/);

  const recordPath = path.join(root, "secrets", "yuanbao-session.json");
  const recordText = await readFile(recordPath, "utf8");
  assert.match(recordText, /windows-dpapi-current-user/);
  assert.doesNotMatch(recordText, /hy_token|fake-login/);
  assert.equal(await service.loadCookie(), "hy_token=fake-login; other=fake");

  const forgotten = await service.forget();
  assert.equal(forgotten.configured, false);
});

test("Yuanbao session reports a traceable login failure without exposing credentials", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-yuanbao-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new YuanbaoSessionService(root, {
    browserFinder: async () => "C:\\fixture\\msedge.exe",
    cookieCapture: async () => {
      const error = new Error("login window closed");
      error.code = "YUANBAO_LOGIN_WINDOW_CLOSED";
      error.retryable = true;
      throw error;
    },
  });

  await service.startLogin();
  const failed = await waitForState(service, "failed");
  assert.equal(failed.configured, false);
  assert.equal(failed.error.code, "YUANBAO_LOGIN_WINDOW_CLOSED");
  assert.equal(failed.error.retryable, true);
});
