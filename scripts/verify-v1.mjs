#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  resolveDefaultConfigDir,
  saveAppConfig,
} from "../src/app-config.mjs";
import { MediaJobService } from "../src/media-jobs.mjs";
import { assertRuntimeReady } from "../src/runtime-manager.mjs";
import { MediaProcessingError, transcribeMedia } from "../src/transcriber.mjs";

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

async function createSpeechFixture(filePath) {
  const escapedPath = filePath.replaceAll("'", "''");
  const text = "Video knowledge capture local transcription verification. This audio stays on this computer.";
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$voice.SelectVoice('Microsoft Zira Desktop')",
    `$voice.SetOutputToWaveFile('${escapedPath}')`,
    `$voice.Speak('${text}')`,
    "$voice.Dispose()",
  ].join("; ");
  const windowsPowerShell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  await runProcess(windowsPowerShell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ]);
  const metadata = await stat(filePath);
  assert.ok(metadata.size > 1000, "speech fixture must contain real WAV bytes");
}

async function waitForJob(service, jobId, accepted = ["completed", "failed"]) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await service.get(jobId);
    if (accepted.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`media job ${jobId} timed out`);
}

async function uploadFixture(service, fixturePath, url) {
  const created = await service.create({
    fileName: path.basename(fixturePath),
    note: "P0004 V1.0 临时目录验收",
    providedTitle: "V1.0 本地转写验收",
    sourceType: "local-upload",
    url,
  });
  const bytes = await readFile(fixturePath);
  await service.acceptUpload(created.jobId, Readable.from([bytes]), {
    contentLength: bytes.length,
  });
  return waitForJob(service, created.jobId);
}

export async function main() {
  if (process.platform !== "win32") {
    throw new Error("verify:v1 当前使用 Windows SAPI 生成无网络语音夹具。 ");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-v1-"));
  const configDir = path.join(root, "config");
  const inboxDir = path.join(root, "Inbox");
  const fixturePath = path.join(root, "speech-fixture.wav");
  const runtimeConfigDir = resolveDefaultConfigDir();
  try {
    await mkdir(inboxDir);
    await saveAppConfig(configDir, { inboxDir });
    await createSpeechFixture(fixturePath);
    const runtimeResolver = async (_configDir, required) => (
      assertRuntimeReady(runtimeConfigDir, required)
    );
    const service = new MediaJobService(configDir, {
      contentExtractor: async () => ({
        errorCode: "VERIFY_OFFLINE_FIXTURE",
        status: "unavailable",
        strategy: "verify-v1",
      }),
      runtimeResolver,
    });

    const first = await uploadFixture(
      service,
      fixturePath,
      "https://example.com/p0004-v1-local-audio",
    );
    assert.equal(first.status, "completed", first.error?.message);
    assert.equal(first.result.captureStatus, "created");
    assert.ok(first.result.segmentCount > 0);
    const firstMarkdown = await readFile(first.result.notePath, "utf8");
    assert.match(firstMarkdown, /material_source: "local-asr"/);
    assert.match(firstMarkdown, /### 时间线/);
    assert.match(firstMarkdown, /### 完整字幕/);
    await assert.rejects(stat(path.join(configDir, "work", "jobs", first.jobId)));

    const duplicate = await uploadFixture(
      service,
      fixturePath,
      "https://example.com/p0004-v1-local-audio#duplicate",
    );
    assert.equal(duplicate.status, "completed", duplicate.error?.message);
    assert.equal(duplicate.result.captureStatus, "duplicate");

    let failOnce = true;
    const retryService = new MediaJobService(configDir, {
      contentExtractor: async () => ({ status: "unavailable", strategy: "verify-v1" }),
      runtimeResolver,
      transcriber: async (options) => {
        if (failOnce) {
          failOnce = false;
          throw new MediaProcessingError("验收注入的一次性转写失败。", "VERIFY_FAIL_ONCE", {
            retryable: true,
            stage: "transcribe",
          });
        }
        return transcribeMedia(options);
      },
    });
    const failed = await uploadFixture(
      retryService,
      fixturePath,
      "https://example.com/p0004-v1-retry",
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "VERIFY_FAIL_ONCE");
    assert.equal(failed.workRetained, true);
    await retryService.retry(failed.jobId);
    const retried = await waitForJob(retryService, failed.jobId);
    assert.equal(retried.status, "completed", retried.error?.message);
    assert.equal(retried.result.captureStatus, "created");
    assert.equal((await readdir(inboxDir)).filter((name) => name.endsWith(".md")).length, 2);

    process.stdout.write(`${JSON.stringify({
      duplicate: duplicate.result.captureStatus,
      inboxDir,
      markdownCount: 2,
      mediaCleaned: true,
      notePath: first.result.notePath,
      realLocalAsr: true,
      retryResult: retried.result.captureStatus,
      segmentCount: first.result.segmentCount,
      temporaryOnly: true,
    }, null, 2)}\n`);
    return 0;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code ?? "VERIFY_V1_FAILED",
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
