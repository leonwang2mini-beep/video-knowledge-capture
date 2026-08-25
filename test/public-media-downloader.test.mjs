import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AnonymousBrowserSessionError,
  DOUYIN_ANONYMOUS_SESSION_TIMEOUT_MS,
} from "../src/anonymous-browser-session.mjs";
import {
  downloadPublicMedia,
  PublicMediaDownloadError,
} from "../src/public-media-downloader.mjs";

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-public-downloader-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeSpawnFactory(onSpawn) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(async () => {
      try {
        const exitCode = await onSpawn({ args, command, options, stderr: child.stderr, stdout: child.stdout });
        child.emit("exit", Number.isInteger(exitCode) ? exitCode : 0);
      } catch (error) {
        child.emit("error", error);
      }
    });
    return child;
  };
}

test("public downloader uses one credential-free yt-dlp task and returns only safe metadata", async () => {
  await withTempDirectory(async (workDir) => {
    let receivedArgs = null;
    const spawnImpl = fakeSpawnFactory(async ({ args, stdout }) => {
      receivedArgs = args;
      await writeFile(path.join(workDir, "source.mp4"), "public-media-fixture");
      stdout.end('__VKC_META__"video-1"\t"公开课"\t"测试作者"\t"18"\t"640x360"\t25335244\n');
    });
    const result = await downloadPublicMedia({
      ffmpegPath: path.join(workDir, "ffmpeg.exe"),
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      platformId: "youtube",
      spawnImpl,
      url: "https://www.youtube.com/watch?v=video-1",
      workDir,
      ytDlpPath: path.join(workDir, "yt-dlp.exe"),
    });

    assert.equal(result.title, "公开课");
    assert.equal(result.author, "测试作者");
    assert.equal(result.videoId, "video-1");
    assert.equal(result.mediaSize, 20);
    assert.equal(result.downloadProfile, "balanced-video-720p");
    assert.equal(result.formatId, "18");
    assert.equal(result.resolution, "640x360");
    assert.equal(result.estimatedSize, 25335244);
    assert.ok(receivedArgs.includes("--no-config"));
    assert.ok(receivedArgs.includes("--no-playlist"));
    assert.equal(receivedArgs.includes("--max-downloads"), false);
    assert.ok(receivedArgs.includes("!is_live"));
    assert.equal(receivedArgs.some((entry) => /cookie/i.test(entry)), false);
    const extractorArgsIndex = receivedArgs.indexOf("--extractor-args");
    assert.ok(extractorArgsIndex >= 0);
    assert.equal(receivedArgs[extractorArgsIndex + 1], "youtube:player_client=android");
    const formatIndex = receivedArgs.indexOf("--format");
    assert.ok(formatIndex >= 0);
    assert.match(receivedArgs[formatIndex + 1], /height<=720/);
    assert.doesNotMatch(receivedArgs[formatIndex + 1], /^bv\*\+ba\/b$/);
  });
});

test("public downloader uses audio first when retained media is disabled", async () => {
  await withTempDirectory(async (workDir) => {
    let receivedArgs = null;
    const spawnImpl = fakeSpawnFactory(async ({ args, stdout }) => {
      receivedArgs = args;
      await writeFile(path.join(workDir, "source.m4a"), "audio-fixture");
      stdout.end('__VKC_META__"audio-1"\t"音频优先"\t"测试作者"\t"140"\t"audio only"\t1024\n');
    });
    const result = await downloadPublicMedia({
      ffmpegPath: path.join(workDir, "ffmpeg.exe"),
      keepMedia: false,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      platformId: "youtube",
      spawnImpl,
      url: "https://www.youtube.com/watch?v=audio-1",
      workDir,
      ytDlpPath: path.join(workDir, "yt-dlp.exe"),
    });

    assert.equal(result.downloadProfile, "transcription-audio-first");
    const formatIndex = receivedArgs.indexOf("--format");
    assert.equal(
      receivedArgs[formatIndex + 1],
      "ba[ext=m4a][protocol=https]/ba[protocol=https]/ba/b[height<=360]/b",
    );
  });
});

