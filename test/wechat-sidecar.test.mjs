import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WechatSidecar,
  parseWechatBrowseProfile,
  parseWechatProfile,
  parseWechatResolvedProfile,
  WechatSidecarError,
} from "../src/wechat-sidecar.mjs";

async function createRuntimeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-sidecar-"));
  const runtimeDir = path.join(root, "runtime");
  const executable = path.join(runtimeDir, "wx-channel-fixture.exe");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(executable, "fixture");
  await writeFile(path.join(runtimeDir, "runtime-manifest.json"), JSON.stringify({
    components: {
      wxChannel: {
        fileDigest: createHash("sha256").update("fixture").digest("hex"),
        fileDigestAlgorithm: "sha256",
        path: executable,
      },
    },
  }));
  return root;
}

test("parseWechatProfile extracts the observed video URL and decode key", () => {
  const profile = parseWechatProfile({
    code: 0,
    data: {
      id: "finder-object-1",
      contact: { nickname: "测试视频号" },
      objectDesc: {
        description: "被用户主动选择的视频",
        media: [{
          decodeKey: "123456",
          spec: [{ durationMs: 12345, fileFormat: "mp4" }],
          url: "https://finder.video.qq.com/fixture.mp4",
          urlToken: "?token=temporary",
        }],
      },
    },
  }, "https://weixin.qq.com/sph/example");

  assert.equal(profile.id, "finder-object-1");
  assert.equal(profile.title, "被用户主动选择的视频");
  assert.equal(profile.author, "测试视频号");
  assert.equal(profile.download.key, "123456");
  assert.equal(
    profile.download.url,
    "https://finder.video.qq.com/fixture.mp4?token=temporary",
  );
  assert.equal(profile.download.durationMs, 12345);
});

test("parseWechatProfile fails safely when desktop WeChat has not observed the video", () => {
  assert.throws(
    () => parseWechatProfile({ code: 0, data: {} }, "https://weixin.qq.com/sph/example"),
    (error) => (
      error instanceof WechatSidecarError
      && error.code === "WECHAT_VIDEO_NOT_OBSERVED"
      && error.retryable === true
    ),
  );
});

test("parseWechatResolvedProfile converts the dedicated share resolver response", () => {
  const profile = parseWechatResolvedProfile({
    code: 0,
    data: {
      failed: [],
      resolved: [{
        authorName: "分享视频号",
        durationMs: 23456,
        id: "shared-object-1",
        key: "987654",
        resolution: "1080p",
        title: "通过分享链路选择的视频",
        url: "https://finder.video.qq.com/fixture.mp4?token=temporary",
      }],
    },
  }, "https://weixin.qq.com/sph/example");

  assert.equal(profile.id, "shared-object-1");
  assert.equal(profile.title, "通过分享链路选择的视频");
  assert.equal(profile.author, "分享视频号");
  assert.equal(profile.download.durationMs, 23456);
  assert.equal(profile.download.key, "987654");
  assert.equal(profile.download.resolution, "1080p");
});

test("parseWechatBrowseProfile accepts only a fresh current WeChat page record", () => {
  const observedAt = Date.now();
  const payload = {
    code: 0,
    data: {
      items: [{
        author: "当前视频号",
        browseTime: new Date(observedAt + 100).toISOString(),
        decryptKey: "123456",
        duration: 12,
        fileFormat: "mp4",
        id: "current-object-1",
        pageUrl: "https://channels.weixin.qq.com/web/pages/feed",
        resolution: "1080p",
        title: "当前页面视频",
        videoUrl: "https://finder.video.qq.com/current.mp4?token=temporary",
      }],
    },
  };

  const profile = parseWechatBrowseProfile(
    payload,
    "https://weixin.qq.com/sph/example",
    { notBeforeMs: observedAt },
  );

  assert.equal(profile.id, "current-object-1");
  assert.equal(profile.download.durationMs, 12000);
  assert.equal(profile.download.key, "123456");
  assert.throws(
    () => parseWechatBrowseProfile(payload, "https://weixin.qq.com/sph/example", {
      notBeforeMs: observedAt + 10000,
    }),
    (error) => error.code === "WECHAT_CURRENT_VIDEO_NOT_OBSERVED",
  );
});

