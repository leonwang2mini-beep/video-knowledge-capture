import { randomBytes } from "node:crypto";

import { normalizeVideoUrl } from "./core.mjs";
import { detectPlatform } from "./platforms.mjs";
import { YuanbaoSessionService } from "./yuanbao-session.mjs";

const PARSE_ENDPOINT = "https://yuanbao.tencent.com/api/weixin/get_parse_result";
const FEED_ENDPOINT = "https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export class YuanbaoResolverError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "YuanbaoResolverError";
    this.code = code;
    this.retryable = options.retryable ?? true;
    this.stage = options.stage ?? "resolve-yuanbao";
  }
}

function resolverError(message, code, options = {}) {
  return new YuanbaoResolverError(message, code, options);
}

function precisionSafeJson(raw) {
  return raw.replace(
    /("(?:id|videoId|video_id|key|decryptKey|decodeKey)"\s*:\s*)(\d{16,})(?=\s*[,}\]])/g,
    '$1"$2"',
  );
}

async function requestJson(fetchImpl, url, options, {
  authRequest = false,
  timeoutMs = 20000,
} = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw resolverError(
      "无法连接腾讯视频号解析服务，请检查网络后安全重试。",
      "YUANBAO_NETWORK_FAILED",
      { cause: error },
    );
  }
  if (authRequest && [401, 403].includes(response.status)) {
    throw resolverError(
      "腾讯元宝登录态已失效，请重新扫码登录后重试。",
      "YUANBAO_AUTH_EXPIRED",
    );
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    throw resolverError("腾讯解析响应超过安全上限。", "YUANBAO_RESPONSE_TOO_LARGE", {
      retryable: false,
    });
  }
  let payload;
  try {
    payload = JSON.parse(precisionSafeJson(raw));
  } catch (error) {
    throw resolverError(
      "腾讯解析服务返回了无效响应。",
      "YUANBAO_INVALID_RESPONSE",
      { cause: error },
    );
  }
  if (!response.ok) {
    throw resolverError(
      `腾讯解析服务请求失败（HTTP ${response.status}）。`,
      "YUANBAO_REQUEST_FAILED",
    );
  }
  return payload;
}

function cleanText(value, fallback, maximum = 300) {
  const normalized = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, maximum) || fallback;
}

function isTencentMediaHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "qq.com"
    || host.endsWith(".qq.com")
    || host === "weixin.qq.com"
    || host.endsWith(".weixin.qq.com")
    || host === "qpic.cn"
    || host.endsWith(".qpic.cn");
}

function requireTencentMediaUrl(value) {
  let mediaUrl;
  try {
    mediaUrl = new URL(value);
  } catch (error) {
    throw resolverError("视频号返回了无效媒体地址。", "YUANBAO_MEDIA_URL_INVALID", {
      cause: error,
      retryable: false,
    });
  }
  if (mediaUrl.protocol !== "https:" || !isTencentMediaHost(mediaUrl.hostname)) {
    throw resolverError(
      "视频号媒体地址不在允许的腾讯 HTTPS 域名范围内。",
      "YUANBAO_MEDIA_URL_REJECTED",
      { retryable: false },
    );
  }
  return mediaUrl.href;
}

function generateRequestId() {
  return `${Math.floor(Date.now() / 1000).toString(16)}-${randomBytes(4).toString("hex")}`;
}

