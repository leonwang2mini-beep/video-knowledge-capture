import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AppConfigError,
  loadAppConfig,
  saveAppConfig,
} from "../src/app-config.mjs";
import { MediaJobService } from "../src/media-jobs.mjs";
import { startLocalApp } from "../src/server.mjs";

const silentLogger = { error() {}, log() {} };
const offlineContentExtractor = async () => ({
  errorCode: "TEST_OFFLINE",
  errorMessage: "测试未访问外部网络。",
  status: "unavailable",
  strategy: "test-fixture",
});

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-server-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

async function withLocalServer(configDir, run, {
  certificateManager,
  contentExtractor = offlineContentExtractor,
  directoryOpener,
  mediaJobService,
} = {}) {
  const { server, url } = await startLocalApp({
    certificateManager,
    configDir,
    contentExtractor,
    directoryOpener,
    logger: silentLogger,
    mediaJobService,
    port: 0,
  });
  try {
    return await run(url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function waitForHttpJob(url, jobId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { payload } = await jsonRequest(`${url}/api/media/jobs/${jobId}`);
    if (["completed", "failed"].includes(payload.job.status)) return payload.job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`HTTP media job ${jobId} did not finish`);
}

async function jsonRequest(url, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: body
      ? { "Content-Type": "application/json", ...headers }
      : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, payload: await response.json() };
}

test("app config accepts only an existing writable directory", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inbox = path.join(root, "Inbox");
    const retainedMediaDir = path.join(root, "large-drive", "retained-media");
    await mkdir(inbox);

    await assert.rejects(
      saveAppConfig(configDir, { inboxDir: path.join(root, "missing") }),
      (error) => error instanceof AppConfigError && error.code === "INBOX_NOT_FOUND",
    );
    const saved = await saveAppConfig(configDir, {
      inboxDir: `"${inbox}"`,
      retainedMediaDir: `"${retainedMediaDir}"`,
    });
    assert.equal(saved.inboxDir, inbox);
    assert.equal(saved.retainedMediaDir, retainedMediaDir);
    assert.deepEqual(await loadAppConfig(configDir), {
      inboxDir: inbox,
      retainedMediaDir,
      wechatAdvancedEnabled: false,
    });
    assert.equal((await readdir(retainedMediaDir)).length, 0);
    const configText = await readFile(path.join(configDir, "config.json"), "utf8");
    assert.doesNotMatch(configText, /token|cookie|password/i);
  });
});

test("local server serves the offline UI with security headers and rejects cross-origin writes", async () => {
  await withTempDirectory(async (root) => {
    await withLocalServer(path.join(root, "config"), async (url) => {
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /视频知识捕手/);
      assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
      assert.equal(page.headers.get("x-frame-options"), "DENY");

      const { response, payload } = await jsonRequest(`${url}/api/config`, {
        method: "PUT",
        body: { inboxDir: path.join(root, "Inbox") },
        headers: { Origin: "https://malicious.example" },
      });
      assert.equal(response.status, 403);
      assert.equal(payload.error.code, "ORIGIN_REJECTED");
    });
  });
});

test("local server opens only the configured retained-media directory on an explicit request", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inbox = path.join(root, "Inbox");
    const retainedMediaDir = path.join(root, "large-drive", "retained-media");
    await mkdir(inbox);
    await saveAppConfig(configDir, { inboxDir: inbox, retainedMediaDir });
    const opened = [];

    await withLocalServer(configDir, async (url) => {
      const openedResult = await jsonRequest(`${url}/api/retained-media/open`, {
        headers: { Origin: url },
        method: "POST",
      });
      assert.equal(openedResult.response.status, 200);
      assert.equal(openedResult.payload.retainedMediaDir, retainedMediaDir);
      assert.deepEqual(opened, [retainedMediaDir]);

      const rejected = await jsonRequest(`${url}/api/retained-media/open`, {
        headers: { Origin: "https://malicious.example" },
        method: "POST",
      });
      assert.equal(rejected.response.status, 403);
      assert.equal(rejected.payload.error.code, "ORIGIN_REJECTED");
      assert.deepEqual(opened, [retainedMediaDir]);

      const originless = await jsonRequest(`${url}/api/retained-media/open`, {
        method: "POST",
      });
      assert.equal(originless.response.status, 403);
      assert.equal(originless.payload.error.code, "ORIGIN_REQUIRED");
      assert.deepEqual(opened, [retainedMediaDir]);
    }, {
      directoryOpener: async (directoryPath) => opened.push(directoryPath),
    });
  });
});