test("WechatSidecar prefers share resolution and falls back to feed profile", async () => {
  const requested = [];
  const fetchImpl = async (url, options = {}) => {
    requested.push({ method: options.method ?? "GET", url: String(url) });
    if (String(url).endsWith("/api/channels/share/resolve")) {
      return new Response(JSON.stringify({ code: 0, data: { failed: [], resolved: [] } }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).includes("/api/browse?")) {
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      code: 0,
      data: {
        contact: { nickname: "回退视频号" },
        id: "fallback-object-1",
        objectDesc: {
          description: "旧详情接口回退",
          media: [{ url: "https://finder.video.qq.com/fallback.mp4" }],
        },
      },
    }), { headers: { "Content-Type": "application/json" } });
  };
  const sidecar = new WechatSidecar(process.cwd(), { fetchImpl });

  const profile = await sidecar.resolveVideo("https://weixin.qq.com/sph/example");

  assert.equal(profile.id, "fallback-object-1");
  assert.deepEqual(requested.map((entry) => entry.method), ["POST", "GET", "GET"]);
  assert.match(requested[0].url, /\/api\/channels\/share\/resolve$/);
  assert.match(requested[1].url, /\/api\/browse\?/);
  assert.match(requested[2].url, /\/api\/channels\/feed\/profile\?url=/);
});

test("WechatSidecar preserves 64-bit WeChat decrypt keys without Number rounding", async () => {
  const exactKey = "18446744073709551615";
  const fetchImpl = async () => new Response(
    `{"code":0,"data":{"failed":[],"resolved":[{"authorName":"测试视频号","id":"exact-key-video","key":${exactKey},"title":"精确密钥","url":"https://finder.video.qq.com/exact.mp4"}]}}`,
    { headers: { "Content-Type": "application/json" } },
  );
  const sidecar = new WechatSidecar(process.cwd(), { fetchImpl });

  const profile = await sidecar.resolveVideo("https://weixin.qq.com/sph/example");

  assert.equal(profile.download.key, exactKey);
});

test("WechatSidecar current-page gate requires a ready client and never uses share resolution", async () => {
  const requested = [];
  let ready = false;
  const observedAt = Date.now();
  const fetchImpl = async (url) => {
    const target = String(url);
    requested.push(target);
    if (target.endsWith("/api/health")) {
      return new Response(JSON.stringify({ code: 0, data: { ready: true } }));
    }
    if (target.endsWith("/api/channels/status")) {
      return new Response(JSON.stringify({ code: 0, data: { ready_clients: ready ? 1 : 0 } }));
    }
    if (target.includes("/api/browse?")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          items: [{
            author: "实时视频号",
            browseTime: new Date(observedAt + 100).toISOString(),
            decryptKey: "123456",
            id: "current-gated-video",
            pageUrl: "https://channels.weixin.qq.com/web/pages/feed",
            title: "本次页面视频",
            videoUrl: "https://finder.video.qq.com/current-gated.mp4",
          }],
        },
      }));
    }
    throw new Error(`Unexpected request: ${target}`);
  };
  const sidecar = new WechatSidecar(process.cwd(), { fetchImpl });

  await assert.rejects(
    sidecar.resolveCurrentPageVideo("https://weixin.qq.com/sph/example", {
      notBeforeMs: observedAt,
    }),
    (error) => error.code === "WECHAT_CLIENT_NOT_READY",
  );
  ready = true;
  const profile = await sidecar.resolveCurrentPageVideo(
    "https://weixin.qq.com/sph/example",
    { notBeforeMs: observedAt },
  );

  assert.equal(profile.id, "current-gated-video");
  assert.equal(requested.some((target) => target.endsWith("/api/channels/share/resolve")), false);
});

test("WechatSidecar reports an early child exit instead of a generic startup timeout", async (t) => {
  const root = await createRuntimeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.pid = 42;
  child.kill = () => true;
  let spawnOptions = null;
  const sidecar = new WechatSidecar(root, {
    bufferRuntimeFactory: async () => ({
      captureDir: path.join(root, "buffer-run", "downloads", "capture"),
      downloadDir: path.join(root, "buffer-run", "downloads"),
      executablePath: path.join(root, "runtime", "wx-channel-fixture.exe"),
      runId: "fixture-run-12345678",
      runRoot: path.join(root, "buffer-run"),
    }),
    fetchImpl: async () => { throw new Error("offline"); },
    pollIntervalMs: 1,
    spawnImpl: (executable, args, options) => {
      spawnOptions = options;
      setImmediate(() => child.emit("exit", 2, null));
      return child;
    },
    startupTimeoutMs: 100,
  });

  await assert.rejects(
    sidecar.start(),
    (error) => (
      error instanceof WechatSidecarError
      && error.code === "WECHAT_SIDECAR_EXITED"
      && /退出码 2/.test(error.message)
    ),
  );
  assert.equal(spawnOptions.cwd, path.join(root, "buffer-run"));
});

