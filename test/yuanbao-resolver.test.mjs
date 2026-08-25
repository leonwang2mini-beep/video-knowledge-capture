import assert from "node:assert/strict";
import test from "node:test";

import {
  parseYuanbaoProfile,
  YuanbaoResolver,
  YuanbaoResolverError,
} from "../src/yuanbao-resolver.mjs";

const sourceUrl = "https://weixin.qq.com/sph/Fixture123";
const playableUrl = "https://channels.weixin.qq.com/finder-preview/pages/feed?token=general-token&eid=export-id";

test("Yuanbao resolver obtains a matching URL and 64-bit decode key without leaking its session", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ options, url: String(url) });
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          author: "示例作者",
          desc: "示例视频",
          playable_url: playableUrl,
          wx_export_id: "export-id",
        },
      }), { status: 200 });
    }
    return new Response(`{
      "errCode": 0,
      "data": {
        "authorInfo": {"nickname": "示例作者"},
        "feedInfo": {
          "id": 1234567890123456789,
          "description": "示例视频",
          "decodeKey": 1844674407370955161,
          "h264VideoInfo": {"videoUrl": "https://finder.video.qq.com/fixture.mp4", "duration": 12}
        }
      }
    }`, { status: 200 });
  };
  const resolver = new YuanbaoResolver("C:\\fixture", {
    fetchImpl,
    session: { loadCookie: async () => "hy_token=top-secret; x=fake" },
  });

  const profile = await resolver.resolveVideo(sourceUrl);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Cookie, "hy_token=top-secret; x=fake");
  assert.equal(calls[1].options.headers.Cookie, undefined);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    baseReq: { generalToken: "general-token" },
    exportId: "export-id",
  });
  assert.equal(profile.id, "1234567890123456789");
  assert.equal(profile.download.key, "1844674407370955161");
  assert.equal(profile.download.url, "https://finder.video.qq.com/fixture.mp4");
  assert.equal(profile.title, "示例视频");
  assert.equal(profile.author, "示例作者");
});

test("Yuanbao resolver turns expired authorization into a safe retryable error", async () => {
  const resolver = new YuanbaoResolver("C:\\fixture", {
    fetchImpl: async () => new Response("{}", { status: 403 }),
    session: { loadCookie: async () => "hy_token=must-not-appear" },
  });

  await assert.rejects(
    resolver.resolveVideo(sourceUrl),
    (error) => {
      assert.ok(error instanceof YuanbaoResolverError);
      assert.equal(error.code, "YUANBAO_AUTH_EXPIRED");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /hy_token|must-not-appear/);
      return true;
    },
  );
});

test("Yuanbao profile accepts a Tencent plain MP4 candidate without a decode key", () => {
  const profile = parseYuanbaoProfile(
    { code: 0, data: { playable_url: playableUrl } },
    {
      errCode: 0,
      data: {
        authorInfo: { nickname: "示例作者" },
        feedInfo: {
          description: "无需解密的视频",
          h264VideoInfo: {
            videoUrl: "https://finder.video.qq.com/plain.mp4",
          },
          id: "plain-video-id",
        },
      },
    },
    sourceUrl,
  );

  assert.equal(profile.download.key, "");
  assert.equal(profile.download.url, "https://finder.video.qq.com/plain.mp4");
  assert.equal(profile.title, "无需解密的视频");
});

test("Yuanbao profile rejects a media URL outside the Tencent HTTPS allowlist", () => {
  assert.throws(
    () => parseYuanbaoProfile(
      { code: 0, data: { playable_url: playableUrl } },
      {
        errCode: 0,
        data: {
          feedInfo: {
            decodeKey: "123",
            videoUrl: "https://example.com/video.mp4",
          },
        },
      },
      sourceUrl,
    ),
    (error) => error.code === "YUANBAO_MEDIA_URL_REJECTED" && error.retryable === false,
  );
});
