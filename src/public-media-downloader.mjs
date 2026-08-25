import { spawn } from "node:child_process";
import { lookup as lookupDns } from "node:dns/promises";
import { open, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  AnonymousBrowserSessionError,
  captureAnonymousDouyinSession,
  DOUYIN_ANONYMOUS_SESSION_TIMEOUT_MS,
} from "./anonymous-browser-session.mjs";
import {
  isPublicIpAddress,
  validatePublicPageUrl,
} from "./content-extractor.mjs";

const MAX_OUTPUT_CHARS = 128 * 1024;
const MAX_API_RESPONSE_CHARS = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const DOUYIN_SESSION_BOOTSTRAP_URL = "https://www.douyin.com/";
const PUBLIC_BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const DOWNLOAD_ATTEMPTS = Object.freeze({
  retainedVideo: Object.freeze([
    Object.freeze({
      profile: "balanced-video-720p",
      selector: [
        "b[height<=720][ext=mp4][protocol=https][vcodec^=avc1][acodec^=mp4a]",
        "b[height<=720][ext=mp4][protocol=https]",
        "bv*[height<=720][ext=mp4][protocol=https][vcodec^=avc1]+ba[ext=m4a][protocol=https][acodec^=mp4a]",
        "bv*[height<=720]+ba",
        "b[height<=720]",
        "b",
      ].join("/"),
    }),
    Object.freeze({
      profile: "compatibility-video-480p",
      selector: [
        "b[height<=480][ext=mp4][protocol=https]",
        "b[height<=360][protocol=https]",
        "b[height<=480]",
        "bv*[height<=480]+ba",
        "b[height<=360]",
        "w",
      ].join("/"),
    }),
  ]),
  transcriptionOnly: Object.freeze([
    Object.freeze({
      profile: "transcription-audio-first",
      selector: "ba[ext=m4a][protocol=https]/ba[protocol=https]/ba/b[height<=360]/b",
    }),
    Object.freeze({
      profile: "compatibility-audio-360p",
      selector: "b[height<=360][ext=mp4][protocol=https]/b[height<=360][protocol=https]/b[height<=360]/w",
    }),
  ]),
});
const MEDIA_EXTENSIONS = new Set([
  ".aac", ".flac", ".m4a", ".mkv", ".mov", ".mp3", ".mp4", ".ogg", ".wav", ".webm",
]);

export const AUTO_DOWNLOAD_PLATFORM_IDS = Object.freeze(new Set([
  "bilibili",
  "douyin",
  "kuaishou",
  "tencent-video",
  "tiktok",
  "wechat",
  "xiaohongshu",
  "youtube",
]));

export class PublicMediaDownloadError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "PublicMediaDownloadError";
    this.code = code;
    this.retryable = options.retryable ?? true;
    this.stage = options.stage ?? "download-public";
    this.details = options.details ?? null;
  }
}

function downloadError(message, code, cause, retryable = true, details = null) {
  return new PublicMediaDownloadError(message, code, { cause, details, retryable });
}

export function canAutoDownloadPlatform(platformId) {
  return AUTO_DOWNLOAD_PLATFORM_IDS.has(platformId);
}

function isProxyFakeIp(address) {
  const parts = String(address).split(".").map(Number);
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 198
    && (parts[1] === 18 || parts[1] === 19);
}

async function assertPublicHost(url, lookup = lookupDns) {
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw downloadError(
      "无法解析视频平台地址，请检查网络后重试。",
      "PUBLIC_MEDIA_DNS_FAILED",
      error,
    );
  }
  if (
    !addresses.length
    || addresses.some(({ address }) => !isPublicIpAddress(address) && !isProxyFakeIp(address))
  ) {
    throw downloadError(
      "已阻止下载本机、私网或保留地址中的媒体。",
      "PUBLIC_MEDIA_PRIVATE_ADDRESS_BLOCKED",
      null,
      false,
    );
  }
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_OUTPUT_CHARS) return current;
  return `${current}${chunk}`.slice(0, MAX_OUTPUT_CHARS);
}

