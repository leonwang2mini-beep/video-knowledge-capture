import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installHermesIntegration } from "../scripts/install-hermes-integration.mjs";


const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceClient = path.join(
  projectRoot,
  "integrations",
  "hermes",
  "plugin",
  "video-knowledge-capture",
  "client.py",
);
const probeScript = path.join(
  projectRoot,
  "integrations",
  "hermes",
  "tests",
  "invoke_client.py",
);
const fixedJobId = "11111111-1111-4111-8111-111111111111";

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUTF8: "1",
        ...options.env,
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
      resolve({ stdout, stderr });
    });
  });
}

async function invokeClient(baseUrl, action, argument, clientPath = sourceClient) {
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

async function withMockServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

test("Hermes installer exactly synchronizes the declared plugin and skill files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p0004-hermes-install-test-"));
  try {
    const first = await installHermesIntegration({ hermesHome: root });
    const staleReference = path.join(
      first.skillDir,
      "references",
      "youtube-fallback.md",
    );
    await mkdir(path.dirname(staleReference), { recursive: true });
    await writeFile(staleReference, "manual downloader and direct vault writer", "utf8");
    const second = await installHermesIntegration({ hermesHome: root });
    assert.equal(first.copiedCount, 7);
    assert.equal(second.copiedCount, 7);
    assert.equal(first.prunedCount, 0);
    assert.equal(second.prunedCount, 1);
    await assert.rejects(readFile(staleReference, "utf8"), { code: "ENOENT" });
    assert.match(
      await readFile(path.join(first.pluginDir, "plugin.yaml"), "utf8"),
      /name: video-knowledge-capture/,
    );
    assert.match(
      await readFile(path.join(first.skillDir, "SKILL.md"), "utf8"),
      /video_knowledge_capture/,
    );
    assert.match(
      await readFile(path.join(first.skillDir, "scripts", "p0004-client.mjs"), "utf8"),
      /127\.0\.0\.1:43127/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Hermes installer rejects an intermediate directory junction", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p0004-hermes-junction-test-"));
  const hermesHome = path.join(root, "hermes");
  const outsidePlugins = path.join(root, "outside-plugins");
  await mkdir(hermesHome, { recursive: true });
  await mkdir(outsidePlugins, { recursive: true });
  try {
    try {
      await symlink(outsidePlugins, path.join(hermesHome, "plugins"), "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        context.skip(`junction creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      installHermesIntegration({ hermesHome }),
      /Refusing symbolic-link destination/,
    );
    await assert.rejects(
      readFile(path.join(outsidePlugins, "video-knowledge-capture", "plugin.yaml"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Hermes client sends URL as JSON, waits for completion and returns only bounded fields", async () => {
  let receivedBody;
  let pollCount = 0;
  const shellLikeUrl = "https://www.youtube.com/watch?v=$(never-run)&feature=test";
  await withMockServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/intakes") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      sendJson(response, 202, {
        intake: { kind: "media-job", platform: { id: "youtube" } },
        job: {
          jobId: fixedJobId,
          sourceType: "public-url",
          stage: "download",
          status: "queued",
        },
      });
      return;
    }
    if (request.method === "GET" && request.url === `/api/media/jobs/${fixedJobId}`) {
      pollCount += 1;
      sendJson(response, 200, {
        job: {
          jobId: fixedJobId,
          sourceType: "public-url",
          stage: "completed",
          status: "completed",
          sourceUrl: "must-not-leak",
          result: {
            captureId: "a".repeat(64),
            captureStatus: "created",
            notePath: "D:\\Temp\\Inbox\\note.md",
            retainedMediaPath: "L:\\Temp\\retained.mp4",
            segmentCount: 4,
            transcriptCharCount: 188,
          },
        },
      });
      return;
    }
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
  }, async (baseUrl) => {
    const result = await invokeClient(baseUrl, "capture", {
      url: shellLikeUrl,
      wait_seconds: 2,
    });
    assert.deepEqual(receivedBody, { keepMedia: true, url: shellLikeUrl });
    assert.ok(pollCount >= 1);
    assert.equal(result.state, "completed");
    assert.equal(result.platform, "youtube");
    assert.equal(result.segment_count, 4);
    assert.equal(result.retained_media_path, "L:\\Temp\\retained.mp4");
    assert.match(result.message, /视频保留位置：L:\\Temp\\retained\.mp4/);
    assert.equal(result.sourceUrl, undefined);
  });
});