test("HTTP workflow configures, captures, deduplicates, records failure and retries safely", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inbox = path.join(root, "Inbox");
    const retryInbox = path.join(root, "RetryInbox");
    await Promise.all([mkdir(inbox), mkdir(retryInbox)]);
    let extractionCalls = 0;
    const contentExtractor = async () => {
      extractionCalls += 1;
      return {
        author: "测试作者",
        description: "由可控夹具提供，不访问外部网络。",
        status: "extracted",
        strategy: "test-fixture",
        title: "测试视频标题",
      };
    };

    await withLocalServer(configDir, async (url) => {
      const initialStatus = await jsonRequest(`${url}/api/status`);
      assert.equal(initialStatus.response.status, 200);
      assert.equal(initialStatus.payload.configuration.configured, false);

      const configured = await jsonRequest(`${url}/api/config`, {
        method: "PUT",
        body: { inboxDir: inbox },
      });
      assert.equal(configured.response.status, 200);
      assert.equal(configured.payload.configuration.inboxStatus, "ready");

      const first = await jsonRequest(`${url}/api/captures`, {
        method: "POST",
        body: {
          url: "https://www.bilibili.com/video/BV-usable?utm_source=ui",
          note: "来自本地界面的采集",
          providedTitle: "用户提供的测试标题",
          transcript: "这是一段从界面提交的视频文案。",
        },
      });
      assert.equal(first.response.status, 201);
      assert.equal(first.payload.capture.status, "created");
      assert.equal(first.payload.capture.content.status, "extracted");
      assert.equal(first.payload.capture.content.title, "测试视频标题");
      assert.equal(first.payload.capture.material.status, "provided");
      assert.equal(
        first.payload.capture.material.transcriptCharCount,
        "这是一段从界面提交的视频文案。".length,
      );

      const duplicate = await jsonRequest(`${url}/api/captures`, {
        method: "POST",
        body: { url: "https://www.bilibili.com/video/BV-usable#again" },
      });
      assert.equal(duplicate.response.status, 200);
      assert.equal(duplicate.payload.capture.status, "duplicate");
      assert.equal(extractionCalls, 1);
      assert.equal((await readdir(inbox)).filter((name) => name.endsWith(".md")).length, 1);
      const markdown = await readFile(first.payload.capture.notePath, "utf8");
      assert.match(markdown, /content_status: "extracted"/);
      assert.match(markdown, /用户提供的测试标题/);
      assert.match(markdown, /这是一段从界面提交的视频文案/);

      const retryConfig = await jsonRequest(`${url}/api/config`, {
        method: "PUT",
        body: { inboxDir: retryInbox },
      });
      assert.equal(retryConfig.payload.configuration.inboxStatus, "ready");
      await rmdir(retryInbox);
      await writeFile(retryInbox, "intentional failure", "utf8");

      const failed = await jsonRequest(`${url}/api/captures`, {
        method: "POST",
        body: { url: "https://youtu.be/usable-retry", note: "等待重试" },
      });
      assert.equal(failed.response.status, 422);
      assert.equal(failed.payload.error.code, "NOTE_WRITE_FAILED");
      assert.ok(failed.payload.error.failureId);

      const pending = await jsonRequest(`${url}/api/failures`);
      assert.equal(pending.payload.pendingCount, 1);
      assert.equal(pending.payload.failures[0].failureId, failed.payload.error.failureId);

      await rm(retryInbox);
      await mkdir(retryInbox);
      const retried = await jsonRequest(
        `${url}/api/failures/${failed.payload.error.failureId}/retry`,
        { method: "POST", body: {} },
      );
      assert.equal(retried.response.status, 200);
      assert.equal(retried.payload.capture.status, "created");

      const resolved = await jsonRequest(`${url}/api/failures`);
      assert.equal(resolved.payload.pendingCount, 0);
      assert.equal(resolved.payload.failures[0].resolution, "resolved");
      assert.equal((await readdir(retryInbox)).filter((name) => name.endsWith(".md")).length, 1);
    }, { contentExtractor });
  });
});