function classifyDownloadFailure(stderr) {
  const text = String(stderr).toLowerCase();
  if (/sign in|login required|log in|cookies-from-browser|fresh cookies|cookies? .* needed|confirm you.re not a bot/.test(text)) {
    return "login-required";
  }
  if (/private video|members-only|premium-only|paid content/.test(text)) {
    return "access-restricted";
  }
  if (/video unavailable|this video is unavailable|has been removed|not available in your country/.test(text)) {
    return "content-unavailable";
  }
  if (/requested format is not available|no video formats found/.test(text)) {
    return "format-unavailable";
  }
  if (/http error (?:403|412)|precondition failed|forbidden|access denied/.test(text)) {
    return "access-denied";
  }
  if (/timed out|timeout|connection reset|connection aborted|remote host|network is unreachable|unable to download/.test(text)) {
    return "transfer-failed";
  }
  if (/unsupported url/.test(text)) return "unsupported-url";
  return "downloader-failed";
}

function failureMessage(category) {
  const messages = {
    "access-denied": "平台拒绝了当前媒体格式的下载，已尝试兼容格式；可稍后安全重试。",
    "access-restricted": "该视频需要额外权限，P0004 不会读取账号 Cookie 或绕过访问控制。",
    "content-unavailable": "公开视频已失效、被移除或在当前地区不可用。",
    "format-unavailable": "平台没有返回当前可用的媒体格式，已尝试兼容格式。",
    "login-required": "平台要求登录或人机验证，P0004 不会读取浏览器 Cookie。",
    "transfer-failed": "公开视频传输超时或中断，已尝试较小的兼容格式；可稍后安全重试。",
    "unsupported-url": "下载组件当前无法识别这条平台链接。",
  };
  return messages[category]
    ?? "平台没有返回可下载的公开视频，可能是链接失效或平台规则发生变化。";
}

function canFallback(category) {
  return new Set([
    "access-denied",
    "downloader-failed",
    "format-unavailable",
    "transfer-failed",
  ]).has(category);
}