test("WechatSidecar adopts a valid audio buffer capture from its isolated run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-buffer-adoption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sidecar = new WechatSidecar(root, {
    bufferCaptureTimeoutMs: 50,
    pollIntervalMs: 1,
  });
  sidecar.bufferRunId = "buffer-run-12345678";
  sidecar.captureDir = path.join(root, "buffer-captures");
  await mkdir(sidecar.captureDir, { recursive: true });
  const capturePath = path.join(
    sidecar.captureDir,
    "p0004-buffer-run-12345678-buffer-1-audio_mp4.mp4",
  );
  await writeFile(capturePath, Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftyp", "ascii"),
    Buffer.alloc(56, 0x11),
  ]));

  const adopted = await sidecar.waitForBufferCapture();

  assert.equal(adopted.startsWith(sidecar.downloadDir), true);
  assert.equal((await stat(adopted)).size, 64);
  await assert.rejects(stat(capturePath), (error) => error?.code === "ENOENT");
});

test("WechatSidecar ignores captures outside the active run namespace", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-buffer-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sidecar = new WechatSidecar(root, {
    bufferCaptureTimeoutMs: 10,
    pollIntervalMs: 1,
  });
  sidecar.bufferRunId = "active-run-12345678";
  sidecar.captureDir = path.join(root, "buffer-captures");
  await mkdir(sidecar.captureDir, { recursive: true });
  await writeFile(
    path.join(sidecar.captureDir, "p0004-other-run-12345678-buffer-1-audio_mp4.mp4"),
    Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftyp"), Buffer.alloc(20)]),
  );

  assert.equal(await sidecar.waitForBufferCapture(), null);
});

test("WechatSidecar retries a failed keyed download once as an unencrypted stream", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-plain-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sidecar = new WechatSidecar(root, { pollIntervalMs: 1 });
  await mkdir(sidecar.downloadDir, { recursive: true });
  const mediaPath = path.join(sidecar.downloadDir, "plain-retry.mp4");
  const validMediaFixture = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.from("valid-media-fixture", "ascii"),
  ]);
  await writeFile(mediaPath, validMediaFixture);
  const batches = [];
  let progressCalls = 0;
  sidecar.fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/api/health")) {
      return new Response(JSON.stringify({ code: 0, data: { ready: true } }));
    }
    if (target.endsWith("/api/channels/status")) {
      return new Response(JSON.stringify({ code: 0, data: { ready_clients: 1 } }));
    }
    if (target.endsWith("/api/channels/share/resolve")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          failed: [],
          resolved: [{
            authorName: "测试作者",
            id: "keyed-video",
            key: "stale-key",
            title: "需要原始流回退的视频",
            url: "https://finder.video.qq.com/keyed.mp4",
          }],
        },
      }));
    }
    if (target.endsWith("/__wx_channels_api/batch_start")) {
      batches.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ success: true, data: { started: true } }));
    }
    if (target.endsWith("/__wx_channels_api/batch_progress")) {
      progressCalls += 1;
      return new Response(JSON.stringify({
        success: true,
        data: progressCalls === 1
          ? { failed: 1, running: 0 }
          : { failed: 0, running: 0 },
      }));
    }
    if (target.includes("/api/downloads?")) {
      const retryId = batches[1]?.videos?.[0]?.id;
      return new Response(JSON.stringify({
        code: 0,
        data: {
          items: progressCalls > 1 ? [{
            filePath: mediaPath,
            status: "completed",
            videoId: retryId,
          }] : [],
        },
      }));
    }
    throw new Error(`Unexpected request: ${target}`);
  };

  const result = await sidecar.download("https://weixin.qq.com/sph/example", {
    timeoutMs: 5000,
  });

  assert.equal(result.mediaPath, mediaPath);
  assert.equal(result.videoId, "keyed-video");
  assert.equal(batches.length, 2);
  assert.equal(batches[0].videos[0].key, "stale-key");
  assert.equal(batches[1].videos[0].key, "");
  assert.equal(batches[1].forceRedownload, true);
  assert.match(batches[1].videos[0].id, /^keyed-video-plain-/);
});

