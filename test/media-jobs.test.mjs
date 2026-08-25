import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveAppConfig } from "../src/app-config.mjs";
import { MediaJobService } from "../src/media-jobs.mjs";
import { PublicMediaDownloadError } from "../src/public-media-downloader.mjs";
import { MediaProcessingError } from "../src/transcriber.mjs";

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-media-job-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForJob(service, jobId, statuses = ["completed", "failed"]) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await service.get(jobId);
    if (statuses.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`job ${jobId} did not finish`);
}

function fakeRuntime(root) {
  return async () => ({
    components: {
      ffmpeg: { path: path.join(root, "ffmpeg.exe") },
      whisper: { path: path.join(root, "whisper-cli.exe") },
      whisperModel: { path: path.join(root, "ggml-small.bin"), version: "fixture" },
      ytDlp: { path: path.join(root, "yt-dlp.exe"), version: "fixture" },
    },
  });
}

function successfulTranscription() {
  return {
    artifacts: {
      audioPath: "audio.wav",
      jsonPath: "transcript.json",
      srtPath: "transcript.srt",
    },
    durationSeconds: 12.5,
    language: "zh",
    model: "fixture",
    segments: [
      { start: 0, end: 5, text: "第一段本地字幕。" },
      { start: 5, end: 12.5, text: "第二段本地字幕。" },
    ],
    transcript: "第一段本地字幕。\n第二段本地字幕。",
  };
}

test("local media job writes timestamped Markdown, deduplicates and cleans media", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inboxDir = path.join(root, "Inbox");
    await mkdir(inboxDir);
    await saveAppConfig(configDir, { inboxDir });
    const service = new MediaJobService(configDir, {
      contentExtractor: async () => ({ status: "unavailable", strategy: "test" }),
      runtimeResolver: fakeRuntime(root),
      transcriber: async () => successfulTranscription(),
    });

    const createAndUpload = async () => {
      const created = await service.create({
        fileName: "chosen-video.mp4",
        note: "由测试用户主动选择",
        providedTitle: "本机视频测试",
        sourceType: "local-upload",
        url: "https://example.com/watch/local-fixture",
      });
      await service.acceptUpload(
        created.jobId,
        Readable.from([Buffer.from("media-fixture")]),
        { contentLength: 13 },
      );
      return waitForJob(service, created.jobId);
    };

    const first = await createAndUpload();
    const second = await createAndUpload();
    assert.equal(first.status, "completed");
    assert.equal(first.result.captureStatus, "created");
    assert.equal(second.result.captureStatus, "duplicate");
    assert.equal((await readdir(inboxDir)).filter((name) => name.endsWith(".md")).length, 1);
    const markdown = await readFile(first.result.notePath, "utf8");
    assert.match(markdown, /material_source: "local-asr"/);
    assert.match(markdown, /### 时间线/);
    assert.match(markdown, /\[00:00:00\] 第一段本地字幕/);
    assert.match(markdown, /机器转写/);
    await assert.rejects(stat(path.join(configDir, "work", "jobs", first.jobId)));
  });
});

test("public URL job downloads one video, transcribes it and keeps one content-addressed copy", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inboxDir = path.join(root, "Inbox");
    await mkdir(inboxDir);
    await saveAppConfig(configDir, { inboxDir });
    let receivedKeepMedia = null;
    const service = new MediaJobService(configDir, {
      publicDownloader: async ({ keepMedia, workDir }) => {
        receivedKeepMedia = keepMedia;
        const mediaPath = path.join(workDir, "source.mp4");
        await writeFile(mediaPath, "downloaded-public-media");
        return {
          author: "公开作者",
          downloadAttempt: 1,
          downloadProfile: "balanced-video-720p",
          estimatedSize: 1024,
          formatId: "18",
          mediaPath,
          resolution: "640x360",
          strategy: "yt-dlp-public",
          title: "自动下载测试",
          videoId: "public-fixture",
        };
      },
      runtimeResolver: fakeRuntime(root),
      transcriber: async () => successfulTranscription(),
    });

    const created = await service.create({
      keepMedia: true,
      sourceType: "public-url",
      url: "https://www.youtube.com/watch?v=public-fixture",
    });
    const completed = await waitForJob(service, created.jobId);

    assert.equal(completed.status, "completed");
    assert.equal(receivedKeepMedia, true);
    assert.equal(completed.result.materialSource, "public-url-asr");
    assert.equal(completed.sourceMetadata.downloadProfile, "balanced-video-720p");
    assert.equal(completed.sourceMetadata.resolution, "640x360");
    assert.equal(await readFile(completed.result.retainedMediaPath, "utf8"), "downloaded-public-media");
    const markdown = await readFile(completed.result.notePath, "utf8");
    assert.match(markdown, /content_strategy: "yt-dlp-public"/);
    assert.match(markdown, /自动下载测试/);
    assert.match(markdown, /第一段本地字幕/);
  });
});