test("public downloader falls back to a smaller format and keeps sanitized diagnostics", async () => {
  await withTempDirectory(async (workDir) => {
    const calls = [];
    const spawnImpl = fakeSpawnFactory(async ({ args, stderr, stdout }) => {
      calls.push(args);
      if (calls.length === 1) {
        stdout.write('__VKC_META__"video-2"\t"兼容回退"\t"测试作者"\t"22"\t"1280x720"\t90000000\n');
        stderr.write("ERROR: HTTP Error 403: Forbidden\n");
        return 1;
      }
      await writeFile(path.join(workDir, "source.mp4"), "fallback-media");
      stdout.write('__VKC_META__"video-2"\t"兼容回退"\t"测试作者"\t"18"\t"640x360"\t25000000\n');
      return 0;
    });
    const result = await downloadPublicMedia({
      ffmpegPath: path.join(workDir, "ffmpeg.exe"),
      keepMedia: true,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      platformId: "youtube",
      spawnImpl,
      url: "https://www.youtube.com/watch?v=video-2",
      workDir,
      ytDlpPath: path.join(workDir, "yt-dlp.exe"),
    });

    assert.equal(calls.length, 2);
    assert.equal(result.downloadAttempt, 2);
    assert.equal(result.downloadProfile, "compatibility-video-480p");
    assert.equal(result.formatId, "18");
  });
});

test("public downloader classifies login failures without exposing raw stderr", async () => {
  await withTempDirectory(async (workDir) => {
    const spawnImpl = fakeSpawnFactory(async ({ stderr }) => {
      stderr.write("ERROR: Sign in to confirm you're not a bot; secret=https://example.invalid/token\n");
      return 1;
    });
    await assert.rejects(
      downloadPublicMedia({
        ffmpegPath: path.join(workDir, "ffmpeg.exe"),
        keepMedia: true,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        platformId: "youtube",
        spawnImpl,
        url: "https://www.youtube.com/watch?v=login",
        workDir,
        ytDlpPath: path.join(workDir, "yt-dlp.exe"),
      }),
      (error) => (
        error instanceof PublicMediaDownloadError
        && error.code === "PUBLIC_MEDIA_DOWNLOAD_FAILED"
        && error.retryable === false
        && error.details.failureCategory === "login-required"
        && !error.message.includes("secret")
      ),
    );
  });
});

test("public downloader classifies anonymous-cookie and platform-guard failures", async () => {
  await withTempDirectory(async (workDir) => {
    const failures = [
      ["ERROR: [Douyin] Fresh cookies (not necessarily logged in) are needed", "login-required"],
      ["HTTP Error 412: Precondition Failed", "access-denied"],
    ];
    for (const [stderr, expectedCategory] of failures) {
      let calls = 0;
      const spawnImpl = fakeSpawnFactory(async ({ stderr: errorOutput }) => {
        calls += 1;
        errorOutput.write(stderr);
        return 1;
      });
      await assert.rejects(
        downloadPublicMedia({
          anonymousSessionFactory: async () => ({
            cookies: [{
              domain: ".douyin.com",
              expires: 0,
              name: "s_v_web_id",
              path: "/",
              secure: true,
              value: "verify_fixture",
            }],
            userAgent: "fixture-browser",
          }),
          ffmpegPath: path.join(workDir, "ffmpeg.exe"),
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
          platformId: "douyin",
          spawnImpl,
          url: "https://www.douyin.com/video/1234567890",
          workDir,
          ytDlpPath: path.join(workDir, "yt-dlp.exe"),
        }),
        (error) => error.code === "PUBLIC_MEDIA_DOWNLOAD_FAILED"
          && error.details.failureCategory === expectedCategory,
      );
      assert.equal(calls, expectedCategory === "login-required" ? 1 : 2);
    }
  });
});

test("public downloader blocks private DNS results before starting yt-dlp", async () => {
  await withTempDirectory(async (workDir) => {
    let spawnCalls = 0;
    await assert.rejects(
      downloadPublicMedia({
        ffmpegPath: path.join(workDir, "ffmpeg.exe"),
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        platformId: "bilibili",
        spawnImpl: () => {
          spawnCalls += 1;
        },
        url: "https://www.bilibili.com/video/BVfixture",
        workDir,
        ytDlpPath: path.join(workDir, "yt-dlp.exe"),
      }),
      (error) => (
        error instanceof PublicMediaDownloadError
        && error.code === "PUBLIC_MEDIA_PRIVATE_ADDRESS_BLOCKED"
        && error.retryable === false
      ),
    );
    assert.equal(spawnCalls, 0);
  });
});

