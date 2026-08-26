import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArguments, runDoctor } from "../scripts/doctor.mjs";
import { installAgentSkill } from "../scripts/install-agent-skill.mjs";
import { APP_VERSION } from "../src/version.mjs";

function runtimeStatus(ready = true) {
  return {
    components: Object.fromEntries(
      ["ffmpeg", "whisper", "whisperModel", "ytDlp"].map((name) => [name, { ready }]),
    ),
  };
}

test("doctor reports ready only when host, config, runtime, and loopback service pass", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p0004-doctor-ready-"));
  const inboxDir = path.join(root, "Inbox");
  await mkdir(inboxDir, { recursive: true });
  try {
    await installAgentSkill({ target: "openclaw", homeDir: root, env: {} });
    const result = await runDoctor({
      host: "openclaw",
      configDir: path.join(root, "config"),
      homeDir: root,
      env: {},
      platform: "win32",
      nodeVersion: "20.11.0",
      configLoader: async () => ({ inboxDir }),
      runtimeStatusLoader: async () => runtimeStatus(true),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          app: "video-knowledge-capture",
          binding: "127.0.0.1",
          status: "ok",
          version: APP_VERSION,
        }),
      }),
    });
    assert.equal(result.status, "ready");
    assert.ok(result.checks.every((entry) => entry.status === "pass"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor provides bounded next actions when prerequisites are missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p0004-doctor-fail-"));
  try {
    const result = await runDoctor({
      host: "codex",
      configDir: path.join(root, "config"),
      homeDir: root,
      env: {},
      platform: "linux",
      nodeVersion: "18.0.0",
      configLoader: async () => ({ inboxDir: null }),
      runtimeStatusLoader: async () => runtimeStatus(false),
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(result.status, "needs_setup");
    assert.ok(result.checks.every((entry) => entry.status === "fail"));
    assert.ok(result.checks.every((entry) => typeof entry.next_action === "string"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor rejects a stale service version instead of reporting ready", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p0004-doctor-stale-"));
  const inboxDir = path.join(root, "Inbox");
  await mkdir(inboxDir, { recursive: true });
  try {
    await installAgentSkill({ target: "codex", homeDir: root, env: {} });
    const result = await runDoctor({
      host: "codex",
      configDir: path.join(root, "config"),
      homeDir: root,
      env: {},
      platform: "win32",
      nodeVersion: "20.0.0",
      configLoader: async () => ({ inboxDir }),
      runtimeStatusLoader: async () => runtimeStatus(true),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          app: "video-knowledge-capture",
          binding: "127.0.0.1",
          status: "ok",
          version: "0.0.0-stale",
        }),
      }),
    });
    assert.equal(result.status, "needs_setup");
    const serviceCheck = result.checks.find((entry) => entry.id === "service");
    assert.equal(serviceCheck.status, "fail");
    assert.match(serviceCheck.summary, /does not match repository version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor requires an explicit supported host", () => {
  assert.throws(() => parseArguments([]), /--host/);
  assert.throws(() => parseArguments(["--host", "unknown"]), /--host must be/);
});
