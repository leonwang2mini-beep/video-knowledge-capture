import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CaptureError,
  captureVideo,
  normalizeVideoUrl,
  retryFailure,
} from "../src/core.mjs";
import { detectPlatform } from "../src/platforms.mjs";

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("detectPlatform identifies known platforms and keeps an explicit web fallback", () => {
  assert.deepEqual(detectPlatform("https://v.douyin.com/example"), {
    id: "douyin",
    label: "抖音",
  });
  assert.deepEqual(detectPlatform("https://channels.weixin.qq.com/example"), {
    id: "wechat-channels",
    label: "微信视频号",
  });
  assert.deepEqual(detectPlatform("https://weixin.qq.com/sph/FixtureLink123"), {
    id: "wechat-channels",
    label: "微信视频号",
  });
  assert.deepEqual(detectPlatform("https://weixin.qq.com/article/example"), {
    id: "wechat",
    label: "微信",
  });
  assert.deepEqual(detectPlatform("https://example.com/video"), {
    id: "web",
    label: "网页",
  });
});

test("normalizeVideoUrl removes fragments and common tracking parameters", () => {
  assert.equal(
    normalizeVideoUrl("HTTPS://WWW.DOUYIN.COM/video/123/?utm_source=chat&b=2&a=1#reply"),
    "https://www.douyin.com/video/123?a=1&b=2",
  );
});

test("normalizeVideoUrl converts a Douyin modal container into its video detail URL", () => {
  const modalUrl = "https://www.douyin.com/jingxuan/course/search/example?aid=fixture&modal_id=7000000000000000001&type=general";
  const detailUrl = "https://www.douyin.com/video/7000000000000000001";

  assert.equal(normalizeVideoUrl(modalUrl), detailUrl);
  assert.equal(
    normalizeVideoUrl(`${detailUrl}?modal_id=1234567890123456789#comments`),
    detailUrl,
  );
});

test("captureVideo writes structured Markdown into the configured temporary Inbox", async () => {
  await withTempDirectory(async (root) => {
    const inbox = path.join(root, "Inbox");
    const state = path.join(root, "state");
    const result = await captureVideo({
      inboxDir: inbox,
      note: "研究这个讲解方式",
      now: () => new Date("2026-07-22T01:02:03.000Z"),
      stateDir: state,
      url: "https://v.douyin.com/abc123?utm_source=share",
    });

    assert.equal(result.status, "created");
    assert.equal(result.platform.id, "douyin");
    const markdown = await readFile(result.notePath, "utf8");
    assert.match(markdown, /source_platform: "douyin"/);
    assert.match(markdown, /canonical_url: "https:\/\/v\.douyin\.com\/abc123"/);
    assert.match(markdown, /collected_at: "2026-07-22T01:02:03\.000Z"/);
    assert.match(markdown, /content_status: "not-attempted"/);
    assert.match(markdown, /研究这个讲解方式/);
  });
});

test("captureVideo enriches Markdown and degrades extractor failures without losing the link", async () => {
  await withTempDirectory(async (root) => {
    const inbox = path.join(root, "Inbox");
    const state = path.join(root, "state");
    const enriched = await captureVideo({
      contentExtractor: async () => ({
        author: "公开作者",
        description: "简介里有 <unsafe> 标记",
        resolvedUrl: "https://channels.weixin.qq.com/finder-preview/pages/sph?id=demo",
        status: "extracted",
        strategy: "public-html",
        title: "AI 组织改革",
      }),
      inboxDir: inbox,
      stateDir: state,
      url: "https://weixin.qq.com/sph/demo",
    });

    assert.equal(enriched.status, "created");
    assert.equal(enriched.platform.id, "wechat-channels");
    assert.equal(enriched.content.status, "extracted");
    const enrichedMarkdown = await readFile(enriched.notePath, "utf8");
    assert.match(enrichedMarkdown, /title: "AI 组织改革"/);
    assert.match(enrichedMarkdown, /source_platform: "wechat-channels"/);
    assert.match(enrichedMarkdown, /content_status: "extracted"/);
    assert.match(enrichedMarkdown, /- 作者：公开作者/);
    assert.match(enrichedMarkdown, /简介里有 &lt;unsafe&gt; 标记/);

    const degraded = await captureVideo({
      contentExtractor: async () => {
        const error = new Error("temporary upstream error");
        error.code = "PUBLIC_FETCH_TIMEOUT";
        throw error;
      },
      inboxDir: inbox,
      stateDir: state,
      url: "https://www.bilibili.com/video/degraded",
    });
    assert.equal(degraded.status, "created");
    assert.equal(degraded.content.status, "unavailable");
    assert.equal(degraded.content.errorCode, "PUBLIC_FETCH_TIMEOUT");
    const degradedMarkdown = await readFile(degraded.notePath, "utf8");
    assert.match(degradedMarkdown, /content_status: "unavailable"/);
    assert.match(degradedMarkdown, /content_error_code: "PUBLIC_FETCH_TIMEOUT"/);
    assert.match(degradedMarkdown, /链接已继续收录/);
  });
});