function serializeNetscapeCookies(cookies) {
  const lines = ["# Netscape HTTP Cookie File"];
  for (const cookie of cookies) {
    const rawDomain = String(cookie?.domain ?? "").toLowerCase();
    const domain = rawDomain.startsWith(".") ? rawDomain : `.${rawDomain}`;
    const cookiePath = String(cookie?.path || "/");
    const name = String(cookie?.name ?? "");
    const value = String(cookie?.value ?? "");
    if (
      !/^\.[a-z0-9.-]+$/.test(domain)
      || !cookiePath.startsWith("/")
      || /[\t\r\n]/.test(cookiePath)
      || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
      || !value
      || /[\t\r\n]/.test(value)
    ) {
      continue;
    }
    const expires = Number.isFinite(cookie.expires) && cookie.expires > 0
      ? Math.floor(cookie.expires)
      : 0;
    lines.push([
      domain,
      "TRUE",
      cookiePath,
      cookie.secure === true ? "TRUE" : "FALSE",
      expires,
      name,
      value,
    ].join("\t"));
  }
  if (lines.length === 1) {
    throw downloadError(
      "抖音匿名公开会话没有返回可用 Cookie。",
      "PUBLIC_MEDIA_ANONYMOUS_SESSION_INVALID",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function writeAnonymousCookieFile(workDir, cookies) {
  const cookiePath = path.join(workDir, "anonymous-session-cookies.txt");
  const handle = await open(cookiePath, "wx", 0o600);
  try {
    await handle.writeFile(serializeNetscapeCookies(cookies), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return cookiePath;
}

function isBilibiliHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  return host === "b23.tv"
    || host.endsWith(".b23.tv")
    || host === "bilibili.com"
    || host.endsWith(".bilibili.com");
}

function parseBilibiliVideoId(url) {
  const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
  if (!match) return null;
  const value = match[1];
  return /^BV/i.test(value)
    ? { key: "bvid", value: `BV${value.slice(2)}` }
    : { key: "aid", value: value.slice(2) };
}

async function resolveBilibiliVideoId(publicUrl, { fetchImpl, lookup }) {
  let current = publicUrl;
  for (let index = 0; index < 5; index += 1) {
    const parsed = parseBilibiliVideoId(current);
    if (parsed) return parsed;
    if (!isBilibiliHost(current.hostname)) break;
    await assertPublicHost(current, lookup);
    const response = await fetchImpl(current, {
      headers: { "User-Agent": PUBLIC_BROWSER_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get("location");
    if (!location || response.status < 300 || response.status >= 400) break;
    const redirected = new URL(location, current);
    if (redirected.protocol !== "https:" || !isBilibiliHost(redirected.hostname)) break;
    current = redirected;
  }
  throw downloadError(
    "B 站链接中没有可识别的 BV/AV 视频编号。",
    "PUBLIC_MEDIA_DOWNLOAD_FAILED",
    null,
    false,
    { failureCategory: "unsupported-url", profile: "bilibili-public-api" },
  );
}

async function fetchBilibiliJson(url, { fetchImpl, headers }) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw downloadError(
      "B 站公开接口连接失败，可稍后安全重试。",
      "PUBLIC_MEDIA_DOWNLOAD_FAILED",
      error,
      true,
      { failureCategory: "transfer-failed", profile: "bilibili-public-api" },
    );
  }
  const body = await response.text();
  if (!response.ok || body.length > MAX_API_RESPONSE_CHARS) {
    throw downloadError(
      "B 站公开接口没有返回可用数据，可稍后安全重试。",
      "PUBLIC_MEDIA_DOWNLOAD_FAILED",
      null,
      true,
      { failureCategory: "access-denied", profile: "bilibili-public-api" },
    );
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw downloadError(
      "B 站公开接口返回了无效数据。",
      "PUBLIC_MEDIA_DOWNLOAD_FAILED",
      error,
      true,
      { failureCategory: "downloader-failed", profile: "bilibili-public-api" },
    );
  }
}

async function downloadBilibiliResponse(mediaUrl, destination, {
  fetchImpl,
  headers,
  lookup,
}) {
  const source = new URL(mediaUrl);
  if (source.protocol !== "https:") {
    throw downloadError(
      "B 站公开接口返回了非 HTTPS 媒体地址。",
      "PUBLIC_MEDIA_DOWNLOAD_FAILED",
      null,
      false,
      { failureCategory: "downloader-failed", profile: "bilibili-public-api" },
    );
  }
  await assertPublicHost(source, lookup);
  let response;
  try {
    response = await fetchImpl(source, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw downloadError(
      "B 站公开视频传输失败，可稍后安全重试。",
      "PUBLIC_MEDIA_DOWNLOAD_FAILED",
      error,
      true,
      { failureCategory: "transfer-failed", profile: "bilibili-public-api" },
    );
  }
  if (!response.ok || !response.body) {
    throw downloadError(
      "B 站媒体服务器拒绝了公开视频下载。",
      "PUBLIC_MEDIA_DOWNLOAD_FAILED",
      null,
      true,
      { failureCategory: "access-denied", profile: "bilibili-public-api" },
    );
  }
  const finalUrl = new URL(response.url || source);
  await assertPublicHost(finalUrl, lookup);
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_MEDIA_BYTES) {
    throw downloadError(
      "B 站公开视频超过 4 GiB 限制。",
      "PUBLIC_MEDIA_DOWNLOAD_FAILED",
      null,
      false,
      { failureCategory: "access-restricted", profile: "bilibili-public-api" },
    );
  }
  let handle;
  let size = 0;
  try {
    handle = await open(destination, "wx");
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_MEDIA_BYTES) {
        throw downloadError(
          "B 站公开视频超过 4 GiB 限制。",
          "PUBLIC_MEDIA_DOWNLOAD_FAILED",
          null,
          false,
          { failureCategory: "access-restricted", profile: "bilibili-public-api" },
        );
      }
      await handle.write(buffer);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(destination, { force: true }).catch(() => {});
    if (error instanceof PublicMediaDownloadError) throw error;
    throw downloadError(
      "B 站公开视频无法保存到隔离工作目录。",
      "PUBLIC_MEDIA_DOWNLOAD_FAILED",
      error,
      true,
      { failureCategory: "transfer-failed", profile: "bilibili-public-api" },
    );
  }
  if (size === 0) {
    await rm(destination, { force: true }).catch(() => {});
    throw downloadError(
      "B 站媒体服务器返回了空文件。",
      "PUBLIC_MEDIA_OUTPUT_INVALID",
    );
  }
  return size;
}

export async function downloadBilibiliPublicMedia({
  fetchImpl = fetch,
  keepMedia = true,
  lookup = lookupDns,
  url,
  workDir,
}) {
  const publicUrl = validatePublicPageUrl(url);
  const videoId = await resolveBilibiliVideoId(publicUrl, { fetchImpl, lookup });
  const headers = {
    Accept: "application/json,text/plain,*/*",
    Referer: publicUrl.href,
    "User-Agent": PUBLIC_BROWSER_USER_AGENT,
  };
  const identifier = new URLSearchParams([[videoId.key, videoId.value]]);
  const metadata = await fetchBilibiliJson(
    `https://api.bilibili.com/x/web-interface/view?${identifier}`,
    { fetchImpl, headers },
  );
  if (metadata?.code !== 0 || !metadata?.data) {
    const restricted = new Set([-10403, -403, -404]).has(Number(metadata?.code));
    throw downloadError(
      restricted
        ? "该 B 站视频需要登录、会员或地区权限。"
        : "B 站公开接口没有返回视频详情。",
      "PUBLIC_MEDIA_DOWNLOAD_FAILED",
      null,
      !restricted,
      {
        failureCategory: restricted ? "access-restricted" : "content-unavailable",
        profile: "bilibili-public-api",
      },
    );
  }
  const cid = Number(metadata.data.cid ?? metadata.data.pages?.[0]?.cid);
  if (!Number.isFinite(cid) || cid <= 0) {
    throw downloadError(
      "B 站公开接口没有返回可下载分集。",
      "PUBLIC_MEDIA_DOWNLOAD_FAILED",
      null,
      true,
      { failureCategory: "format-unavailable", profile: "bilibili-public-api" },
    );
  }
  const qualities = keepMedia ? [64, 32] : [32, 16];
  let lastError = null;
  for (let index = 0; index < qualities.length; index += 1) {
    const quality = qualities[index];
    const playQuery = new URLSearchParams([
      [videoId.key, videoId.value],
      ["cid", String(cid)],
      ["qn", String(quality)],
      ["fnval", "1"],
      ["fourk", "0"],
    ]);
    const play = await fetchBilibiliJson(
      `https://api.bilibili.com/x/player/playurl?${playQuery}`,
      { fetchImpl, headers },
    );
    const durl = Array.isArray(play?.data?.durl) ? play.data.durl : [];
    if (play?.code !== 0 || durl.length !== 1 || typeof durl[0]?.url !== "string") {
      lastError = downloadError(
        "B 站公开接口没有返回单文件视频，正在尝试兼容画质。",
        "PUBLIC_MEDIA_DOWNLOAD_FAILED",
        null,
        true,
        {
          attempt: index + 1,
          attempts: qualities.length,
          failureCategory: "format-unavailable",
          profile: `bilibili-progressive-qn${quality}`,
        },
      );
      continue;
    }
    await removePriorOutputs(workDir);
    const outputPath = path.join(workDir, "source.mp4");
    const mediaSize = await downloadBilibiliResponse(durl[0].url, outputPath, {
      fetchImpl,
      headers,
      lookup,
    });
    const width = Number(metadata.data.dimension?.width);
    const height = Number(metadata.data.dimension?.height);
    return {
      author: typeof metadata.data.owner?.name === "string" ? metadata.data.owner.name : null,
      downloadAttempt: index + 1,
      downloadProfile: `bilibili-progressive-qn${Number(play.data.quality ?? quality)}`,
      estimatedSize: Number.isFinite(Number(durl[0].size)) ? Number(durl[0].size) : mediaSize,
      formatId: `qn${Number(play.data.quality ?? quality)}`,
      mediaPath: outputPath,
      mediaSize,
      resolution: Number.isFinite(width) && Number.isFinite(height) ? `${width}x${height}` : null,
      strategy: "bilibili-public-api",
      title: typeof metadata.data.title === "string" ? metadata.data.title : null,
      videoId: videoId.key === "bvid" ? videoId.value : `av${videoId.value}`,
    };
  }
  throw lastError;
}

function run(command, args, {
  cwd,
  profile,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    const timer = setTimeout(() => {
      child.kill?.();
      reject(downloadError(
        "视频下载超时，已停止本次任务，可稍后安全重试。",
        "PUBLIC_MEDIA_DOWNLOAD_TIMEOUT",
      ));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(downloadError(
        "无法启动本地视频下载组件。",
        "PUBLIC_MEDIA_DOWNLOADER_START_FAILED",
        error,
      ));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stderr, stdout });
        return;
      }
      const category = classifyDownloadFailure(stderr);
      const metadata = parseMetadata(stdout);
      const retryable = !new Set([
        "access-restricted",
        "content-unavailable",
        "login-required",
        "unsupported-url",
      ]).has(category);
      reject(downloadError(
        failureMessage(category),
        "PUBLIC_MEDIA_DOWNLOAD_FAILED",
        new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 2000)}`),
        retryable,
        {
          estimatedSize: metadata.estimatedSize,
          exitCode: Number.isInteger(code) ? code : null,
          failureCategory: category,
          formatId: metadata.formatId,
          profile,
          resolution: metadata.resolution,
        },
      ));
    });
  });
}

function parseMetadata(stdout) {
  const line = String(stdout)
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("__VKC_META__"));
  if (!line) {
    return {
      author: null,
      estimatedSize: null,
      formatId: null,
      resolution: null,
      title: null,
      videoId: null,
    };
  }
  const fields = line.slice("__VKC_META__".length).split("\t");
  const parseString = (value) => {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
    } catch {
      return null;
    }
  };
  const parseNumber = (value) => {
    try {
      const parsed = JSON.parse(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    } catch {
      return null;
    }
  };
  return {
    videoId: parseString(fields[0]),
    title: parseString(fields[1]),
    author: parseString(fields[2]),
    formatId: parseString(fields[3]),
    resolution: parseString(fields[4]),
    estimatedSize: parseNumber(fields[5]),
  };
}

async function removePriorOutputs(workDir) {
  const entries = await readdir(workDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("source."))
    .map((entry) => rm(path.join(workDir, entry.name), { force: true })));
}

async function findDownloadedMedia(workDir) {
  const entries = await readdir(workDir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("source.")) continue;
    if (!MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const candidate = path.join(workDir, entry.name);
    const metadata = await stat(candidate);
    if (metadata.size > 0) candidates.push({ path: candidate, size: metadata.size });
  }
  if (candidates.length !== 1) {
    throw downloadError(
      candidates.length === 0
        ? "下载组件没有生成可用媒体文件。"
        : "下载组件生成了多个媒体文件，已拒绝自动选择。",
      "PUBLIC_MEDIA_OUTPUT_INVALID",
    );
  }
  return candidates[0];
}

export async function downloadPublicMedia({
  anonymousSessionFactory = captureAnonymousDouyinSession,
  ffmpegPath,
  fetchImpl = fetch,
  keepMedia = true,
  lookup = lookupDns,
  platformId,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  url,
  workDir,
  ytDlpPath,
}) {
  if (!canAutoDownloadPlatform(platformId)) {
    throw downloadError(
      "该页面暂不支持自动下载，将只保留公开链接。",
      "PUBLIC_MEDIA_PLATFORM_UNSUPPORTED",
      null,
      false,
    );
  }
  const publicUrl = validatePublicPageUrl(url);
  await assertPublicHost(publicUrl, lookup);
  if (platformId === "bilibili") {
    try {
      return await downloadBilibiliPublicMedia({
        fetchImpl,
        keepMedia,
        lookup,
        url: publicUrl.href,
        workDir,
      });
    } catch (error) {
      if (error?.retryable === false) throw error;
      await removePriorOutputs(workDir);
      // The generic downloader remains a bounded compatibility fallback.
    }
  }
  const outputTemplate = path.join(workDir, "source.%(ext)s");
  const attempts = keepMedia
    ? DOWNLOAD_ATTEMPTS.retainedVideo
    : DOWNLOAD_ATTEMPTS.transcriptionOnly;
  let lastError = null;
  let anonymousCookiePath = null;
  let anonymousUserAgent = null;

  try {
    if (platformId === "douyin") {
      let anonymousSession;
      try {
        anonymousSession = await anonymousSessionFactory({
          bootstrapUrl: DOUYIN_SESSION_BOOTSTRAP_URL,
          timeoutMs: Math.min(timeoutMs, DOUYIN_ANONYMOUS_SESSION_TIMEOUT_MS),
          url: publicUrl.href,
          workDir,
        });
        anonymousUserAgent = anonymousSession.userAgent;
        anonymousCookiePath = await writeAnonymousCookieFile(
          workDir,
          anonymousSession.cookies,
        );
      } catch (error) {
        if (error instanceof PublicMediaDownloadError) throw error;
        if (error instanceof AnonymousBrowserSessionError) {
          throw downloadError(
            error.message,
            error.code,
            error,
            error.retryable !== false,
            {
              failureCategory: error.code === "PUBLIC_MEDIA_ANONYMOUS_SESSION_TIMEOUT"
                ? "anonymous-session-timeout"
                : "anonymous-session-failed",
            },
          );
        }
        throw downloadError(
          "抖音匿名公开会话建立失败，可稍后安全重试。",
          "PUBLIC_MEDIA_ANONYMOUS_SESSION_FAILED",
          error,
          true,
        );
      }
    }

    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      await removePriorOutputs(workDir);
      const args = [
        "--no-config",
        "--no-playlist",
        "--match-filter", "!is_live",
        "--max-filesize", "4G",
        "--socket-timeout", "30",
        "--retries", "3",
        "--fragment-retries", "3",
        "--quiet",
        "--no-warnings",
        "--windows-filenames",
        "--js-runtimes", "node",
        ...(platformId === "youtube"
          ? ["--extractor-args", "youtube:player_client=android"]
          : []),
        ...(platformId === "xiaohongshu"
          ? ["--impersonate", "Chrome-146:Macos-26", "--referer", publicUrl.href]
          : []),
        ...(platformId === "douyin"
          ? [
              "--cookies", anonymousCookiePath,
              "--user-agent", anonymousUserAgent,
              "--referer", publicUrl.href,
            ]
          : []),
        "--format", attempt.selector,
        "--merge-output-format", "mp4",
        "--ffmpeg-location", path.dirname(ffmpegPath),
        "--output", outputTemplate,
        "--print", "before_dl:__VKC_META__%(id)j\t%(title)j\t%(uploader)j\t%(format_id)j\t%(resolution)j\t%(filesize_approx)j",
        publicUrl.href,
      ];
      try {
        const result = await run(ytDlpPath, args, {
          cwd: workDir,
          profile: attempt.profile,
          spawnImpl,
          timeoutMs,
        });
        const media = await findDownloadedMedia(workDir);
        return {
          ...parseMetadata(result.stdout),
          downloadAttempt: index + 1,
          downloadProfile: attempt.profile,
          mediaPath: media.path,
          mediaSize: media.size,
          strategy: "yt-dlp-public",
        };
      } catch (error) {
        if (error instanceof PublicMediaDownloadError) {
          error.details = {
            ...error.details,
            attempt: index + 1,
            attempts: attempts.length,
            fallbackAttempted: index > 0,
          };
          if (
            platformId === "xiaohongshu"
            && index === attempts.length - 1
            && error.details.failureCategory === "format-unavailable"
          ) {
            error.message = "小红书分享链接已过期或缺少当前 xsec_token，请重新复制完整分享链接后安全重试。";
            error.details.failureCategory = "link-refresh-required";
          }
        }
        lastError = error;
        const category = error?.details?.failureCategory;
        if (
          error?.code !== "PUBLIC_MEDIA_DOWNLOAD_FAILED"
          || index === attempts.length - 1
          || !canFallback(category)
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  } finally {
    if (anonymousCookiePath) {
      await rm(anonymousCookiePath, { force: true }).catch(() => {});
    }
  }
}
