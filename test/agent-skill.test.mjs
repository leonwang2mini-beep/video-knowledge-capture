import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installAgentSkill, parseArguments } from "../scripts/install-agent-skill.mjs";
import { P0004Client } from "../skills/video-knowledge-capture/scripts/p0004-client.mjs";


const fixedJobId = "22222222-2222-4222-8222-222222222222";

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json",
  });
  response.end(body);
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

test("agent skill installer exact-syncs Codex, Claude, and custom skill directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p0004-agent-skill-install-"));
  try {
    const codex = await installAgentSkill({ target: "codex", homeDir: root, env: {} });
    const claude = await installAgentSkill({ target: "claude", homeDir: root, env: {} });
    const customSkillsDir = path.join(root, "custom-skills");
    const firstCustom = await installAgentSkill({ target: "custom", skillsDir: customSkillsDir });
    const staleFile = path.join(firstCustom.skillDir, "references", "stale.md");
    await mkdir(path.dirname(staleFile), { recursive: true });
    await writeFile(staleFile, "stale host instructions", "utf8");
    const secondCustom = await installAgentSkill({ target: "custom", skillsDir: customSkillsDir });

    assert.equal(codex.copiedCount, 4);
    assert.equal(claude.copiedCount, 4);
    assert.equal(firstCustom.copiedCount, 4);
    assert.equal(secondCustom.copiedCount, 4);
    assert.equal(secondCustom.prunedCount, 1);
    assert.match(codex.skillDir, /\.codex[\\/]skills[\\/]video-knowledge-capture$/);
    assert.match(claude.skillDir, /\.claude[\\/]skills[\\/]video-knowledge-capture$/);
    await assert.rejects(readFile(staleFile, "utf8"), { code: "ENOENT" });
    assert.match(await readFile(path.join(codex.skillDir, "SKILL.md"), "utf8"), /name: video-knowledge-capture/);
    assert.match(await readFile(path.join(claude.skillDir, "scripts", "p0004-client.mjs"), "utf8"), /127\.0\.0\.1:43127/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("agent skill installer rejects incomplete or unsafe target arguments", () => {
  assert.throws(() => parseArguments([]), /--target/);
  assert.throws(() => parseArguments(["--target", "custom"]), /--skills-dir/);
  assert.throws(() => parseArguments(["--target", "unknown"]), /--target/);
});

test("bundled agent client sends structured JSON and returns a bounded terminal result", async () => {
  let receivedBody = null;
  let pollCount = 0;
  const publicUrl = "https://example.com/video?value=$(never-run)&x=1";
  await withMockServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/intakes") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      sendJson(response, 202, {
        intake: { kind: "media-job", platform: { id: "web-video" } },
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
            captureId: "c".repeat(64),
            captureStatus: "created",
            notePath: "D:\\KnowledgeBase\\Inbox\\note.md",
            retainedMediaPath: "D:\\KnowledgeBase\\Media\\video.mp4",
            segmentCount: 3,
            transcriptCharCount: 120,
          },
        },
      });
      return;
    }
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
  }, async (baseUrl) => {
    const client = new P0004Client({ baseUrl, pollIntervalMs: 20 });
    const result = await client.capture({ url: publicUrl, wait_seconds: 1 });
    assert.deepEqual(receivedBody, { keepMedia: true, url: publicUrl });
    assert.ok(pollCount >= 1);
    assert.equal(result.state, "completed");
    assert.equal(result.segment_count, 3);
    assert.equal(result.transcript_char_count, 120);
    assert.equal(result.sourceUrl, undefined);
  });
});

test("bundled agent client rejects credentials and fails closed when P0004 is offline", async () => {
  const client = new P0004Client({ baseUrl: "http://127.0.0.1:1" });
  const rejected = await client.capture({ url: "https://user:pass@example.com/video", wait_seconds: 0 });
  assert.equal(rejected.code, "URL_CREDENTIALS_REJECTED");
  assert.equal(rejected.retryable, false);

  const unavailable = await client.capture({ url: "https://example.com/public-video", wait_seconds: 0 });
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.code, "P0004_UNAVAILABLE");
});
