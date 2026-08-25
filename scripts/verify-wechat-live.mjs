#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
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

export function parseWechatLiveArguments(args) {
  const index = args.indexOf("--url");
  const value = index >= 0 ? args[index + 1] : null;
  const retryIndex = args.indexOf("--retry-job");
  const retryJobValue = retryIndex >= 0 ? args[retryIndex + 1] : null;
  if (Boolean(value) === Boolean(retryJobValue)) {
    throw new Error(
      "用法：npm.cmd run verify:wechat-live -- --url <微信视频号分享链接>，或 --retry-job <失败任务 JSON>",
    );
  }
  let url = null;
  let retryJobPath = null;
  if (value) {
    url = normalizeVideoUrl(value);
    if (detectPlatform(url).id !== "wechat-channels") {
      throw new Error("verify:wechat-live 只接受微信视频号公开分享链接。");
    }
  } else {
    if (!path.isAbsolute(retryJobValue)) {
      throw new Error("--retry-job 必须使用失败任务 JSON 的绝对路径。");
    }
    retryJobPath = path.resolve(retryJobValue);
  }
  return {
    jobTimeoutMs: positiveSecondsOption(args, "--job-timeout-seconds", 20 * 60, 60 * 60) * 1000,
    pageTimeoutMs: positiveSecondsOption(args, "--page-timeout-seconds", 10 * 60, 30 * 60) * 1000,
    reuseObservedMs: positiveSecondsOption(args, "--reuse-observed-seconds", 0, 60 * 60) * 1000,
    retryJobPath,
    url,
  };
}

export async function loadWechatRetryUrl(retryJobPath) {
  let job;
  try {
    job = JSON.parse(await readFile(retryJobPath, "utf8"));
  } catch (error) {
    throw new Error("无法读取 --retry-job 指定的失败任务 JSON。", { cause: error });
  }
  if (job?.sourceType !== "wechat" || job?.status !== "failed" || !job?.request?.url) {
    throw new Error("--retry-job 不是可重试的微信失败任务。 ");
  }
  const url = normalizeVideoUrl(job.request.url);
  if (detectPlatform(url).id !== "wechat-channels") {
    throw new Error("--retry-job 中的来源不是微信视频号公开分享链接。");
  }
  return url;
}

async function waitForJob(service, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await service.get(jobId);
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`微信媒体任务 ${jobId} 等待超时。`);
}

async function waitForWechatPage(sidecar, url, timeoutMs, {
  notBeforeMs,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await sidecar.resolveCurrentPageVideo(url, { notBeforeMs });
    } catch (error) {
      if (error?.retryable === false) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  const error = new Error(
    lastError?.message || "等待桌面微信视频号页面就绪超时。",
  );
  error.code = lastError?.code || "WECHAT_PAGE_WAIT_TIMEOUT";
  throw error;
}

export async function main(argv = process.argv.slice(2)) {
  const {
    jobTimeoutMs,
    pageTimeoutMs,
    reuseObservedMs,
    retryJobPath,
    url,
  } = parseWechatLiveArguments(argv);
  const sourceUrl = retryJobPath ? await loadWechatRetryUrl(retryJobPath) : url;
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-wechat-e4-"));
  const configDir = path.join(root, "config");
  const inboxDir = path.join(root, "Inbox");
  const installedConfigDir = resolveDefaultConfigDir();
  let completed = false;
  let acceptanceNotePath = null;
  let service = null;
  try {
    await Promise.all([
      mkdir(inboxDir),
      mkdir(resolveRuntimeDir(configDir), { recursive: true }),
    ]);
    await copyFile(
      path.join(resolveRuntimeDir(installedConfigDir), "runtime-manifest.json"),
      path.join(resolveRuntimeDir(configDir), "runtime-manifest.json"),
    );
    await saveAppConfig(configDir, {
      inboxDir,
      wechatAdvancedEnabled: true,
    });
    service = new MediaJobService(configDir);
    await service.ready;
    process.stderr.write(`${JSON.stringify({
      event: "wechat-e4-preparing",
      temporaryRoot: root,
    })}\n`);
    const start = await service.sidecar.start();
    const sidecar = await service.sidecar.health();
    process.stderr.write(`${JSON.stringify({
      clientReady: sidecar.clientReady,
      event: "wechat-e4-waiting-for-page",
      pageTimeoutSeconds: pageTimeoutMs / 1000,
      serviceReady: sidecar.serviceReady,
    })}\n`);
    await waitForWechatPage(service.sidecar, sourceUrl, pageTimeoutMs, {
      notBeforeMs: reuseObservedMs > 0 ? Date.now() - reuseObservedMs : undefined,
    });
    const created = await service.create({
      note: "P0004 V1.0 微信高级模式 E4 临时验收",
      sourceType: "wechat",
      url: sourceUrl,
    });
    const job = await waitForJob(service, created.jobId, jobTimeoutMs);
    if (job.status !== "completed") {
      process.stderr.write(`${JSON.stringify({
        error: job.error,
        jobId: job.jobId,
        retainedAt: root,
        sidecar,
        start,
      }, null, 2)}\n`);
      const error = new Error(job.error?.message || "微信 E4 任务失败。");
      error.code = job.error?.code || "WECHAT_E4_FAILED";
      throw error;
    }
    const markdown = await readFile(job.result.notePath, "utf8");
    assert.match(markdown, /source_platform: "wechat-channels"/);
    assert.match(markdown, /material_source: "wechat-local-asr"/);
    assert.match(markdown, /content_strategy: "wechat-local-sidecar"/);
    assert.match(markdown, /### 时间线/);
    assert.ok(job.result.segmentCount > 0);
    const acceptanceDir = await mkdtemp(path.join(
      os.tmpdir(),
      "video-capture-wechat-e4-result-",
    ));
    acceptanceNotePath = path.join(acceptanceDir, path.basename(job.result.notePath));
    await copyFile(job.result.notePath, acceptanceNotePath);
    assert.equal(await readFile(acceptanceNotePath, "utf8"), markdown);
    completed = true;
    process.stdout.write(`${JSON.stringify({
      acceptanceNotePath,
      captureStatus: job.result.captureStatus,
      jobId: job.jobId,
      mediaCleaned: job.workRetained === false,
      segmentCount: job.result.segmentCount,
      sidecar,
      start,
      temporaryInbox: true,
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
      code: error.code ?? "VERIFY_WECHAT_LIVE_FAILED",
      error: error.message,
      retainedAt: error.retainedAt ?? null,
    })}\n`);
    process.exitCode = 1;
  });
}
