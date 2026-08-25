import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { fileURLToPath } from "node:url";

import { installHermesIntegration } from "./install-hermes-integration.mjs";
import { saveAppConfig } from "../src/app-config.mjs";
import { captureVideo } from "../src/core.mjs";
import { startLocalApp } from "../src/server.mjs";


const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probeScript = path.join(projectRoot, "integrations", "hermes", "tests", "invoke_client.py");
const silentLogger = { error() {}, log() {} };

function runProcess(command, args, { cwd = projectRoot, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUTF8: "1",
        ...env,
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

async function invokeClient(clientPath, baseUrl, action, argument) {
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

function publicJob(job) {
  return {
    createdAt: job.createdAt,
    error: job.error ?? null,
    jobId: job.jobId,
    keepMedia: true,
    retainedMediaPath: job.result?.retainedMediaPath ?? null,
    retryable: job.retryable ?? false,
    sourceType: "public-url",
    stage: job.stage,
    status: job.status,
    updatedAt: job.updatedAt,
    result: job.result ?? null,
  };
}

function createFixtureJobs({ configDir, inbox, retainedRoot }) {
  const jobs = new Map();
  return {
    sidecar: { async stop() {} },
    yuanbaoResolver: { session: { async close() {} } },
    async create({ url }) {
      const now = new Date().toISOString();
      const job = {
        createdAt: now,
        jobId: randomUUID(),
        retryable: false,
        stage: "download",
        status: "queued",
        updatedAt: now,
      };
      jobs.set(job.jobId, job);
      setTimeout(async () => {
        try {
          if (url.includes("hermes-failure")) {
            job.error = {
              code: "PUBLIC_VIDEO_DOWNLOAD_FAILED",
              message: "验收夹具注入了可定位的下载失败。",
              retryable: true,
              stage: "download",
            };
            job.retryable = true;
            job.stage = "download";
            job.status = "failed";
            job.updatedAt = new Date().toISOString();
            return;
          }
          const captured = await captureVideo({
            contentExtractor: async () => ({
              author: "Hermes 验收夹具",
              description: "不访问外网的 M6 临时验收内容。",
              status: "extracted",
              strategy: "hermes-acceptance-fixture",
              title: "Hermes 手机投递验收",
            }),
            createInbox: false,
            inboxDir: inbox,
            material: {
              durationSeconds: 8,
              language: "zh",
              model: "fixture",
              segments: [
                { start: 0, end: 4, text: "手机发送链接。" },
                { start: 4, end: 8, text: "本机完成知识入库。" },
              ],
              source: "public-url-asr",
            },
            stateDir: path.join(configDir, "state"),
            transcript: "手机发送链接。本机完成知识入库。",
            url,
          });
          const retainedDir = path.join(retainedRoot, captured.captureId);
          await mkdir(retainedDir, { recursive: true });
          const retainedMediaPath = path.join(retainedDir, `${"c".repeat(64)}.mp4`);
          await writeFile(retainedMediaPath, "M6 fixture media", "utf8");
          job.result = {
            captureId: captured.captureId,
            captureStatus: captured.status,
            materialSource: "public-url-asr",
            notePath: captured.notePath,
            retainedMediaPath,
            segmentCount: captured.material.segmentCount,
            transcriptCharCount: captured.material.transcriptCharCount,
          };
          job.stage = "completed";
          job.status = "completed";
          job.updatedAt = new Date().toISOString();
        } catch (error) {
          job.error = {
            code: error?.code ?? "FIXTURE_JOB_FAILED",
            message: error?.message ?? "fixture failed",
            retryable: true,
            stage: error?.stage ?? "fixture",
          };
          job.retryable = true;
          job.stage = job.error.stage;
          job.status = "failed";
          job.updatedAt = new Date().toISOString();
        }
      }, 30);
      return publicJob(job);
    },
    async get(jobId) {
      const job = jobs.get(jobId);
      if (!job) {
        const error = new Error("任务不存在。");
        error.code = "MEDIA_JOB_NOT_FOUND";
        throw error;
      }
      return publicJob(job);
    },
    async list() {
      return [...jobs.values()].map(publicJob);
    },
  };
}

async function waitForStatus(clientPath, baseUrl, jobId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await invokeClient(clientPath, baseUrl, "status", { job_id: jobId });
    if (status.state !== "processing") return status;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for fixture job ${jobId}`);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "p0004-hermes-verify-"));
const hermesHome = path.join(tempRoot, "hermes-home");
const configDir = path.join(tempRoot, "p0004-config");
const inbox = path.join(tempRoot, "Inbox");
const retainedRoot = path.join(tempRoot, "retained-media");
await Promise.all([mkdir(inbox), mkdir(retainedRoot)]);

let server;
let report;
try {
  const installed = await installHermesIntegration({ hermesHome });
  const hermesEnv = { HERMES_HOME: hermesHome };
  await runProcess(
    "hermes",
    ["plugins", "enable", "video-knowledge-capture", "--no-allow-tool-override"],
    { env: hermesEnv },
  );
  const pluginList = await runProcess(
    "hermes",
    ["plugins", "list", "--enabled", "--user", "--json"],
    { env: hermesEnv },
  );
  assert.match(pluginList.stdout, /video-knowledge-capture/);
  const skillList = await runProcess(
    "hermes",
    ["skills", "list", "--source", "local", "--enabled-only"],
    { env: hermesEnv },
  );
  assert.match(skillList.stdout, /video-knowledge-capture/);

  const whereHermes = await runProcess(
    process.platform === "win32" ? "where.exe" : "which",
    ["hermes"],
  );
  const hermesExecutable = whereHermes.stdout.trim().split(/\r?\n/)[0];
  const hermesRoot = path.resolve(path.dirname(hermesExecutable), "..", "..");
  const hermesPython = process.platform === "win32"
    ? path.join(hermesRoot, "venv", "Scripts", "python.exe")
    : path.join(hermesRoot, "venv", "bin", "python");
  const discoveryCode = [
    "import json",
    "from hermes_cli.plugins import PluginManager",
    "manager = PluginManager()",
    "manager.discover_and_load()",
    "from tools.registry import registry",
    "names = sorted(n for n in registry._tools if n.startswith('video_knowledge_'))",
    "print(json.dumps({'tools': names}))",
  ].join("; ");
  const discovery = await runProcess(hermesPython, ["-c", discoveryCode], {
    cwd: hermesRoot,
    env: hermesEnv,
  });
  assert.deepEqual(JSON.parse(discovery.stdout).tools, [
    "video_knowledge_capture",
    "video_knowledge_status",
  ]);

  await saveAppConfig(configDir, {
    inboxDir: inbox,
    retainedMediaDir: retainedRoot,
  });
  const mediaJobService = createFixtureJobs({ configDir, inbox, retainedRoot });
  const started = await startLocalApp({
    configDir,
    logger: silentLogger,
    mediaJobService,
    port: 0,
  });
  server = started.server;
  const clientPath = path.join(installed.pluginDir, "client.py");
  const sourceUrl = "https://www.youtube.com/watch?v=hermes-m6-e2e";

  const accepted = await invokeClient(clientPath, started.url, "capture", {
    url: sourceUrl,
    wait_seconds: 0,
  });
  assert.equal(accepted.state, "processing");
  const completed = await waitForStatus(clientPath, started.url, accepted.job_id);
  assert.equal(completed.state, "completed");
  assert.equal(completed.segment_count, 2);
  assert.equal(completed.transcript_char_count, 16);
  assert.ok(completed.note_path.startsWith(inbox));
  assert.ok(completed.retained_media_path.startsWith(retainedRoot));

  const duplicate = await invokeClient(clientPath, started.url, "capture", {
    url: `${sourceUrl}#same-canonical-url`,
    wait_seconds: 2,
  });
  assert.equal(duplicate.state, "duplicate");
  assert.equal(duplicate.note_path, completed.note_path);

  const failed = await invokeClient(clientPath, started.url, "capture", {
    url: "https://www.youtube.com/watch?v=hermes-failure",
    wait_seconds: 2,
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.code, "PUBLIC_VIDEO_DOWNLOAD_FAILED");
  assert.equal(failed.retryable, true);

  const notes = (await readdir(inbox)).filter((name) => name.endsWith(".md"));
  assert.equal(notes.length, 1);
  const markdown = await readFile(path.join(inbox, notes[0]), "utf8");
  assert.match(markdown, /Hermes 手机投递验收/);
  assert.match(markdown, /手机发送链接/);
  assert.match(markdown, /本机完成知识入库/);

  report = {
    status: "passed",
    installedFiles: installed.copiedCount,
    discoveredTools: JSON.parse(discovery.stdout).tools,
    firstState: accepted.state,
    completedState: completed.state,
    duplicateState: duplicate.state,
    failedCode: failed.code,
    noteCount: notes.length,
    segmentCount: completed.segment_count,
    transcriptCharCount: completed.transcript_char_count,
    retainedMediaExists: Boolean(completed.retained_media_path),
    tempRoot,
    realObsidianTouched: false,
  };
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(tempRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
