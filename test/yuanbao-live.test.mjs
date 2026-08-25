import assert from "node:assert/strict";
import test from "node:test";

import { parseYuanbaoLiveArguments } from "../scripts/verify-yuanbao-live.mjs";

test("Yuanbao live verifier accepts only a WeChat Channels URL and bounded timeout", () => {
  assert.deepEqual(parseYuanbaoLiveArguments([
    "--url",
    "https://weixin.qq.com/sph/Fixture123#ignored",
    "--job-timeout-seconds",
    "600",
    "--keep-media",
  ]), {
    jobTimeoutMs: 600000,
    keepMedia: true,
    url: "https://weixin.qq.com/sph/Fixture123",
  });
  assert.throws(
    () => parseYuanbaoLiveArguments(["--url", "https://example.com/video"]),
    /只接受微信视频号/,
  );
  assert.throws(
    () => parseYuanbaoLiveArguments(["--url", "https://weixin.qq.com/sph/Fixture123", "--job-timeout-seconds", "0"]),
    /必须是/,
  );
});
