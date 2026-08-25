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

import { startLocalApp } from "../src/server.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "video-capture-usable-"));
const configDir = path.join(tempRoot, "config");
const inbox = path.join(tempRoot, "Inbox");
const recoveryInbox = path.join(tempRoot, "RecoveryInbox");
await Promise.all([mkdir(inbox), mkdir(recoveryInbox)]);

const silentLogger = { error() {}, log() {} };
let extractionCalls = 0;
const contentExtractor = async () => {
  extractionCalls += 1;
  return {
    author: "验收夹具",
    description: "这段公开页面简介来自可控夹具，不访问外部网络。",
    status: "extracted",
    strategy: "acceptance-fixture",
    title: "可使用版本元数据验收",
  };
};
const { server, url } = await startLocalApp({
  configDir,
  contentExtractor,
  logger: silentLogger,
  port: 0,
});

async function jsonRequest(requestPath, { method = "GET", body } = {}) {
  const response = await fetch(`${url}${requestPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  return { response, payload };
}

let report;
try {
  const page = await fetch(url);
  const pageText = await page.text();
  assert.equal(page.status, 200);
  assert.match(pageText, /丢进一条链接/);
  assert.match(pageText, /id="intake-form"/);
  assert.match(pageText, /id="settings-panel"/);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);

  const configured = await jsonRequest("/api/config", {
    method: "PUT",
    body: { inboxDir: inbox },
  });
  assert.equal(configured.payload.configuration.inboxStatus, "ready");

  const created = await jsonRequest("/api/captures", {
    method: "POST",
    body: {
      url: "https://v.douyin.com/usable-demo?utm_source=acceptance",
      note: "可使用版本临时验收",
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.capture.status, "created");
  assert.equal(created.payload.capture.content.status, "extracted");

  const duplicate = await jsonRequest("/api/captures", {
    method: "POST",
    body: { url: "https://v.douyin.com/usable-demo#duplicate" },
  });
  assert.equal(duplicate.payload.capture.status, "duplicate");
  assert.equal(extractionCalls, 1);
  const inboxNotes = (await readdir(inbox)).filter((name) => name.endsWith(".md"));
  assert.equal(inboxNotes.length, 1);

  const switched = await jsonRequest("/api/config", {
    method: "PUT",
    body: { inboxDir: recoveryInbox },
  });
  assert.equal(switched.payload.configuration.inboxStatus, "ready");
  await rmdir(recoveryInbox);
  await writeFile(recoveryInbox, "intentional acceptance failure", "utf8");

  const failed = await jsonRequest("/api/captures", {
    method: "POST",
    body: { url: "https://youtu.be/usable-recovery", note: "恢复队列验收" },
  });
  assert.equal(failed.response.status, 422);
  assert.ok(failed.payload.error.failureId);

  const pending = await jsonRequest("/api/failures");
  assert.equal(pending.payload.pendingCount, 1);
  assert.equal(pending.payload.failures[0].retryable, true);

  await rm(recoveryInbox);
  await mkdir(recoveryInbox);
  const retried = await jsonRequest(
    `/api/failures/${failed.payload.error.failureId}/retry`,
    { method: "POST", body: {} },
  );
  assert.equal(retried.payload.capture.status, "created");

  const resolved = await jsonRequest("/api/failures");
  assert.equal(resolved.payload.pendingCount, 0);
  assert.equal(resolved.payload.failures[0].resolution, "resolved");

  const markdown = await readFile(path.join(inbox, inboxNotes[0]), "utf8");
  assert.match(markdown, /source_platform: "douyin"/);
  assert.match(markdown, /source_title: "可使用版本元数据验收"/);
  assert.match(markdown, /content_status: "extracted"/);
  assert.match(markdown, /可使用版本临时验收/);

  const configText = await readFile(path.join(configDir, "config.json"), "utf8");
  assert.doesNotMatch(configText, /token|cookie|password/i);

  report = {
    status: "passed",
    safety: {
      temporary_directory_only: true,
      server_binding: "127.0.0.1",
      external_integrations_used: false,
      credentials_accessed: false,
    },
    temp_root: tempRoot,
    local_url: url,
    checks: {
      offline_ui_served: true,
      configuration_ready: true,
      capture_result: created.payload.capture.status,
      content_status: created.payload.capture.content.status,
      duplicate_result: duplicate.payload.capture.status,
      extraction_calls_before_retry: 1,
      markdown_notes_after_duplicate: inboxNotes.length,
      failure_queue_pending_before_retry: pending.payload.pendingCount,
      retry_result: retried.payload.capture.status,
      failure_queue_pending_after_retry: resolved.payload.pendingCount,
      configuration_contains_credentials: false,
    },
    artifacts: {
      config_file: path.join(configDir, "config.json"),
      inbox,
      recovery_inbox: recoveryInbox,
      failure_ledger: path.join(configDir, "state", "failures.jsonl"),
      retry_ledger: path.join(configDir, "state", "retry-events.jsonl"),
    },
  };
} finally {
  await new Promise((resolve) => server.close(resolve));
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