test("public downloader does not apply YouTube extractor arguments to other generic platforms", async () => {
  await withTempDirectory(async (workDir) => {
    let receivedArgs = null;
    const spawnImpl = fakeSpawnFactory(async ({ args, stdout }) => {
      receivedArgs = args;
      await writeFile(path.join(workDir, "source.mp4"), "tiktok-media");
      stdout.end('__VKC_META__"tiktok-fixture"\t"TikTok 测试"\t"测试作者"\t"16"\t"640x360"\t2048\n');
    });
    await downloadPublicMedia({
      ffmpegPath: path.join(workDir, "ffmpeg.exe"),
      keepMedia: true,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      platformId: "tiktok",
      spawnImpl,
      url: "https://www.tiktok.com/@fixture/video/1234567890",
      workDir,
      ytDlpPath: path.join(workDir, "yt-dlp.exe"),
    });
    assert.equal(receivedArgs.includes("--extractor-args"), false);
  });
});

test("public downloader uses the Bilibili public API when the webpage is blocked", async () => {
  await withTempDirectory(async (workDir) => {
    let spawnCalls = 0;
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/x/web-interface/view?")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            cid: 12345,
            dimension: { height: 720, width: 1280 },
            owner: { name: "公开作者" },
            title: "B 站公开 API 测试",
          },
        }));
      }
      if (url.includes("/x/player/playurl?")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            durl: [{ size: 20, url: "https://media.example.com/source.mp4" }],
            quality: 64,
          },
        }));
      }
      if (url === "https://media.example.com/source.mp4") {
        return new Response("bilibili-api-media", {
          headers: { "content-length": "19", "content-type": "video/mp4" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const result = await downloadPublicMedia({
      fetchImpl,
      ffmpegPath: path.join(workDir, "ffmpeg.exe"),
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      platformId: "bilibili",
      spawnImpl: () => { spawnCalls += 1; },
      url: "https://www.bilibili.com/video/BVfixture",
      workDir,
      ytDlpPath: path.join(workDir, "yt-dlp.exe"),
    });

    assert.equal(spawnCalls, 0);
    assert.equal(result.strategy, "bilibili-public-api");
    assert.equal(result.downloadProfile, "bilibili-progressive-qn64");
    assert.equal(result.formatId, "qn64");
    assert.equal(result.resolution, "1280x720");
    assert.equal(result.title, "B 站公开 API 测试");
    assert.equal(await readFile(result.mediaPath, "utf8"), "bilibili-api-media");
  });
});

test("Douyin uses an isolated anonymous session and removes its cookie file", async () => {
  await withTempDirectory(async (workDir) => {
    let cookiePath = null;
    let receivedArgs = null;
    let receivedSessionTimeout = null;
    let receivedSessionBootstrapUrl = null;
    let receivedSessionUrl = null;
    let sessionCalls = 0;
    const spawnImpl = fakeSpawnFactory(async ({ args, stdout }) => {
      receivedArgs = args;
      cookiePath = args[args.indexOf("--cookies") + 1];
      const cookieSource = await readFile(cookiePath, "utf8");
      assert.match(cookieSource, /s_v_web_id\tverify_fixture/);
      await writeFile(path.join(workDir, "source.mp4"), "douyin-media");
      stdout.end('__VKC_META__"123"\t"抖音匿名会话"\t"公开作者"\t"normal_720"\t"720x1280"\t2048\n');
    });
    const result = await downloadPublicMedia({
      anonymousSessionFactory: async ({ bootstrapUrl, timeoutMs, url }) => {
        sessionCalls += 1;
        receivedSessionBootstrapUrl = bootstrapUrl;
        receivedSessionTimeout = timeoutMs;
        receivedSessionUrl = url;
        return {
          cookies: [{
            domain: ".douyin.com",
            expires: 0,
            name: "s_v_web_id",
            path: "/",
            secure: true,
            value: "verify_fixture",
          }],
          userAgent: "isolated-edge-fixture",
        };
      },
      ffmpegPath: path.join(workDir, "ffmpeg.exe"),
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      platformId: "douyin",
      spawnImpl,
      url: "https://www.douyin.com/video/123",
      workDir,
      ytDlpPath: path.join(workDir, "yt-dlp.exe"),
    });

    assert.equal(sessionCalls, 1);
    assert.equal(receivedSessionBootstrapUrl, "https://www.douyin.com/");
    assert.equal(receivedSessionTimeout, DOUYIN_ANONYMOUS_SESSION_TIMEOUT_MS);
    assert.equal(receivedSessionUrl, "https://www.douyin.com/video/123");
    assert.equal(result.title, "抖音匿名会话");
    assert.ok(receivedArgs.includes("--cookies"));
    assert.ok(receivedArgs.includes("--user-agent"));
    assert.ok(receivedArgs.includes("isolated-edge-fixture"));
    assert.equal(receivedArgs.includes("--cookies-from-browser"), false);
    await assert.rejects(access(cookiePath), { code: "ENOENT" });
  });
});

