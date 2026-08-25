import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertRuntimeIntegrity,
  RuntimeError,
} from "../src/runtime-manager.mjs";

async function createRuntimeFixture({
  fileContent = "verified-runtime",
  manifestDigest = null,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-runtime-integrity-"));
  const runtimeDir = path.join(root, "runtime");
  const executable = path.join(runtimeDir, "wx-channel-fixture.exe");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(executable, fileContent);
  await writeFile(path.join(runtimeDir, "runtime-manifest.json"), JSON.stringify({
    components: {
      wxChannel: {
        fileDigest: manifestDigest ?? createHash("sha256").update(fileContent).digest("hex"),
        fileDigestAlgorithm: "sha256",
        path: executable,
      },
    },
  }));
  return { executable, root };
}

test("assertRuntimeIntegrity verifies only the required executable before launch", async (t) => {
  const fixture = await createRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const status = await assertRuntimeIntegrity(fixture.root, ["wxChannel"]);

  assert.equal(status.ready, true);
  assert.equal(status.components.wxChannel.integrity, "verified");
  assert.equal(status.components.wxChannel.path, fixture.executable);
});

test("assertRuntimeIntegrity rejects a changed runtime executable", async (t) => {
  const fixture = await createRuntimeFixture({ manifestDigest: "0".repeat(64) });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    assertRuntimeIntegrity(fixture.root, ["wxChannel"]),
    (error) => (
      error instanceof RuntimeError
      && error.code === "RUNTIME_INTEGRITY_MISMATCH"
      && error.component === "wxChannel"
    ),
  );
});

test("assertRuntimeIntegrity rejects a manifest without an installed file digest", async (t) => {
  const fixture = await createRuntimeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(path.join(fixture.root, "runtime", "runtime-manifest.json"), JSON.stringify({
    components: { wxChannel: { path: fixture.executable } },
  }));

  await assert.rejects(
    assertRuntimeIntegrity(fixture.root, ["wxChannel"]),
    (error) => (
      error instanceof RuntimeError
      && error.code === "RUNTIME_INTEGRITY_MISSING"
      && error.component === "wxChannel"
    ),
  );
});