test("public URL job persists only bounded download diagnostics for safe retry", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inboxDir = path.join(root, "Inbox");
    await mkdir(inboxDir);
    await saveAppConfig(configDir, { inboxDir });
    const service = new MediaJobService(configDir, {
      publicDownloader: async () => {
        throw new PublicMediaDownloadError(
          "公开视频传输超时或中断，已尝试较小的兼容格式；可稍后安全重试。",
          "PUBLIC_MEDIA_DOWNLOAD_FAILED",
          {
            cause: new Error("secret media URL must not persist"),
            details: {
              attempt: 2,
              attempts: 2,
              estimatedSize: 25000000,
              exitCode: 1,
              failureCategory: "transfer-failed",
              fallbackAttempted: true,
              formatId: "18",
              profile: "compatibility-video-480p",
              resolution: "640x360",
              unsafe: "must-not-persist",
            },
            retryable: true,
          },
        );
      },
      runtimeResolver: fakeRuntime(root),
    });
    const created = await service.create({
      keepMedia: true,
      sourceType: "public-url",
      url: "https://www.youtube.com/watch?v=diagnostic-fixture",
    });
    const failed = await waitForJob(service, created.jobId, ["failed"]);

    assert.equal(failed.error.code, "PUBLIC_MEDIA_DOWNLOAD_FAILED");
    assert.equal(failed.error.details.failureCategory, "transfer-failed");
    assert.equal(failed.error.details.profile, "compatibility-video-480p");
    assert.equal(failed.error.details.fallbackAttempted, true);
    assert.equal(failed.error.details.unsafe, undefined);
    const persisted = await readFile(
      path.join(configDir, "state", "media-jobs", `${created.jobId}.json`),
      "utf8",
    );
    assert.doesNotMatch(persisted, /secret media URL|must-not-persist/);
  });
});

test("successful media retention is content-addressed, idempotent and outside the work directory", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inboxDir = path.join(root, "Inbox");
    const retainedMediaDir = path.join(root, "external-video-storage");
    await mkdir(inboxDir);
    await saveAppConfig(configDir, { inboxDir, retainedMediaDir });
    const service = new MediaJobService(configDir, {
      contentExtractor: async () => ({ status: "unavailable", strategy: "test" }),
      runtimeResolver: fakeRuntime(root),
      transcriber: async () => successfulTranscription(),
    });
    const run = async () => {
      const created = await service.create({
        fileName: "retained-video.mp4",
        keepMedia: true,
        providedTitle: "保留媒体测试",
        sourceType: "local-upload",
        url: "https://example.com/watch/retained-fixture",
      });
      await service.acceptUpload(
        created.jobId,
        Readable.from([Buffer.from("retained-media")]),
      );
      return waitForJob(service, created.jobId);
    };

    const first = await run();
    const duplicate = await run();
    assert.equal(first.status, "completed");
    assert.equal(first.keepMedia, true);
    assert.equal(first.result.retainedMediaPath, duplicate.result.retainedMediaPath);
    assert.equal(first.result.retainedMediaSize, 14);
    assert.match(first.result.retainedMediaSha256, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(first.result.retainedMediaPath, "utf8"), "retained-media");
    assert.equal(
      path.relative(retainedMediaDir, first.result.retainedMediaPath).startsWith(".."),
      false,
    );
    await assert.rejects(stat(path.join(configDir, "work", "jobs", first.jobId)));

    await assert.rejects(
      service.create({
        fileName: "invalid.mp4",
        keepMedia: "yes",
        sourceType: "local-upload",
        url: "https://example.com/watch/invalid-retain-option",
      }),
      (error) => error.code === "MEDIA_KEEP_OPTION_INVALID",
    );
  });
});

test("retryable transcription failure retains the media and succeeds on retry", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inboxDir = path.join(root, "Inbox");
    await mkdir(inboxDir);
    await saveAppConfig(configDir, { inboxDir });
    let attempts = 0;
    const service = new MediaJobService(configDir, {
      runtimeResolver: fakeRuntime(root),
      transcriber: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new MediaProcessingError("fixture failure", "TRANSCRIPTION_FAILED", {
            retryable: true,
            stage: "transcribe",
          });
        }
        return successfulTranscription();
      },
    });
    const created = await service.create({
      fileName: "retry.mp4",
      sourceType: "local-upload",
      url: "https://example.com/watch/retry-fixture",
    });
    await service.acceptUpload(created.jobId, Readable.from([Buffer.from("retry-media")]));
    const failed = await waitForJob(service, created.jobId, ["failed"]);
    assert.equal(failed.error.code, "TRANSCRIPTION_FAILED");
    assert.equal(failed.retryable, true);
    assert.equal(failed.workRetained, true);

    await service.retry(created.jobId);
    const completed = await waitForJob(service, created.jobId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.captureStatus, "created");
    assert.equal(attempts, 2);
  });
});

