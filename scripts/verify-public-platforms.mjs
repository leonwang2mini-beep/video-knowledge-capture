#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveDefaultConfigDir, saveAppConfig } from "../src/app-config.mjs";
import { MediaJobService } from "../src/media-jobs.mjs";
import { detectPlatform } from "../src/platforms.mjs";
import { assertRuntimeIntegrity } from "../src/runtime-manager.mjs";
import { startLocalApp } from "../src/server.mjs";
import { installHermesIntegration } from "./install-hermes-integration.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probeScript = path.join(
  projectRoot,
  "integrations",
  "hermes",
  "tests",
  "invoke_client.py",
);
const silentLogger = { error() {}, log() {} };

function parseArguments(args) {
  const options = { cases: [], timeoutSeconds: 1800 };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--case") {
      const platform = args[index + 1];
      const url = args[index + 2];
      if (!platform || !url) throw new Error("--case 需要平台 ID 和完整 URL。\n");
      options.cases.push({ platform, url });
      index += 2;
      continue;
    }
    if (argument === "--timeout-seconds") {
      options.timeoutSeconds = Number(args[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  if (options.cases.length === 0) {
    throw new Error("至少提供一个 --case <platform-id> <public-url>。\n");
  }
  if (
    !Number.isInteger(options.timeoutSeconds)
    || options.timeoutSeconds < 30
    || options.timeoutSeconds > 3600
  ) {
    throw new Error("--timeout-seconds 必须是 30 到 3600 的整数。\n");
  }
  return options;
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUTF8: "1",
      },
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({ stderr, stdout });
    });
  });
}

async function invokeClient(clientPath, baseUrl, action, argument) {
  const command = process.platform === "win32" ? "py" : "python3";
  const prefix = process.platform === "win32" ? ["-3"] : [];
  const result = await runProcess(command, [
    ...prefix,
    probeScript,
    clientPath,
    baseUrl,
    action,
    JSON.stringify(argument),
  ]);
  return JSON.parse(result.stdout);
}

async function waitForTerminal(clientPath, baseUrl, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await invokeClient(clientPath, baseUrl, "status", { job_id: jobId });
    if (result.state !== "processing") return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return {
    code: "PUBLIC_PLATFORM_VERIFY_TIMEOUT",
    job_id: jobId,
    message: "跨平台临时验收等待超时。",
    retryable: true,
    state: "failed",
  };
}

async function validateCompleted(result, expectedPlatform, inboxDir, retainedMediaDir) {
  assert.ok(["completed", "duplicate"].includes(result.state));
  assert.equal(result.platform ?? expectedPlatform, expectedPlatform);
  assert.ok(Number(result.segment_count) > 0);
  assert.ok(Number(result.transcript_char_count) > 0);
  assert.ok(path.resolve(result.note_path).startsWith(path.resolve(inboxDir) + path.sep));
  assert.ok(
    path.resolve(result.retained_media_path).startsWith(path.resolve(retainedMediaDir) + path.sep),
  );
  const [markdown, media] = await Promise.all([
    readFile(result.note_path, "utf8"),
    stat(result.retained_media_path),
  ]);
  assert.match(markdown, /material_source: "public-url-asr"/);
  assert.match(markdown, /## 视频内容/);
  assert.ok(media.isFile() && media.size > 0);
  return {
    mediaBytes: media.size,
    noteBytes: Buffer.byteLength(markdown),
    noteName: path.basename(result.note_path),
    retainedMediaExistsAtValidation: true,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const root = await mkdtemp(path.join(os.tmpdir(), "p0004-public-platforms-"));
  const configDir = path.join(root, "config");
  const hermesHome = path.join(root, "hermes-home");
  const inboxDir = path.join(root, "Inbox");
  const retainedMediaDir = path.join(root, "retained-media");
  const outcomes = [];
  let server;
  try {
    await Promise.all([mkdir(inboxDir), mkdir(retainedMediaDir)]);
    await saveAppConfig(configDir, { inboxDir, retainedMediaDir });
    const installed = await installHermesIntegration({ hermesHome });
    const installedConfigDir = resolveDefaultConfigDir();
    const mediaJobService = new MediaJobService(configDir, {
      runtimeResolver: (_configDir, required) => (
        assertRuntimeIntegrity(installedConfigDir, required)
      ),
    });
    const started = await startLocalApp({
      configDir,
      logger: silentLogger,
      mediaJobService,
      port: 0,
    });
    server = started.server;
    const clientPath = path.join(installed.pluginDir, "client.py");

    for (const testCase of options.cases) {
      const detected = detectPlatform(testCase.url);
      if (detected.id !== testCase.platform) {
        outcomes.push({
          detectedPlatform: detected.id,
          expectedPlatform: testCase.platform,
          state: "invalid-case",
        });
        continue;
      }
      let result = await invokeClient(clientPath, started.url, "capture", {
        url: testCase.url,
        wait_seconds: 0,
      });
      if (result.state === "processing") {
        result = await waitForTerminal(
          clientPath,
          started.url,
          result.job_id,
          options.timeoutSeconds * 1000,
        );
      }
      const outcome = {
        code: result.code ?? null,
        detectedPlatform: detected.id,
        downloadAttempt: result.download_attempt ?? null,
        downloadAttempts: result.download_attempts ?? null,
        downloadFormatId: result.download_format_id ?? null,
        downloadProfile: result.download_profile ?? null,
        downloadResolution: result.download_resolution ?? null,
        failureCategory: result.failure_category ?? null,
        jobId: result.job_id ?? null,
        retryable: result.retryable ?? false,
        stage: result.stage ?? null,
        state: result.state,
      };
      if (["completed", "duplicate"].includes(result.state)) {
        Object.assign(
          outcome,
          await validateCompleted(result, testCase.platform, inboxDir, retainedMediaDir),
          {
            segmentCount: result.segment_count,
            transcriptCharCount: result.transcript_char_count,
          },
        );
      }
      outcomes.push(outcome);
    }

    const noteCount = (await readdir(inboxDir)).filter((entry) => entry.endsWith(".md")).length;
    const passed = outcomes.every((outcome) => ["completed", "duplicate"].includes(outcome.state));
    process.stdout.write(`${JSON.stringify({
      evidenceLevel: "E2",
      hermesPluginClient: true,
      noteCount,
      outcomes,
      passed,
      realObsidianTouched: false,
      tempArtifactsCleaned: true,
    }, null, 2)}\n`);
    return passed ? 0 : 1;
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code ?? "PUBLIC_PLATFORMS_VERIFY_FAILED",
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