test("HTTP capture reports metadata degradation while still creating the note", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inbox = path.join(root, "Inbox");
    await mkdir(inbox);
    const contentExtractor = async () => {
      const error = new Error("fixture timeout");
      error.code = "PUBLIC_FETCH_TIMEOUT";
      throw error;
    };

    await withLocalServer(configDir, async (url) => {
      await jsonRequest(`${url}/api/config`, {
        method: "PUT",
        body: { inboxDir: inbox },
      });
      const result = await jsonRequest(`${url}/api/captures`, {
        method: "POST",
        body: { url: "https://weixin.qq.com/sph/degraded" },
      });

      assert.equal(result.response.status, 201);
      assert.equal(result.payload.capture.status, "created");
      assert.equal(result.payload.capture.platform.id, "wechat-channels");
      assert.equal(result.payload.capture.content.status, "unavailable");
      assert.equal(result.payload.capture.content.errorCode, "PUBLIC_FETCH_TIMEOUT");
      const markdown = await readFile(result.payload.capture.notePath, "utf8");
      assert.match(markdown, /content_status: "unavailable"/);
      assert.match(markdown, /content_error_code: "PUBLIC_FETCH_TIMEOUT"/);
      assert.match(markdown, /当前仅保存了链接/);

      const enriched = await jsonRequest(`${url}/api/captures`, {
        method: "POST",
        body: {
          url: "https://weixin.qq.com/sph/degraded",
          providedTitle: "视频号内容补录",
          transcript: "这次把视频中真正讲述的内容补进原笔记。",
        },
      });
      assert.equal(enriched.response.status, 200);
      assert.equal(enriched.payload.capture.status, "updated");
      assert.equal(enriched.payload.capture.material.status, "provided");
      assert.equal((await readdir(inbox)).filter((name) => name.endsWith(".md")).length, 1);
      const enrichedMarkdown = await readFile(enriched.payload.capture.notePath, "utf8");
      assert.match(enrichedMarkdown, /title: "视频号内容补录"/);
      assert.match(enrichedMarkdown, /这次把视频中真正讲述的内容补进原笔记/);
    }, { contentExtractor });
  });
});

test("HTTP media upload completes the offline transcription workflow", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inbox = path.join(root, "Inbox");
    await mkdir(inbox);
    await saveAppConfig(configDir, { inboxDir: inbox });
    const sidecar = {
      async health() {
        return { clientReady: false, managedProcess: false, serviceReady: false };
      },
      async stop() {
        return { stopped: false };
      },
    };
    const mediaJobService = new MediaJobService(configDir, {
      runtimeResolver: async () => ({
        components: {
          ffmpeg: { path: path.join(root, "ffmpeg.exe") },
          whisper: { path: path.join(root, "whisper-cli.exe") },
          whisperModel: { path: path.join(root, "model.bin"), version: "fixture" },
        },
      }),
      sidecar,
      transcriber: async () => ({
        artifacts: {
          audioPath: path.join(configDir, "work", "audio.wav"),
          jsonPath: path.join(configDir, "work", "transcript.json"),
          srtPath: path.join(configDir, "work", "transcript.srt"),
        },
        durationSeconds: 3,
        language: "zh",
        model: "fixture",
        segments: [{ start: 0, end: 3, text: "HTTP 本地转写闭环。" }],
        transcript: "HTTP 本地转写闭环。",
      }),
    });

    await withLocalServer(configDir, async (url) => {
      const created = await jsonRequest(`${url}/api/media/jobs`, {
        method: "POST",
        body: {
          fileName: "fixture.mp4",
          keepMedia: true,
          providedTitle: "HTTP 媒体测试",
          sourceType: "local-upload",
          url: "https://example.com/http-media-fixture",
        },
      });
      assert.equal(created.response.status, 202);
      const uploaded = await fetch(
        `${url}/api/media/jobs/${created.payload.job.jobId}/source`,
        {
          body: Buffer.from("http-media-fixture"),
          headers: { "Content-Type": "application/octet-stream" },
          method: "PUT",
        },
      );
      assert.equal(uploaded.status, 202);
      const completed = await waitForHttpJob(url, created.payload.job.jobId);
      assert.equal(completed.status, "completed");
      assert.equal(completed.result.materialSource, "local-asr");
      assert.equal(completed.keepMedia, true);
      assert.equal(
        await readFile(completed.result.retainedMediaPath, "utf8"),
        "http-media-fixture",
      );
      assert.match(await readFile(completed.result.notePath, "utf8"), /HTTP 本地转写闭环/);
    }, { mediaJobService });
  });
});