test("Hermes client distinguishes duplicate, processing, setup failure and unavailable", async () => {
  let mode = "duplicate";
  await withMockServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/intakes") {
      for await (const _chunk of request) {
        // Drain the request body before replying.
      }
      if (mode === "duplicate") {
        sendJson(response, 200, {
          intake: { kind: "link-note", platform: { id: "web" } },
          capture: {
            status: "duplicate",
            captureId: "b".repeat(64),
            notePath: "D:\\Temp\\Inbox\\existing.md",
          },
        });
        return;
      }
      if (mode === "processing") {
        sendJson(response, 202, {
          intake: { kind: "media-job", platform: { id: "youtube" } },
          job: {
            jobId: fixedJobId,
            sourceType: "public-url",
            stage: "download",
            status: "queued",
          },
        });
        return;
      }
      sendJson(response, 409, {
        error: {
          code: "WECHAT_SETUP_REQUIRED",
          message: "微信视频号首次使用需要完成一次本地授权设置。",
        },
      });
      return;
    }
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
  }, async (baseUrl) => {
    const duplicate = await invokeClient(baseUrl, "capture", {
      url: "https://example.com/video",
      wait_seconds: 0,
    });
    assert.equal(duplicate.state, "duplicate");

    mode = "processing";
    const processing = await invokeClient(baseUrl, "capture", {
      url: "https://www.youtube.com/watch?v=pending",
      wait_seconds: 0,
    });
    assert.equal(processing.state, "processing");
    assert.equal(processing.job_id, fixedJobId);

    mode = "setup";
    const setup = await invokeClient(baseUrl, "capture", {
      url: "https://weixin.qq.com/sph/test",
      wait_seconds: 0,
    });
    assert.equal(setup.state, "failed");
    assert.equal(setup.code, "WECHAT_SETUP_REQUIRED");
    assert.equal(setup.retryable, true);
  });

  const unavailable = await invokeClient("http://127.0.0.1:1", "capture", {
    url: "https://www.youtube.com/watch?v=offline",
    wait_seconds: 0,
  });
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.code, "P0004_UNAVAILABLE");

  const invalid = await invokeClient("http://127.0.0.1:1", "capture", {
    url: "file:///C:/private.mp4",
    wait_seconds: 0,
  });
  assert.equal(invalid.code, "INVALID_VIDEO_URL");
  assert.equal(invalid.retryable, false);
});

test("Hermes client reports an exact P0004 download failure instead of unsupported platform", async () => {
  await withMockServer(async (request, response) => {
    if (request.method === "GET" && request.url === `/api/media/jobs/${fixedJobId}`) {
      sendJson(response, 200, {
        job: {
          error: {
            code: "PUBLIC_MEDIA_DOWNLOAD_FAILED",
            details: {
              failureCategory: "transfer-failed",
              profile: "compatibility-video-480p",
            },
            message: "公开视频传输超时或中断，已尝试较小的兼容格式；可稍后安全重试。",
            retryable: true,
            stage: "download-public",
          },
          jobId: fixedJobId,
          retryable: true,
          sourceType: "public-url",
          stage: "download-public",
          status: "failed",
        },
      });
      return;
    }
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
  }, async (baseUrl) => {
    const result = await invokeClient(baseUrl, "status", { job_id: fixedJobId });
    assert.equal(result.state, "failed");
    assert.equal(result.code, "PUBLIC_MEDIA_DOWNLOAD_FAILED");
    assert.equal(result.failure_category, "transfer-failed");
    assert.equal(result.download_profile, "compatibility-video-480p");
    assert.match(result.next_action, /较小的兼容媒体格式/);
    assert.doesNotMatch(result.message, /不支持/);
  });
});

test("Hermes integration keeps a fixed loopback handler and aligned skill metadata", async () => {
  const [clientSource, skillSource, manifestSource, packageSource, projectSource] = await Promise.all([
    readFile(sourceClient, "utf8"),
    readFile(path.join(projectRoot, "skills/video-knowledge-capture/SKILL.md"), "utf8"),
    readFile(path.join(projectRoot, "integrations/hermes/plugin/video-knowledge-capture/plugin.yaml"), "utf8"),
    readFile(path.join(projectRoot, "package.json"), "utf8"),
    readFile(path.join(projectRoot, "PROJECT.yaml"), "utf8"),
  ]);
  assert.match(clientSource, /P0004_BASE_URL = "http:\/\/127\.0\.0\.1:43127"/);
  assert.doesNotMatch(clientSource, /subprocess|os\.system|shell\s*=/);
  assert.doesNotMatch(skillSource, /\[TODO/);
  assert.match(skillSource, /name: video-knowledge-capture/);
  assert.match(skillSource, /## Preconditions/);
  assert.match(skillSource, /## Report the Result/);
  assert.match(skillSource, /PUBLIC_MEDIA_PLATFORM_UNSUPPORTED/);
  assert.match(skillSource, /do not replace the local service with another downloader/);
  assert.match(manifestSource, /version: "1\.4\.0-beta\.1"/);
  assert.equal(JSON.parse(packageSource).version, "1.4.0-beta.1");
  assert.match(projectSource, /release_candidate: "1\.4\.0-beta\.1"/);
});
