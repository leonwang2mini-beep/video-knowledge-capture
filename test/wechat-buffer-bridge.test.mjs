import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWechatBufferCaptureScript,
  patchWechatRuntimeBuffer,
  prepareWechatBufferRuntime,
  resolveWechatBufferExecutablePath,
  WechatBufferBridgeError,
} from "../src/wechat-buffer-bridge.mjs";

const marker = "<script>\n\t// 初始化视频缓存监控";

function fixtureBinary({ duplicate = false, slotPadding = 12000 } = {}) {
  const slot = `${marker}\n${"x".repeat(slotPadding)}\n</script>`;
  return Buffer.from(`PE-FIXTURE\n${slot}${duplicate ? `\n${slot}` : ""}\nEND`, "utf8");
}

async function createInstalledFixture(binary) {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-buffer-bridge-"));
  const runtimeDir = path.join(root, "runtime", "wxChannel");
  const executable = path.join(runtimeDir, "wx_channel.exe");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(executable, binary);
  await writeFile(path.join(root, "runtime", "runtime-manifest.json"), JSON.stringify({
    components: {
      wxChannel: {
        fileDigest: createHash("sha256").update(binary).digest("hex"),
        fileDigestAlgorithm: "sha256",
        path: executable,
      },
    },
  }));
  return { executable, root };
}

test("buffer capture script uploads copied MSE chunks and finalizes isolated files", () => {
  const script = buildWechatBufferCaptureScript("test-run-12345678");

  assert.match(script, /SourceBuffer\.prototype\.appendBuffer/);
  assert.match(script, /MediaSource\.prototype\.endOfStream/);
  assert.match(script, /__wx_channels_api\/upload_chunk/);
  assert.match(script, /p0004-capture-/);
  assert.doesNotMatch(script, /Cookie|localStorage|sessionStorage/);
});

test("patchWechatRuntimeBuffer replaces exactly one bounded script slot", () => {
  const original = fixtureBinary();
  const replacement = buildWechatBufferCaptureScript("test-run-12345678");
  const result = patchWechatRuntimeBuffer(original, replacement);

  assert.equal(result.binary.length, original.length);
  assert.notDeepEqual(result.binary, original);
  assert.match(result.binary.toString("utf8"), /installP0004BufferCapture/);
  assert.match(original.toString("utf8"), /初始化视频缓存监控/);
  assert.equal(result.replacementLength < result.slotLength, true);
});

test("patchWechatRuntimeBuffer rejects missing, ambiguous and undersized slots", () => {
  assert.throws(
    () => patchWechatRuntimeBuffer(Buffer.from("no marker"), "<script></script>"),
    (error) => error instanceof WechatBufferBridgeError
      && error.code === "WECHAT_BUFFER_PATCH_MARKER_MISSING",
  );
  assert.throws(
    () => patchWechatRuntimeBuffer(fixtureBinary({ duplicate: true }), "<script></script>"),
    (error) => error.code === "WECHAT_BUFFER_PATCH_MARKER_AMBIGUOUS",
  );
  assert.throws(
    () => patchWechatRuntimeBuffer(
      fixtureBinary({ slotPadding: 1 }),
      `<script>${"z".repeat(1000)}</script>`,
    ),
    (error) => error.code === "WECHAT_BUFFER_PATCH_TOO_LARGE",
  );
});

test("prepareWechatBufferRuntime reuses one executable path while isolating each run", async (t) => {
  const original = fixtureBinary();
  const fixture = await createInstalledFixture(original);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const prepared = await prepareWechatBufferRuntime(fixture.root, {
    runId: "test-run-12345678",
  });
  const preparedAgain = await prepareWechatBufferRuntime(fixture.root, {
    runId: "test-run-87654321",
  });

  assert.notEqual(prepared.executablePath, fixture.executable);
  assert.equal(
    prepared.executablePath,
    resolveWechatBufferExecutablePath(fixture.root),
  );
  assert.equal(preparedAgain.executablePath, prepared.executablePath);
  assert.notEqual(preparedAgain.runRoot, prepared.runRoot);
  assert.deepEqual(await readFile(fixture.executable), original);
  const patchedExecutable = await readFile(preparedAgain.executablePath);
  assert.notDeepEqual(patchedExecutable, original);
  assert.match(patchedExecutable.toString("utf8"), /test-run-87654321/);
  assert.equal((await stat(path.join(prepared.runRoot, "config.yaml"))).isFile(), true);
  assert.equal((await stat(path.join(preparedAgain.runRoot, "config.yaml"))).isFile(), true);
  assert.equal(prepared.captureDir.startsWith(prepared.runRoot), true);
  assert.equal(preparedAgain.workingDirectory, preparedAgain.runRoot);
});
