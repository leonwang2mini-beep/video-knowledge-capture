#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  resolveDefaultConfigDir,
  resolveRuntimeDir,
  saveAppConfig,
} from "../src/app-config.mjs";
import { normalizeVideoUrl } from "../src/core.mjs";
import { MediaJobService } from "../src/media-jobs.mjs";
import { detectPlatform } from "../src/platforms.mjs";

function positiveSecondsOption(args, name, fallback, maximum) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const raw = args[index + 1];
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} 必须是 1 到 ${maximum} 之间的整数秒数。`);
  }
  return value;
}

export function parseYuanbaoLiveArguments(args) {
  const index = args.indexOf("--url");
  const value = index >= 0 ? args[index + 1] : null;
  if (!value) {
    throw new Error(
      "用法：npm.cmd run verify:yuanbao-live -- --url <微信视频号分享链接>",
    );
  }
  const url = normalizeVideoUrl(value);
  if (detectPlatform(url).id !== "wechat-channels") {
    throw new Error("verify:yuanbao-live 只接受微信视频号公开分享链接。");
  }
  return {
    jobTimeoutMs: positiveSecondsOption(
      args,
      "--job-timeout-seconds",
      30 * 60,
      60 * 60,
    ) * 1000,
    keepMedia: args.includes("--keep-media"),
    url,
  };
}

async function waitForJob(service, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStage = null;
  while (Date.now() < deadline) {
    const job = await service.get(jobId);
    if (job.stage !== lastStage) {
      lastStage = job.stage;
      process.stderr.write(`${JSON.stringify({
        event: "yuanbao-live-progress",
        stage: job.stage,
        status: job.status,
      })}\n`);
    }
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const error = new Error("元宝真实媒体任务等待超时。");
  error.code = "YUANBAO_LIVE_TIMEOUT";
  throw error;
}

export async function main(argv = process.argv.slice(2)) {
  const { jobTimeoutMs, keepMedia, url } = parseYuanbaoLiveArguments(argv);
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-yuanbao-live-"));
  const configDir = path.join(root, "config");
  const inboxDir = path.join(root, "Inbox");
  const installedConfigDir = resolveDefaultConfigDir();
  let completed = false;
  let service = null;
  try {
    await Promise.all([
      mkdir(inboxDir),
      mkdir(resolveRuntimeDir(configDir), { recursive: true }),
      mkdir(path.join(configDir, "secrets"), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(
        path.join(resolveRuntimeDir(installedConfigDir), "runtime-manifest.json"),
        path.join(resolveRuntimeDir(configDir), "runtime-manifest.json"),
      ),
      copyFile(
        path.join(installedConfigDir, "secrets", "yuanbao-session.json"),
        path.join(configDir, "secrets", "yuanbao-session.json"),
      ),
    ]);
    await saveAppConfig(configDir, {
      inboxDir,
      wechatAdvancedEnabled: true,
    });
    service = new MediaJobService(configDir);
    await service.ready;
    process.stderr.write(`${JSON.stringify({
      event: "yuanbao-live-started",
      temporaryRoot: root,
    })}\n`);
    const created = await service.create({
      keepMedia,
      note: "P0004 V1.0 腾讯元宝真实链路临时验收",
      resolverMode: "yuanbao-local",
      sourceType: "wechat",
      url,
    });
    const job = await waitForJob(service, created.jobId, jobTimeoutMs);
    if (job.status !== "completed") {
      const error = new Error(job.error?.message || "元宝真实媒体任务失败。");
      error.code = job.error?.code || "YUANBAO_LIVE_FAILED";
      throw error;
    }
    const markdown = await readFile(job.result.notePath, "utf8");
    assert.match(markdown, /source_platform: "wechat-channels"/);
    assert.match(markdown, /content_strategy: "wechat-yuanbao-local"/);
    assert.match(markdown, /material_source: "wechat-local-asr"/);
    assert.match(markdown, /### 时间线/);
    assert.ok(job.result.segmentCount > 0);
    assert.ok(job.result.transcriptCharCount > 0);
    const acceptanceDir = await mkdtemp(path.join(
      os.tmpdir(),
      "video-capture-yuanbao-live-result-",
    ));
    const acceptanceNotePath = path.join(
      acceptanceDir,
      path.basename(job.result.notePath),
    );
    await copyFile(job.result.notePath, acceptanceNotePath);
    let acceptanceMediaPath = null;
    let retainedMediaSha256 = null;
    let retainedMediaSize = 0;
    if (keepMedia) {
      assert.ok(job.result.retainedMediaPath);
      const retained = await stat(job.result.retainedMediaPath);
      assert.ok(retained.isFile() && retained.size > 0);
      const extension = path.extname(job.result.retainedMediaPath).toLowerCase();
      acceptanceMediaPath = path.join(
        acceptanceDir,
        `video-${job.result.captureId.slice(0, 16)}${extension}`,
      );
      await copyFile(job.result.retainedMediaPath, acceptanceMediaPath);
      retainedMediaSha256 = job.result.retainedMediaSha256;
      retainedMediaSize = retained.size;
    }
    completed = true;
    process.stdout.write(`${JSON.stringify({
      acceptanceMediaPath,
      acceptanceNotePath,
      captureStatus: job.result.captureStatus,
      jobId: job.jobId,
      materialSource: job.result.materialSource,
      mediaCleaned: job.workRetained === false,
      mediaRetained: Boolean(acceptanceMediaPath),
      retainedMediaSha256,
      retainedMediaSize,
      segmentCount: job.result.segmentCount,
      temporaryInbox: true,
      transcriptCharCount: job.result.transcriptCharCount,
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    error.retainedAt = root;
    throw error;
  } finally {
    await service?.sidecar?.stop?.().catch(() => {});
    if (completed) await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code ?? "VERIFY_YUANBAO_LIVE_FAILED",
      error: error.message,
      retainedAt: error.retainedAt ?? null,
    })}\n`);
    process.exitCode = 1;
  });
}
