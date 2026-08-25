import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { captureVideo } from "../src/core.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "video-capture-material-"));
const inbox = path.join(tempRoot, "Inbox");
const stateDir = path.join(tempRoot, "state");
const url = "https://weixin.qq.com/sph/m4-acceptance";
let extractionCalls = 0;

const unavailableExtractor = async () => {
  extractionCalls += 1;
  return {
    errorCode: "NO_USEFUL_METADATA",
    errorMessage: "测试夹具模拟微信视频号公开页只返回播放器。",
    resolvedUrl: "https://channels.weixin.qq.com/finder-preview/pages/sph?id=m4-acceptance",
    status: "unavailable",
    strategy: "acceptance-fixture",
  };
};

const initial = await captureVideo({
  contentExtractor: unavailableExtractor,
  inboxDir: inbox,
  note: "这条备注必须在增强后保留",
  stateDir,
  url,
});
assert.equal(initial.status, "created");
assert.equal(initial.content.status, "unavailable");

const transcript = [
  "第一点：用 AI 处理稳定、重复的工作。",
  "第二点：人负责目标、判断与最终责任。",
].join("\n");
const enriched = await captureVideo({
  contentExtractor: unavailableExtractor,
  inboxDir: inbox,
  providedTitle: "AI 组织改革：人机协作边界",
  stateDir,
  transcript,
  url,
});
assert.equal(enriched.status, "updated");
assert.equal(enriched.material.status, "provided");
assert.equal(extractionCalls, 1);

const repeated = await captureVideo({
  contentExtractor: unavailableExtractor,
  inboxDir: inbox,
  providedTitle: "AI 组织改革：人机协作边界",
  stateDir,
  transcript,
  url,
});
assert.equal(repeated.status, "duplicate");
assert.equal(extractionCalls, 1);

const notes = (await readdir(inbox)).filter((name) => name.endsWith(".md"));
assert.equal(notes.length, 1);
const markdown = await readFile(enriched.notePath, "utf8");
assert.match(markdown, /title: "AI 组织改革：人机协作边界"/);
assert.match(markdown, /source_platform: "wechat-channels"/);
assert.match(markdown, /content_status: "unavailable"/);
assert.match(markdown, /material_status: "provided"/);
assert.match(markdown, /## 视频内容/);
assert.match(markdown, /> 第一点：用 AI 处理稳定、重复的工作。/);
assert.match(markdown, /这条备注必须在增强后保留/);
assert.doesNotMatch(markdown, /当前仅保存了链接/);

process.stdout.write(`${JSON.stringify({
  status: "passed",
  safety: {
    credentials_accessed: false,
    external_network_used: false,
    media_downloaded: false,
    real_obsidian_accessed: false,
    temporary_directory_only: true,
  },
  temp_root: tempRoot,
  checks: {
    initial_result: initial.status,
    initial_content_status: initial.content.status,
    enrichment_result: enriched.status,
    repeated_result: repeated.status,
    extraction_calls: extractionCalls,
    markdown_notes: notes.length,
    material_status: enriched.material.status,
    transcript_chars: enriched.material.transcriptCharCount,
  },
  artifacts: {
    inbox,
    note: enriched.notePath,
    state: stateDir,
  },
}, null, 2)}\n`);