test("retry canonicalizes a persisted Douyin modal container before downloading", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inboxDir = path.join(root, "Inbox");
    await mkdir(inboxDir);
    await saveAppConfig(configDir, { inboxDir });
    const modalUrl = "https://www.douyin.com/jingxuan/course/search/example?modal_id=7000000000000000001&type=general";
    const detailUrl = "https://www.douyin.com/video/7000000000000000001";
    const receivedUrls = [];
    const service = new MediaJobService(configDir, {
      publicDownloader: async ({ url, workDir }) => {
        receivedUrls.push(url);
        if (receivedUrls.length === 1) {
          throw new PublicMediaDownloadError(
            "fixture retry",
            "PUBLIC_MEDIA_DOWNLOAD_FAILED",
            { retryable: true },
          );
        }
        const mediaPath = path.join(workDir, "source.mp4");
        await writeFile(mediaPath, "douyin-retry-media");
        return {
          author: "公开作者",
          mediaPath,
          strategy: "yt-dlp-public",
          title: "抖音容器链接重试",
          videoId: "7000000000000000001",
        };
      },
      runtimeResolver: fakeRuntime(root),
      transcriber: async () => successfulTranscription(),
    });

    const created = await service.create({
      keepMedia: false,
      sourceType: "public-url",
      url: detailUrl,
    });
    const failed = await waitForJob(service, created.jobId, ["failed"]);
    assert.equal(failed.retryable, true);

    const persistedJob = service.jobs.get(created.jobId);
    persistedJob.request.url = modalUrl;
    await service.persist(persistedJob);

    await service.retry(created.jobId);
    const completed = await waitForJob(service, created.jobId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.sourceUrl, detailUrl);
    assert.deepEqual(receivedUrls, [detailUrl, detailUrl]);
  });
});

test("wechat job requires explicit mode and uses only managed temporary media", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inboxDir = path.join(root, "Inbox");
    const downloadDir = path.join(configDir, "work", "wechat-downloads");
    await Promise.all([mkdir(inboxDir), mkdir(downloadDir, { recursive: true })]);
    await saveAppConfig(configDir, { inboxDir, wechatAdvancedEnabled: true });
    const mediaPath = path.join(downloadDir, "finder-fixture.mp4");
    await writeFile(mediaPath, "wechat-media");
    const sidecar = {
      async download() {
        return {
          author: "测试视频号",
          mediaPath,
          title: "微信内容闭环测试",
          videoId: "finder-fixture",
        };
      },
      async purgeManagedArtifacts() {
        return { purged: true };
      },
      async stop() {
        return { stopped: true };
      },
    };
    const service = new MediaJobService(configDir, {
      runtimeResolver: fakeRuntime(root),
      sidecar,
      transcriber: async () => successfulTranscription(),
    });
    const created = await service.create({
      sourceType: "wechat",
      url: "https://weixin.qq.com/sph/fixture-id",
    });
    const completed = await waitForJob(service, created.jobId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.materialSource, "wechat-local-asr");
    const markdown = await readFile(completed.result.notePath, "utf8");
    assert.match(markdown, /content_strategy: "wechat-local-sidecar"/);
    assert.match(markdown, /微信内容闭环测试/);
    await assert.rejects(stat(mediaPath));
  });
});

test("Yuanbao resolver feeds a matching profile into the managed WeChat downloader without persisting tokens", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inboxDir = path.join(root, "Inbox");
    const downloadDir = path.join(configDir, "work", "wechat-downloads");
    await Promise.all([mkdir(inboxDir), mkdir(downloadDir, { recursive: true })]);
    await saveAppConfig(configDir, { inboxDir, wechatAdvancedEnabled: true });
    const mediaPath = path.join(downloadDir, "yuanbao-fixture.mp4");
    await writeFile(mediaPath, "wechat-media");
    let started = 0;
    let receivedProfile = null;
    const profile = {
      author: "元宝解析作者",
      download: {
        id: "video-id",
        key: "1844674407370955161",
        url: "https://finder.video.qq.com/video.mp4?token=secret-media-token",
      },
      id: "video-id",
      title: "元宝内容闭环测试",
    };
    const sidecar = {
      async downloadResolvedProfile(value) {
        receivedProfile = value;
        return {
          author: value.author,
          mediaPath,
          title: value.title,
          videoId: value.id,
        };
      },
      async purgeManagedArtifacts() {
        return { purged: true };
      },
      async start() {
        started += 1;
        return { mode: "started" };
      },
      async stop() {
        return { stopped: true };
      },
    };
    const service = new MediaJobService(configDir, {
      runtimeResolver: fakeRuntime(root),
      sidecar,
      transcriber: async () => successfulTranscription(),
      yuanbaoResolver: { resolveVideo: async () => profile },
    });
    const created = await service.create({
      resolverMode: "yuanbao-local",
      sourceType: "wechat",
      url: "https://weixin.qq.com/sph/yuanbao-fixture",
    });
    const completed = await waitForJob(service, created.jobId);

    assert.equal(started, 1);
    assert.equal(receivedProfile, profile);
    assert.equal(completed.status, "completed");
    assert.equal(completed.resolverMode, "yuanbao-local");
    const markdown = await readFile(completed.result.notePath, "utf8");
    assert.match(markdown, /content_strategy: "wechat-yuanbao-local"/);
    const persistedJob = await readFile(
      path.join(configDir, "state", "media-jobs", `${created.jobId}.json`),
      "utf8",
    );
    assert.doesNotMatch(persistedJob, /secret-media-token|1844674407370955161|decodeKey/);
  });
});