test("WechatSidecar adopts a fresh upstream download into its managed work directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-adopt-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstreamDir = path.join(root, "runtime", "downloads");
  const upstreamMediaPath = path.join(upstreamDir, "作者", "刚下载的视频.mp4");
  await mkdir(path.dirname(upstreamMediaPath), { recursive: true });
  const validMediaFixture = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.from("fresh-upstream-media", "ascii"),
  ]);
  await writeFile(upstreamMediaPath, validMediaFixture);

  const sidecar = new WechatSidecar(path.join(root, "config"), { pollIntervalMs: 1 });
  sidecar.upstreamDownloadDir = upstreamDir;
  sidecar.fetchImpl = async (url) => {
    const target = String(url);
    if (target.endsWith("/api/health")) {
      return new Response(JSON.stringify({ code: 0, data: { ready: true } }));
    }
    if (target.endsWith("/api/channels/status")) {
      return new Response(JSON.stringify({ code: 0, data: { ready_clients: 1 } }));
    }
    if (target.endsWith("/api/channels/share/resolve")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          failed: [],
          resolved: [{
            authorName: "测试作者",
            id: "fresh-video",
            key: "",
            title: "刚下载的视频",
            url: "https://finder.video.qq.com/fresh.mp4",
          }],
        },
      }));
    }
    if (target.endsWith("/__wx_channels_api/batch_start")) {
      return new Response(JSON.stringify({ success: true, data: { started: true } }));
    }
    if (target.endsWith("/__wx_channels_api/batch_progress")) {
      return new Response(JSON.stringify({ success: true, data: { failed: 0, running: 0 } }));
    }
    if (target.includes("/api/downloads?")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          items: [{
            filePath: upstreamMediaPath,
            status: "completed",
            videoId: "fresh-video",
          }],
        },
      }));
    }
    throw new Error(`Unexpected request: ${target}`);
  };

  const result = await sidecar.download("https://weixin.qq.com/sph/example", {
    timeoutMs: 5000,
  });

  assert.equal((await stat(result.mediaPath)).size, validMediaFixture.length);
  assert.equal(path.dirname(result.mediaPath), sidecar.downloadDir);
  await assert.rejects(stat(upstreamMediaPath), { code: "ENOENT" });
});

test("WechatSidecar reports and removes an encrypted plain-stream fallback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-encrypted-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sidecar = new WechatSidecar(root, { pollIntervalMs: 1 });
  await mkdir(sidecar.downloadDir, { recursive: true });
  const mediaPath = path.join(sidecar.downloadDir, "still-encrypted.mp4");
  await writeFile(mediaPath, Buffer.alloc(64, 0xa5));
  sidecar.fetchImpl = async (url) => {
    const target = String(url);
    if (target.endsWith("/api/health")) {
      return new Response(JSON.stringify({ code: 0, data: { ready: true } }));
    }
    if (target.endsWith("/api/channels/status")) {
      return new Response(JSON.stringify({ code: 0, data: { ready_clients: 1 } }));
    }
    if (target.endsWith("/api/channels/share/resolve")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          failed: [],
          resolved: [{
            authorName: "测试作者",
            id: "encrypted-video",
            key: "",
            title: "仍是密文的视频",
            url: "https://finder.video.qq.com/encrypted.mp4",
          }],
        },
      }));
    }
    if (target.endsWith("/__wx_channels_api/batch_start")) {
      return new Response(JSON.stringify({ success: true, data: { started: true } }));
    }
    if (target.endsWith("/__wx_channels_api/batch_progress")) {
      return new Response(JSON.stringify({ success: true, data: { failed: 0, running: 0 } }));
    }
    if (target.includes("/api/downloads?")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          items: [{
            filePath: mediaPath,
            status: "completed",
            videoId: "encrypted-video",
          }],
        },
      }));
    }
    throw new Error(`Unexpected request: ${target}`);
  };

  await assert.rejects(
    sidecar.download("https://weixin.qq.com/sph/example", { timeoutMs: 5000 }),
    (error) => error.code === "WECHAT_DECRYPTION_FAILED" && error.stage === "decrypt-wechat",
  );
  await assert.rejects(stat(mediaPath), { code: "ENOENT" });
});
