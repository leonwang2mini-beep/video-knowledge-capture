import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectRoot, "src", "cli.mjs");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "video-capture-acceptance-"));
const inbox = path.join(tempRoot, "Inbox");
const stateDir = path.join(tempRoot, "state");

function runCli(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    expectedStatus,
    `CLI exit code mismatch. stdout=${result.stdout} stderr=${result.stderr}`,
  );
  const output = expectedStatus === 0 ? result.stdout : result.stderr;
  return JSON.parse(output.trim());
}

const first = runCli([
  "capture",
  "--url",
  "https://v.douyin.com/mvp-demo?utm_source=acceptance",
  "--note",
  "MVP 临时目录验收",
  "--inbox",
  inbox,
  "--state-dir",
  stateDir,
]);
const duplicate = runCli([
  "capture",
  "--url",
  "https://v.douyin.com/mvp-demo#duplicate",
  "--inbox",
  inbox,
  "--state-dir",
  stateDir,
]);

assert.equal(first.status, "created");
assert.equal(duplicate.status, "duplicate");
assert.equal((await readdir(inbox)).filter((name) => name.endsWith(".md")).length, 1);

const blockedInbox = path.join(tempRoot, "blocked-inbox");
await writeFile(blockedInbox, "intentional acceptance failure", "utf8");
const failed = runCli([
  "capture",
  "--url",
  "https://youtu.be/retry-demo",
  "--note",
  "安全重试验收",
  "--inbox",
  blockedInbox,
  "--state-dir",
  stateDir,
], 1);

assert.equal(failed.code, "NOTE_WRITE_FAILED");
assert.ok(failed.failure_id);
await rm(blockedInbox);
const retried = runCli([
  "retry",
  "--failure-id",
  failed.failure_id,
  "--inbox",
  blockedInbox,
  "--state-dir",
  stateDir,
]);
assert.equal(retried.status, "created");

const failureRecords = (await readFile(path.join(stateDir, "failures.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.ok(failureRecords.some((record) => record.failure_id === failed.failure_id));

process.stdout.write(`${JSON.stringify({
  status: "passed",
  safety: {
    temporary_directory_only: true,
    external_integrations_used: false,
    credentials_accessed: false,
  },
  temp_root: tempRoot,
  checks: {
    platform: first.platform.id,
    markdown_notes_after_duplicate: 1,
    duplicate_result: duplicate.status,
    failure_recorded: true,
    retry_result: retried.status,
  },
  artifacts: {
    inbox,
    retry_inbox: blockedInbox,
    failure_ledger: path.join(stateDir, "failures.jsonl"),
    retry_ledger: path.join(stateDir, "retry-events.jsonl"),
  },
}, null, 2)}\n`);
