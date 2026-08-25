import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { captureVideo } from "../src/core.mjs";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "video-capture-content-"));
const inbox = path.join(tempRoot, "Inbox");
const stateDir = path.join(tempRoot, "state");
let extractionCalls = 0;

const contentExtractor = async ({ canonicalUrl }) => {
  extractionCalls += 1;
  if (canonicalUrl.includes("/sph/")) {
    return {
      author: "公开作者",
      canonicalUrl: "https://channels.weixin.qq.com/finder-preview/pages/sph?id=fixture",
      description: "公开页面中的视频简介，用于验证结构化 Markdown。",
      publishedAt: "2026-07-24T08:00:00+08:00",
      resolvedUrl: "https://channels.weixin.qq.com/finder-preview/pages/sph?id=fixture",
      siteName: "微信视频号",
      status: "extracted",
      strategy: "fixture-public-html",
      title: "公开元数据验收视频",
    };
  }
  const error = new Error("fixture timeout");
  error.code = "PUBLIC_FETCH_TIMEOUT";
  throw error;
};

const enriched = await captureVideo({
  contentExtractor,
  inboxDir: inbox,
  note: "M3 临时目录验收",
  stateDir,
  url: "https://weixin.qq.com/sph/fixture?utm_source=acceptance",
});
assert.equal(enriched.status, "created");
assert.equal(enriched.platform.id, "wechat-channels");
assert.equal(enriched.content.status, "extracted");
assert.equal(enriched.content.title, "公开元数据验收视频");

const duplicate = await captureVideo({
  contentExtractor,
  inboxDir: inbox,
  stateDir,
  url: "https://weixin.qq.com/sph/fixture#duplicate",
});
assert.equal(duplicate.status, "duplicate");
assert.equal(duplicate.content.errorCode, "DUPLICATE_NO_REFETCH");
assert.equal(extractionCalls, 1);

const degraded = await captureVideo({
  contentExtractor,
  inboxDir: inbox,
  note: "即使提取失败也要保存",
  stateDir,
  url: "https://www.bilibili.com/video/degraded-fixture",
});
assert.equal(degraded.status, "created");
assert.equal(degraded.content.status, "unavailable");
assert.equal(degraded.content.errorCode, "PUBLIC_FETCH_TIMEOUT");

const enrichedMarkdown = await readFile(enriched.notePath, "utf8");
assert.match(enrichedMarkdown, /title: "公开元数据验收视频"/);
assert.match(enrichedMarkdown, /source_platform: "wechat-channels"/);
assert.match(enrichedMarkdown, /content_status: "extracted"/);
assert.match(enrichedMarkdown, /公开页面中的视频简介/);
assert.match(enrichedMarkdown, /M3 临时目录验收/);

const degradedMarkdown = await readFile(degraded.notePath, "utf8");
assert.match(degradedMarkdown, /content_status: "unavailable"/);
assert.match(degradedMarkdown, /content_error_code: "PUBLIC_FETCH_TIMEOUT"/);
assert.match(degradedMarkdown, /即使提取失败也要保存/);

const notes = (await readdir(inbox)).filter((name) => name.endsWith(".md"));
assert.equal(notes.length, 2);

process.stdout.write(`${JSON.stringify({
  status: "passed",
  safety: {
    credentials_accessed: false,
    external_network_used: false,
    media_downloaded: false,
    temporary_directory_only: true,
  },
  temp_root: tempRoot,
  checks: {
    degraded_note_created: degraded.status,
    degraded_status: degraded.content.status,
    duplicate_result: duplicate.status,
    extraction_calls_after_duplicate: 1,
    markdown_notes: notes.length,
    metadata_status: enriched.content.status,
    platform: enriched.platform.id,
  },
  artifacts: {
    degraded_note: degraded.notePath,
    enriched_note: enriched.notePath,
    inbox,
  },
}, null, 2)}\n`);