test("manual title and transcript create a content note and safely enrich an existing link", async () => {
  await withTempDirectory(async (root) => {
    const inbox = path.join(root, "Inbox");
    const state = path.join(root, "state");
    let extractionCalls = 0;
    const contentExtractor = async () => {
      extractionCalls += 1;
      return {
        errorCode: "NO_USEFUL_METADATA",
        errorMessage: "公开页面没有可用元数据。",
        status: "unavailable",
      };
    };
    const url = "https://weixin.qq.com/sph/manual-content";

    const first = await captureVideo({
      contentExtractor,
      inboxDir: inbox,
      note: "保留这条个人备注",
      stateDir: state,
      url,
    });
    assert.equal(first.status, "created");
    const firstMarkdown = await readFile(first.notePath, "utf8");
    assert.match(firstMarkdown, /material_status: "missing"/);
    assert.match(firstMarkdown, /当前仅保存了链接/);

    await writeFile(first.notePath, `${firstMarkdown}\n用户的手工补充\n`, "utf8");
    const transcript = "第一点：组织结构要围绕结果设计。\n第二点：AI 负责重复流程。";
    const updated = await captureVideo({
      contentExtractor,
      inboxDir: inbox,
      providedTitle: "AI 组织改革的两个关键变化",
      stateDir: state,
      transcript,
      url,
    });

    assert.equal(updated.status, "updated");
    assert.equal(updated.material.status, "provided");
    assert.equal(updated.material.transcriptCharCount, transcript.length);
    assert.equal(extractionCalls, 1);
    const updatedMarkdown = await readFile(updated.notePath, "utf8");
    assert.match(updatedMarkdown, /title: "AI 组织改革的两个关键变化"/);
    assert.match(updatedMarkdown, /material_status: "provided"/);
    assert.match(updatedMarkdown, /material_source: "user-pasted"/);
    assert.match(updatedMarkdown, /## 视频内容/);
    assert.match(updatedMarkdown, /> 第一点：组织结构要围绕结果设计。/);
    assert.match(updatedMarkdown, /用户的手工补充/);
    assert.equal((await readdir(inbox)).filter((name) => name.endsWith(".md")).length, 1);

    const repeated = await captureVideo({
      contentExtractor,
      inboxDir: inbox,
      providedTitle: "AI 组织改革的两个关键变化",
      stateDir: state,
      transcript,
      url,
    });
    assert.equal(repeated.status, "duplicate");
    assert.equal(extractionCalls, 1);

    await assert.rejects(
      captureVideo({
        contentExtractor,
        inboxDir: inbox,
        providedTitle: "AI 组织改革的两个关键变化",
        stateDir: state,
        transcript: "另一份不同文案",
        url,
      }),
      (error) => (
        error instanceof CaptureError
        && error.code === "MANUAL_CONTENT_CONFLICT"
        && Boolean(error.failureId)
      ),
    );
  });
});

test("canonical duplicates do not create a second note", async () => {
  await withTempDirectory(async (root) => {
    const inbox = path.join(root, "Inbox");
    const state = path.join(root, "state");
    let extractionCalls = 0;
    const contentExtractor = async () => {
      extractionCalls += 1;
      return {
        status: "extracted",
        title: "只提取一次",
      };
    };
    const first = await captureVideo({
      contentExtractor,
      inboxDir: inbox,
      stateDir: state,
      url: "https://www.bilibili.com/video/BV123?utm_source=first",
    });
    const second = await captureVideo({
      contentExtractor,
      inboxDir: inbox,
      stateDir: state,
      url: "https://www.bilibili.com/video/BV123#second",
    });

    assert.equal(first.status, "created");
    assert.equal(second.status, "duplicate");
    assert.equal(second.content.errorCode, "DUPLICATE_NO_REFETCH");
    assert.equal(extractionCalls, 1);
    assert.equal(first.notePath, second.notePath);
    assert.equal((await readdir(inbox)).filter((name) => name.endsWith(".md")).length, 1);
  });
});

test("write failures are traceable and retrying the same failure is idempotent", async () => {
  await withTempDirectory(async (root) => {
    const inbox = path.join(root, "blocked-inbox");
    const state = path.join(root, "state");
    await writeFile(inbox, "blocks directory creation", "utf8");

    let failure;
    try {
      await captureVideo({
        inboxDir: inbox,
        note: "失败后保留",
        providedTitle: "等待重试的标题",
        stateDir: state,
        transcript: "等待重试的视频内容",
        url: "https://youtu.be/example-id",
      });
      assert.fail("capture should fail when Inbox path is a file");
    } catch (error) {
      assert.ok(error instanceof CaptureError);
      assert.equal(error.code, "NOTE_WRITE_FAILED");
      assert.equal(error.retryable, true);
      assert.ok(error.failureId);
      failure = error;
    }

    const failureLines = (await readFile(path.join(state, "failures.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(failureLines.length, 1);
    const record = JSON.parse(failureLines[0]);
    assert.equal(record.failure_id, failure.failureId);
    assert.equal(record.stage, "write-note");
    assert.equal(record.retry_input.note, "失败后保留");
    assert.equal(record.retry_input.provided_title, "等待重试的标题");
    assert.equal(record.retry_input.transcript, "等待重试的视频内容");

    await rm(inbox);
    await mkdir(inbox);
    const firstRetry = await retryFailure({
      failureId: failure.failureId,
      inboxDir: inbox,
      stateDir: state,
    });
    const secondRetry = await retryFailure({
      failureId: failure.failureId,
      inboxDir: inbox,
      stateDir: state,
    });

    assert.equal(firstRetry.status, "created");
    assert.equal(secondRetry.status, "duplicate");
    assert.match(await readFile(firstRetry.notePath, "utf8"), /等待重试的视频内容/);
    assert.equal((await readdir(inbox)).filter((name) => name.endsWith(".md")).length, 1);
    const retryLines = (await readFile(path.join(state, "retry-events.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(retryLines.length, 2);
  });
});
