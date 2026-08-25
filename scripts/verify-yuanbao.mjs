#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { saveAppConfig } from "../src/app-config.mjs";
import { MediaJobService } from "../src/media-jobs.mjs";

async function waitForJob(service, jobId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await service.get(jobId);
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("元宝临时验收任务超时。");
}

export async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-yuanbao-"));
  const configDir = path.join(root, "config");
  const inboxDir = path.join(root, "Inbox");
  const downloadDir = path.join(configDir, "work", "wechat-downloads");
  let mediaCounter = 0;
  try {
    await Promise.all([
      mkdir(inboxDir),
      mkdir(downloadDir, { recursive: true }),
    ]);
    await saveAppConfig(configDir, { inboxDir, wechatAdvancedEnabled: true });
    const profile = {
      author: "元宝临时验收作者",
      download: {
        id: "fixture-video-id",
        key: "1844674407370955161",
        url: "https://finder.video.qq.com/fixture.mp4?token=must-not-persist",
      },
      id: "fixture-video-id",
      title: "元宝解析本地闭环验收",
    };
    const sidecar = {
      async downloadResolvedProfile(resolved) {
        assert.equal(resolved, profile);
        mediaCounter += 1;
        const mediaPath = path.join(downloadDir, `fixture-${mediaCounter}.mp4`);
        await writeFile(mediaPath, "temporary-media");
        return {
          author: resolved.author,
          mediaPath,
          title: resolved.title,
          videoId: resolved.id,
        };
      },
      async purgeManagedArtifacts() {
        await rm(downloadDir, { recursive: true, force: true });
        return { purged: true };
      },
      async start() {
        await mkdir(downloadDir, { recursive: true });
        return { mode: "fixture" };
      },
      async stop() {
        return { stopped: true };
      },
    };
    const service = new MediaJobService(configDir, {
      runtimeResolver: async () => ({
        components: {
          ffmpeg: { path: "fixture-ffmpeg" },
          whisper: { path: "fixture-whisper" },
          whisperModel: { path: "fixture-model", version: "fixture-small" },
        },
      }),
      sidecar,
      transcriber: async () => ({
        artifacts: {
          audioPath: path.join(root, "fixture.wav"),
          jsonPath: path.join(root, "fixture.json"),
          srtPath: path.join(root, "fixture.srt"),
        },
        durationSeconds: 8,
        language: "zh",
        model: "fixture-small",
        segments: [{ start: 0, end: 8, text: "元宝解析成功后继续使用本地转写闭环。" }],
        transcript: "元宝解析成功后继续使用本地转写闭环。",
      }),
      yuanbaoResolver: {
        resolveVideo: async () => profile,
        session: { close: async () => {} },
      },
    });

    const run = async () => {
      const created = await service.create({
        note: "只使用临时 Inbox",
        resolverMode: "yuanbao-local",
        sourceType: "wechat",
        url: "https://weixin.qq.com/sph/yuanbao-local-fixture",
      });
      return waitForJob(service, created.jobId);
    };
    const first = await run();
    const duplicate = await run();
    assert.equal(first.status, "completed");
    assert.equal(first.result.captureStatus, "created");
    assert.equal(duplicate.result.captureStatus, "duplicate");
    const notes = (await readdir(inboxDir)).filter((name) => name.endsWith(".md"));
    assert.equal(notes.length, 1);
    const markdown = await readFile(path.join(inboxDir, notes[0]), "utf8");
    assert.match(markdown, /content_strategy: "wechat-yuanbao-local"/);
    assert.match(markdown, /元宝解析成功后继续使用本地转写闭环/);
    const jobFiles = await readdir(path.join(configDir, "state", "media-jobs"));
    for (const file of jobFiles) {
      const text = await readFile(path.join(configDir, "state", "media-jobs", file), "utf8");
      assert.doesNotMatch(text, /must-not-persist|1844674407370955161|hy_token/);
    }
    process.stdout.write(`${JSON.stringify({
      credentialsAccessed: false,
      duplicate: duplicate.result.captureStatus,
      first: first.result.captureStatus,
      mediaCleaned: first.workRetained === false && duplicate.workRetained === false,
      noteCount: notes.length,
      publicWorkerUsed: false,
      resolverMode: "yuanbao-local",
      temporaryInbox: true,
    }, null, 2)}\n`);
    return 0;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code ?? "VERIFY_YUANBAO_FAILED",
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