test("Douyin preserves a retryable anonymous-session timeout for diagnostics", async () => {
  await withTempDirectory(async (workDir) => {
    await assert.rejects(
      downloadPublicMedia({
        anonymousSessionFactory: async () => {
          throw new AnonymousBrowserSessionError(
            "抖音未能在限定时间内建立匿名公开会话，可稍后安全重试。",
            "PUBLIC_MEDIA_ANONYMOUS_SESSION_TIMEOUT",
          );
        },
        ffmpegPath: path.join(workDir, "ffmpeg.exe"),
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        platformId: "douyin",
        spawnImpl: () => assert.fail("yt-dlp must not start without a session"),
        url: "https://www.douyin.com/video/123",
        workDir,
        ytDlpPath: path.join(workDir, "yt-dlp.exe"),
      }),
      (error) => (
        error instanceof PublicMediaDownloadError
        && error.code === "PUBLIC_MEDIA_ANONYMOUS_SESSION_TIMEOUT"
        && error.retryable === true
        && error.details.failureCategory === "anonymous-session-timeout"
        && !error.message.includes("建立失败")
      ),
    );
  });
});

test("Xiaohongshu asks for a freshly copied complete link after both public profiles fail", async () => {
  await withTempDirectory(async (workDir) => {
    let calls = 0;
    const spawnImpl = fakeSpawnFactory(async ({ args, stderr }) => {
      calls += 1;
      assert.ok(args.includes("--impersonate"));
      assert.ok(args.includes("Chrome-146:Macos-26"));
      assert.ok(args.includes("--referer"));
      stderr.write("ERROR: [Xiaohongshu] No video formats found\n");
      return 1;
    });

    await assert.rejects(
      downloadPublicMedia({
        ffmpegPath: path.join(workDir, "ffmpeg.exe"),
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        platformId: "xiaohongshu",
        spawnImpl,
        url: "https://www.xiaohongshu.com/explore/fixture?xsec_token=current-fixture",
        workDir,
        ytDlpPath: path.join(workDir, "yt-dlp.exe"),
      }),
      (error) => (
        error instanceof PublicMediaDownloadError
        && error.code === "PUBLIC_MEDIA_DOWNLOAD_FAILED"
        && error.retryable === true
        && error.details.failureCategory === "link-refresh-required"
        && error.details.attempt === 2
        && error.details.attempts === 2
        && /重新复制完整分享链接/.test(error.message)
      ),
    );
    assert.equal(calls, 2);
  });
});

test("public downloader permits the TUN fake-IP range only after platform allowlisting", async () => {
  await withTempDirectory(async (workDir) => {
    let spawnCalls = 0;
    const spawnImpl = fakeSpawnFactory(async ({ stdout }) => {
      spawnCalls += 1;
      await writeFile(path.join(workDir, "source.mp4"), "proxy-media");
      stdout.end('__VKC_META__"proxy"\t"代理测试"\t"测试"\n');
    });
    const result = await downloadPublicMedia({
      ffmpegPath: path.join(workDir, "ffmpeg.exe"),
      lookup: async () => [{ address: "198.18.1.9", family: 4 }],
      platformId: "youtube",
      spawnImpl,
      url: "https://www.youtube.com/watch?v=proxy",
      workDir,
      ytDlpPath: path.join(workDir, "yt-dlp.exe"),
    });
    assert.equal(spawnCalls, 1);
    assert.equal(result.title, "代理测试");
  });
});
