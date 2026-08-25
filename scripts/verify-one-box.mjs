#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveDefaultConfigDir } from "../src/app-config.mjs";
import { saveAppConfig } from "../src/app-config.mjs";
import { MediaJobService } from "../src/media-jobs.mjs";
import { assertRuntimeIntegrity } from "../src/runtime-manager.mjs";

const DEFAULT_TEST_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

function parseArguments(args) {
  const options = { timeoutSeconds: 1200, url: DEFAULT_TEST_URL };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--url" && value) options.url = value;
    else if (argument === "--timeout-seconds" && value) options.timeoutSeconds = Number(value);
    else throw new Error(`无法识别或缺少参数值：${argument}`);
    index += 1;
  }
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 30 || options.timeoutSeconds > 3600) {
    throw new Error("--timeout-seconds 必须是 30 到 3600 的整数。");
  }
  return options;
}

async function waitForJob(service, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await service.get(jobId);
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("单一入口验收等待超时。");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-one-box-"));
  const configDir = path.join(root, "config");
  const inboxDir = path.join(root, "Inbox");
  let keepDiagnostics = true;
  try {
    await mkdir(inboxDir);
    await saveAppConfig(configDir, { inboxDir });
    const installedConfigDir = resolveDefaultConfigDir();
    const service = new MediaJobService(configDir, {
      runtimeResolver: (_ignored, required) => assertRuntimeIntegrity(installedConfigDir, required),
    });
    const created = await service.create({
      keepMedia: false,
      sourceType: "public-url",
      url: options.url,
    });
    const completed = await waitForJob(service, created.jobId, options.timeoutSeconds * 1000);
    if (completed.status !== "completed") {
      const error = new Error(completed.error?.message || "单一入口任务失败。");
      error.code = completed.error?.code || "ONE_BOX_JOB_FAILED";
      throw error;
    }
    const notes = (await readdir(inboxDir)).filter((name) => name.endsWith(".md"));
    assert.equal(notes.length, 1);
    const markdown = await readFile(path.join(inboxDir, notes[0]), "utf8");
    assert.match(markdown, /material_source: "public-url-asr"/);
    assert.match(markdown, /## 视频内容/);
    assert.ok(completed.result.segmentCount > 0);
    assert.ok(completed.result.transcriptCharCount > 0);
    await assert.rejects(stat(path.join(configDir, "work", "jobs", created.jobId)));
    keepDiagnostics = false;
    process.stdout.write(`${JSON.stringify({
      result: "passed",
      sourcePlatform: "youtube",
      noteCount: notes.length,
      segmentCount: completed.result.segmentCount,
      transcriptCharCount: completed.result.transcriptCharCount,
      mediaRetained: false,
      realObsidianTouched: false,
    }, null, 2)}\n`);
    return 0;
  } finally {
    if (!keepDiagnostics) {
      await rm(root, { recursive: true, force: true });
    } else {
      process.stderr.write(`诊断目录已保留：${root}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code || "ONE_BOX_VERIFY_FAILED",
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