test("one-box intake routes public platforms to download-ASR and unknown pages to link capture", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inbox = path.join(root, "Inbox");
    await mkdir(inbox);
    await saveAppConfig(configDir, { inboxDir: inbox });
    const mediaJobService = new MediaJobService(configDir, {
      publicDownloader: async ({ workDir }) => {
        const mediaPath = path.join(workDir, "source.mp4");
        await writeFile(mediaPath, "one-box-public-media");
        return {
          author: "一键作者",
          mediaPath,
          strategy: "yt-dlp-public",
          title: "一键收录测试",
          videoId: "one-box",
        };
      },
      runtimeResolver: async () => ({
        components: {
          ffmpeg: { path: path.join(root, "ffmpeg.exe") },
          whisper: { path: path.join(root, "whisper-cli.exe") },
          whisperModel: { path: path.join(root, "model.bin"), version: "fixture" },
          ytDlp: { path: path.join(root, "yt-dlp.exe") },
        },
      }),
      sidecar: {
        async health() { return { clientReady: false, serviceReady: false }; },
        async stop() { return { stopped: false }; },
      },
      transcriber: async () => ({
        artifacts: {
          audioPath: path.join(configDir, "work", "audio.wav"),
          jsonPath: path.join(configDir, "work", "transcript.json"),
          srtPath: path.join(configDir, "work", "transcript.srt"),
        },
        durationSeconds: 4,
        language: "zh",
        model: "fixture",
        segments: [{ start: 0, end: 4, text: "单一入口自动字幕。" }],
        transcript: "单一入口自动字幕。",
      }),
    });

    await withLocalServer(configDir, async (url) => {
      const media = await jsonRequest(`${url}/api/intakes`, {
        body: {
          keepMedia: true,
          url: "https://www.youtube.com/watch?v=one-box",
        },
        method: "POST",
      });
      assert.equal(media.response.status, 202);
      assert.equal(media.payload.intake.kind, "media-job");
      assert.equal(media.payload.intake.platform.id, "youtube");
      const completed = await waitForHttpJob(url, media.payload.job.jobId);
      assert.equal(completed.status, "completed");
      assert.equal(completed.result.materialSource, "public-url-asr");
      assert.match(await readFile(completed.result.notePath, "utf8"), /单一入口自动字幕/);

      const page = await jsonRequest(`${url}/api/intakes`, {
        body: { url: "https://example.com/article-with-unknown-video" },
        method: "POST",
      });
      assert.equal(page.response.status, 201);
      assert.equal(page.payload.intake.kind, "link-note");
      assert.equal(page.payload.capture.platform.id, "web");
    }, { mediaJobService });
  });
});

test("one-box WeChat intake fails before queueing when the explicit setup is absent", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inbox = path.join(root, "Inbox");
    await mkdir(inbox);
    await saveAppConfig(configDir, { inboxDir: inbox });

    await withLocalServer(configDir, async (url) => {
      const result = await jsonRequest(`${url}/api/intakes`, {
        body: { url: "https://weixin.qq.com/sph/one-box" },
        method: "POST",
      });
      assert.equal(result.response.status, 409);
      assert.equal(result.payload.error.code, "WECHAT_SETUP_REQUIRED");
    });
  });
});

test("HTTP Yuanbao session controls expose status only and require explicit advanced mode", async () => {
  await withTempDirectory(async (root) => {
    const configDir = path.join(root, "config");
    const inbox = path.join(root, "Inbox");
    await mkdir(inbox);
    await saveAppConfig(configDir, { inboxDir: inbox });
    let state = "idle";
    let configured = false;
    const status = async () => ({ configured, error: null, state });
    const session = {
      async cancelLogin() {
        state = "cancelled";
        return status();
      },
      async close() {},
      async forget() {
        configured = false;
        state = "idle";
        return status();
      },
      async startLogin() {
        state = "waiting-for-login";
        return status();
      },
      status,
    };
    const mediaJobService = new MediaJobService(configDir, {
      sidecar: {
        async health() { return { clientReady: false, serviceReady: false }; },
        async stop() { return { stopped: false }; },
      },
      yuanbaoResolver: { session },
    });

    await withLocalServer(configDir, async (url) => {
      const initial = await jsonRequest(`${url}/api/yuanbao/status`);
      assert.equal(initial.response.status, 200);
      assert.deepEqual(initial.payload.yuanbao, {
        configured: false,
        error: null,
        state: "idle",
      });

      const rejected = await jsonRequest(`${url}/api/yuanbao/login/start`, {
        body: {},
        method: "POST",
      });
      assert.equal(rejected.response.status, 409);
      assert.equal(rejected.payload.error.code, "WECHAT_ADVANCED_MODE_DISABLED");

      await saveAppConfig(configDir, { wechatAdvancedEnabled: true });
      const started = await jsonRequest(`${url}/api/yuanbao/login/start`, {
        body: {},
        method: "POST",
      });
      assert.equal(started.response.status, 202);
      assert.equal(started.payload.yuanbao.state, "waiting-for-login");

      const cancelled = await jsonRequest(`${url}/api/yuanbao/login/cancel`, {
        body: {},
        method: "POST",
      });
      assert.equal(cancelled.response.status, 200);
      assert.equal(cancelled.payload.yuanbao.state, "cancelled");

      const forgotten = await jsonRequest(`${url}/api/yuanbao/session/forget`, {
        body: {},
        method: "POST",
      });
      assert.equal(forgotten.payload.yuanbao.configured, false);
      assert.doesNotMatch(JSON.stringify(forgotten.payload), /cookie|hy_token|protectedValue/i);
    }, { mediaJobService });
  });
});
