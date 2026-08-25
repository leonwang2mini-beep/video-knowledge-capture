import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  ContentExtractionError,
  extractPublicMetadata,
  fetchPublicHtml,
  isPublicIpAddress,
  parsePublicMetadata,
  validatePublicPageUrl,
} from "../src/content-extractor.mjs";

const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];

test("public page guard blocks local, private, reserved and non-standard destinations", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("127.0.0.1"), false);
  assert.equal(isPublicIpAddress("192.168.1.2"), false);
  assert.equal(isPublicIpAddress("203.0.113.9"), false);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicIpAddress("::1"), false);
  assert.equal(isPublicIpAddress("fd00::1"), false);
  assert.equal(isPublicIpAddress("::ffff:192.168.1.2"), false);

  assert.throws(
    () => validatePublicPageUrl("http://127.0.0.1/secret"),
    (error) => error instanceof ContentExtractionError
      && error.code === "PRIVATE_ADDRESS_BLOCKED",
  );
  assert.throws(
    () => validatePublicPageUrl("https://user:pass@example.com/"),
    (error) => error instanceof ContentExtractionError
      && error.code === "PUBLIC_URL_CREDENTIALS",
  );
  assert.throws(
    () => validatePublicPageUrl("https://example.com:8443/"),
    (error) => error instanceof ContentExtractionError
      && error.code === "PUBLIC_PORT_BLOCKED",
  );
});

test("public HTML fetch revalidates redirect targets and enforces response limits", async () => {
  await assert.rejects(
    fetchPublicHtml("https://example.com/start", {
      lookup: publicLookup,
      transport: async () => ({
        body: "",
        headers: { location: "http://169.254.169.254/latest/meta-data" },
        statusCode: 302,
      }),
    }),
    (error) => error instanceof ContentExtractionError
      && error.code === "PRIVATE_ADDRESS_BLOCKED",
  );

  await assert.rejects(
    fetchPublicHtml("https://example.com/video", {
      lookup: publicLookup,
      maxBytes: 16,
      transport: async () => ({
        body: "x".repeat(17),
        headers: { "content-type": "text/html; charset=utf-8" },
        statusCode: 200,
      }),
    }),
    (error) => error instanceof ContentExtractionError
      && error.code === "PUBLIC_RESPONSE_TOO_LARGE",
  );

  await assert.rejects(
    fetchPublicHtml("https://example.com/video", {
      lookup: publicLookup,
      transport: async () => ({
        body: "binary",
        headers: { "content-type": "video/mp4" },
        statusCode: 200,
      }),
    }),
    (error) => error instanceof ContentExtractionError
      && error.code === "PUBLIC_CONTENT_TYPE",
  );

  const compressed = gzipSync(Buffer.from("<title>压缩页面标题</title>", "utf8"));
  const decoded = await fetchPublicHtml("https://example.com/compressed", {
    lookup: publicLookup,
    transport: async () => ({
      body: compressed,
      headers: {
        "content-encoding": "gzip",
        "content-type": "text/html; charset=utf-8",
      },
      statusCode: 200,
    }),
  });
  assert.match(decoded.html, /压缩页面标题/);

  await assert.rejects(
    fetchPublicHtml("https://example.com/compression-bomb", {
      lookup: publicLookup,
      maxBytes: 32,
      transport: async () => ({
        body: gzipSync(Buffer.from("x".repeat(128), "utf8")),
        headers: {
          "content-encoding": "gzip",
          "content-type": "text/html; charset=utf-8",
        },
        statusCode: 200,
      }),
    }),
    (error) => error instanceof ContentExtractionError
      && error.code === "PUBLIC_RESPONSE_TOO_LARGE",
  );
});

test("metadata parser combines Open Graph, regular meta and JSON-LD safely", () => {
  const metadata = parsePublicMetadata(`
    <!doctype html>
    <html>
      <head>
        <meta content="一次 &amp; 有用的分享" property="og:title">
        <meta name="author" content="Fixture Author &lt;script&gt;">
        <link href="/canonical-video" rel="canonical">
        <script type="application/ld+json">
          {
            "@type": "VideoObject",
            "description": "这是视频简介",
            "uploadDate": "2026-07-24T08:00:00+08:00"
          }
        </script>
      </head>
    </html>
  `, { pageUrl: "https://example.com/watch?id=1" });

  assert.deepEqual(metadata, {
    author: "Fixture Author",
    canonicalUrl: "https://example.com/canonical-video",
    description: "这是视频简介",
    publishedAt: "2026-07-24T08:00:00+08:00",
    siteName: null,
    title: "一次 & 有用的分享",
  });
});

test("extractor returns typed extracted and unavailable results without throwing", async () => {
  const extracted = await extractPublicMetadata(
    { canonicalUrl: "https://example.com/video" },
    {
      fetchHtml: async () => ({
        finalUrl: "https://example.com/video",
        html: `
          <meta property="og:title" content="公开标题">
          <meta property="og:description" content="公开简介">
        `,
      }),
    },
  );
  assert.equal(extracted.status, "extracted");
  assert.equal(extracted.title, "公开标题");
  assert.equal(extracted.fieldCount, 2);

  const genericWechatPage = await extractPublicMetadata(
    { canonicalUrl: "https://weixin.qq.com/sph/example" },
    {
      fetchHtml: async () => ({
        finalUrl: "https://channels.weixin.qq.com/finder-preview/pages/sph?id=example",
        html: "<title>视频号</title>",
      }),
    },
  );
  assert.equal(genericWechatPage.status, "unavailable");
  assert.equal(genericWechatPage.errorCode, "NO_USEFUL_METADATA");

  const failed = await extractPublicMetadata(
    { canonicalUrl: "https://example.com/video" },
    {
      fetchHtml: async () => {
        throw new ContentExtractionError("读取超时。", "PUBLIC_FETCH_TIMEOUT");
      },
    },
  );
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.errorCode, "PUBLIC_FETCH_TIMEOUT");
});
