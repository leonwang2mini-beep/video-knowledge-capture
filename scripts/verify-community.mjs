#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runDoctor } from "./doctor.mjs";
import { runCommunitySetup } from "./setup-community.mjs";
import { APP_VERSION } from "../src/version.mjs";

function readyRuntime() {
  return {
    ready: true,
    components: Object.fromEntries(
      ["ffmpeg", "whisper", "whisperModel", "ytDlp"].map((name) => [name, { ready: true }]),
    ),
  };
}

export async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-knowledge-community-"));
  const inboxDir = path.join(root, "vault", "Inbox");
  const configDir = path.join(root, "config");
  const hermesHome = path.join(root, ".hermes");
  await mkdir(inboxDir, { recursive: true });

  try {
    const setup = await runCommunitySetup({
      host: "all",
      inboxDir,
      configDir,
      hermesHome,
      skipRuntime: true,
      homeDir: root,
      env: {},
    });
    assert.equal(setup.status, "configured");
    assert.deepEqual(setup.installations.map((entry) => entry.host), [
      "codex",
      "claude",
      "hermes",
      "openclaw",
    ]);

    const doctor = await runDoctor({
      host: "all",
      configDir,
      hermesHome,
      homeDir: root,
      env: {},
      platform: "win32",
      nodeVersion: "20.0.0",
      runtimeStatusLoader: async () => readyRuntime(),
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
    assert.equal(doctor.status, "ready");
    assert.ok(doctor.checks.every((entry) => entry.status === "pass"));

    const config = JSON.parse(await readFile(path.join(configDir, "config.json"), "utf8"));
    assert.equal(config.inboxDir, path.resolve(inboxDir));
    for (const relativePath of [
      ".codex/skills/video-knowledge-capture/SKILL.md",
      ".claude/skills/video-knowledge-capture/SKILL.md",
      ".openclaw/skills/video-knowledge-capture/SKILL.md",
      ".hermes/skills/video-knowledge-capture/SKILL.md",
      ".hermes/plugins/video-knowledge-capture/plugin.yaml",
    ]) {
      assert.match(await readFile(path.join(root, ...relativePath.split("/")), "utf8"), /video-knowledge-capture/);
    }

    process.stdout.write(`${JSON.stringify({
      status: "passed",
      evidence_level: "E3-simulated-first-install",
      hosts: doctor.hosts,
      assertions: [
        "configuration stayed inside a disposable root",
        "Codex, Claude Code, Hermes, and OpenClaw managed files were installed",
        "doctor reached ready against injected healthy runtime and loopback service",
        "no real Obsidian vault, agent home, account, or message channel was used",
      ],
    }, null, 2)}\n`);
    return 0;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ code: "COMMUNITY_VERIFY_FAILED", error: error.message })}\n`);
    process.exitCode = 1;
  });
}
