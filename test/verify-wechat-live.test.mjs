import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadWechatRetryUrl,
  parseWechatLiveArguments,
} from "../scripts/verify-wechat-live.mjs";

test("live WeChat verifier accepts only WeChat links and bounded wait options", () => {
  const options = parseWechatLiveArguments([
    "--url",
    "https://weixin.qq.com/sph/PublicFixture123#fragment",
    "--page-timeout-seconds",
    "45",
    "--job-timeout-seconds",
    "900",
    "--reuse-observed-seconds",
    "1200",
  ]);

  assert.equal(options.url, "https://weixin.qq.com/sph/PublicFixture123");
  assert.equal(options.pageTimeoutMs, 45_000);
  assert.equal(options.jobTimeoutMs, 900_000);
  assert.equal(options.reuseObservedMs, 1_200_000);
  assert.throws(
    () => parseWechatLiveArguments(["--url", "https://example.com/video"]),
    /只接受微信视频号/,
  );
  assert.throws(
    () => parseWechatLiveArguments([
      "--url",
      "https://weixin.qq.com/sph/PublicFixture123",
      "--page-timeout-seconds",
      "0",
    ]),
    /必须是 1 到 1800 之间的整数秒数/,
  );
  assert.throws(
    () => parseWechatLiveArguments([
      "--url",
      "https://weixin.qq.com/sph/PublicFixture123",
      "--reuse-observed-seconds",
      "3601",
    ]),
    /必须是 1 到 3600 之间的整数秒数/,
  );
});

test("live WeChat verifier loads a failed job URL without putting it on the command line", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-capture-wechat-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobPath = path.join(root, "job.json");
  await writeFile(jobPath, JSON.stringify({
    request: { url: "https://weixin.qq.com/sph/PublicFixture123#fragment" },
    sourceType: "wechat",
    status: "failed",
  }));

  const options = parseWechatLiveArguments(["--retry-job", jobPath]);

  assert.equal(options.url, null);
  assert.equal(options.retryJobPath, jobPath);
  assert.equal(
    await loadWechatRetryUrl(options.retryJobPath),
    "https://weixin.qq.com/sph/PublicFixture123",
  );
  assert.throws(
    () => parseWechatLiveArguments(["--retry-job", "relative-job.json"]),
    /必须使用.*绝对路径/,
  );
  assert.throws(
    () => parseWechatLiveArguments([
      "--url",
      "https://weixin.qq.com/sph/PublicFixture123",
      "--retry-job",
      jobPath,
    ]),
    /用法/,
  );
});
