import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArguments, runCommunitySetup } from "../scripts/setup-community.mjs";

test("community setup configures an isolated Inbox and installs every declared host", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p0004-community-setup-"));
  const inboxDir = path.join(root, "vault", "Inbox");
  const configDir = path.join(root, "config");
  const hermesHome = path.join(root, ".hermes");
  await mkdir(inboxDir, { recursive: true });
  try {
    let runtimeCalled = false;
    const result = await runCommunitySetup({
      host: "all",
      inboxDir,
      configDir,
      hermesHome,
      skipRuntime: true,
      homeDir: root,
      env: {},
    }, {
      runtimeInstaller: async () => {
        runtimeCalled = true;
      },
    });
    assert.equal(runtimeCalled, false);
    assert.equal(result.status, "configured");
    assert.deepEqual(result.installations.map((entry) => entry.host), [
      "codex",
      "claude",
      "hermes",
      "openclaw",
    ]);
    const config = JSON.parse(await readFile(path.join(configDir, "config.json"), "utf8"));
    assert.equal(config.inboxDir, path.resolve(inboxDir));
    assert.match(
      await readFile(path.join(root, ".openclaw", "skills", "video-knowledge-capture", "SKILL.md"), "utf8"),
      /name: video-knowledge-capture/,
    );
    assert.match(
      await readFile(path.join(hermesHome, "plugins", "video-knowledge-capture", "plugin.yaml"), "utf8"),
      /name: video-knowledge-capture/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("community setup requires an explicit host and existing Inbox", () => {
  assert.throws(() => parseArguments([]), /--host/);
  assert.throws(() => parseArguments(["--host", "codex"]), /--inbox/);
  assert.throws(
    () => parseArguments(["--host", "unknown", "--inbox", "D:\\Inbox"]),
    /--host must be/,
  );
  assert.throws(
    () => parseArguments(["--host", "codex", "--inbox", "D:\\Inbox", "--skip-runtime"]),
    /Unknown or incomplete argument/,
  );
});

test("community setup rejects a filesystem root as its configuration directory", async () => {
  let configCalled = false;
  await assert.rejects(
    runCommunitySetup({
      host: "codex",
      inboxDir: path.join(path.parse(process.cwd()).root, "Inbox"),
      configDir: path.parse(process.cwd()).root,
      skipRuntime: true,
    }, {
      configSaver: async () => {
        configCalled = true;
      },
    }),
    /Config directory cannot be a filesystem root/,
  );
  assert.equal(configCalled, false);
});