export function parseYuanbaoProfile(parsePayload, feedPayload, sourceUrl) {
  const parseData = parsePayload?.data;
  if (Number(parsePayload?.code ?? 0) !== 0 || !parseData?.playable_url) {
    throw resolverError(
      "腾讯元宝没有解析出可播放链接；登录态可能已失效，或该视频暂不可访问。",
      "YUANBAO_PARSE_UNAVAILABLE",
    );
  }
  let playableUrl;
  try {
    playableUrl = new URL(parseData.playable_url);
  } catch (error) {
    throw resolverError("腾讯元宝返回了无效播放地址。", "YUANBAO_PLAYABLE_URL_INVALID", {
      cause: error,
      retryable: false,
    });
  }
  if (playableUrl.protocol !== "https:" || playableUrl.hostname !== "channels.weixin.qq.com") {
    throw resolverError(
      "腾讯元宝返回了非视频号播放地址，已拒绝继续。",
      "YUANBAO_PLAYABLE_URL_REJECTED",
      { retryable: false },
    );
  }
  const generalToken = playableUrl.searchParams.get("token") ?? "";
  const exportId = playableUrl.searchParams.get("eid") ?? parseData.wx_export_id ?? "";
  if (!generalToken || !exportId || generalToken.length > 8192 || String(exportId).length > 256) {
    throw resolverError(
      "腾讯元宝播放地址缺少视频号访问参数。",
      "YUANBAO_PLAYABLE_TOKEN_MISSING",
    );
  }
  if (Number(feedPayload?.errCode ?? 0) !== 0 || !feedPayload?.data?.feedInfo) {
    throw resolverError(
      "视频号详情接口没有返回可用视频。",
      "YUANBAO_FEED_UNAVAILABLE",
    );
  }
  const feed = feedPayload.data.feedInfo;
  const authorInfo = feedPayload.data.authorInfo ?? {};
  const mediaUrl = requireTencentMediaUrl(
    feed.h264VideoInfo?.videoUrl
      || feed.videoUrl
      || feed.originVideoUrl,
  );
  const decodeKey = feed.decodeKey === undefined || feed.decodeKey === null
    ? ""
    : String(feed.decodeKey);
  if (decodeKey !== "" && !/^\d{1,20}$/.test(decodeKey)) {
    throw resolverError(
      "视频号详情返回了无效解密参数。",
      "YUANBAO_DECODE_KEY_INVALID",
    );
  }
  const videoId = String(feed.id ?? exportId);
  const title = cleanText(feed.description ?? parseData.desc, "微信视频号视频");
  const author = cleanText(authorInfo.nickname ?? parseData.author, "微信视频号", 200);
  const durationSeconds = Number(
    feed.h264VideoInfo?.duration
      ?? feed.duration
      ?? 0,
  );
  return {
    author,
    download: {
      authorName: author,
      durationMs: Number.isFinite(durationSeconds) ? durationSeconds * 1000 : 0,
      fileFormat: "mp4",
      id: videoId,
      key: decodeKey,
      sourceURL: sourceUrl,
      title,
      url: mediaUrl,
    },
    id: videoId,
    title,
  };
}

export class YuanbaoResolver {
  constructor(configDir, {
    fetchImpl = fetch,
    session,
  } = {}) {
    this.configDir = configDir;
    this.fetchImpl = fetchImpl;
    this.session = session ?? new YuanbaoSessionService(configDir);
  }

  async resolveVideo(sourceUrl) {
    const canonicalUrl = normalizeVideoUrl(sourceUrl);
    if (detectPlatform(canonicalUrl).id !== "wechat-channels") {
      throw resolverError(
        "腾讯元宝解析器只接受微信视频号分享链接。",
        "YUANBAO_WECHAT_URL_REQUIRED",
        { retryable: false },
      );
    }
    const cookie = await this.session.loadCookie();
    const parsePayload = await requestJson(this.fetchImpl, PARSE_ENDPOINT, {
      body: JSON.stringify({ scene: 1, type: "video_channel_url", url: canonicalUrl }),
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: "https://yuanbao.tencent.com",
        Referer: "https://yuanbao.tencent.com/",
        "User-Agent": USER_AGENT,
        "X-Source": "web",
      },
      method: "POST",
    }, { authRequest: true });

    const parseData = parsePayload?.data;
    if (Number(parsePayload?.code ?? 0) !== 0 || !parseData?.playable_url) {
      throw resolverError(
        "腾讯元宝没有解析出可播放链接；请重新登录或稍后重试。",
        "YUANBAO_PARSE_UNAVAILABLE",
      );
    }
    let playableUrl;
    try {
      playableUrl = new URL(parseData.playable_url);
    } catch (error) {
      throw resolverError("腾讯元宝返回了无效播放地址。", "YUANBAO_PLAYABLE_URL_INVALID", {
        cause: error,
        retryable: false,
      });
    }
    const generalToken = playableUrl.searchParams.get("token") ?? "";
    const exportId = playableUrl.searchParams.get("eid") ?? parseData.wx_export_id ?? "";
    if (!generalToken || !exportId) {
      throw resolverError("腾讯元宝播放地址缺少视频号访问参数。", "YUANBAO_PLAYABLE_TOKEN_MISSING");
    }
    const rid = generateRequestId();
    const feedUrl = new URL(FEED_ENDPOINT);
    feedUrl.searchParams.set("_rid", rid);
    feedUrl.searchParams.set("_pageUrl", "https://channels.weixin.qq.com/finder-preview/pages/feed");
    const referer = new URL(playableUrl);
    const feedPayload = await requestJson(this.fetchImpl, feedUrl, {
      body: JSON.stringify({ baseReq: { generalToken }, exportId: String(exportId) }),
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        Origin: "https://channels.weixin.qq.com",
        Referer: referer.href,
        "User-Agent": USER_AGENT,
      },
      method: "POST",
    });
    return parseYuanbaoProfile(parsePayload, feedPayload, canonicalUrl);
  }
}
