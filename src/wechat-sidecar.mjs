import { spawn } from "node:child_process";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { resolveWorkDir } from "./app-config.mjs";
import { prepareWechatBufferRuntime } from "./wechat-buffer-bridge.mjs";

const DEFAULT_PROXY_BASE = "http://127.0.0.1:2025";
const DEFAULT_API_BASE = "http://127.0.0.1:2026";

export class WechatSidecarError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "WechatSidecarError";
    this.code = code;
    this.stage = options.stage ?? "wechat-sidecar";
    this.retryable = options.retryable ?? true;
  }
}

function sidecarError(message, code, stage, cause, retryable = true) {
  return new WechatSidecarError(message, code, { cause, retryable, stage });
}

function unwrap(payload) {
  if (payload?.code === 0 && payload.data !== undefined) return payload.data;
  if (payload?.success === true && payload.data !== undefined) return payload.data;
  return payload;
}

async function requestJson(fetchImpl, url, options = {}, timeoutMs = 10000) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw sidecarError(
      "无法连接微信视频号本地组件。",
      "WECHAT_SIDECAR_UNREACHABLE",
      "connect-wechat",
      error,
    );
  }
  let payload;
  try {
    const rawPayload = await response.text();
    const precisionSafePayload = rawPayload.replace(
      /(\"(?:id|videoId|video_id|key|decryptKey|decodeKey)\"\s*:\s*)(\d{16,})(?=\s*[,}\]])/g,
      '$1"$2"',
    );
    payload = JSON.parse(precisionSafePayload);
  } catch (error) {
    throw sidecarError(
      "微信视频号本地组件返回了无效响应。",
      "WECHAT_SIDECAR_INVALID_RESPONSE",
      "connect-wechat",
      error,
    );
  }
  if (!response.ok || payload?.code > 0 || payload?.success === false) {
    const message = payload?.message || payload?.error || `HTTP ${response.status}`;
    throw sidecarError(
      `微信视频号本地组件请求失败：${message}`,
      "WECHAT_SIDECAR_REQUEST_FAILED",
      "connect-wechat",
    );
  }
  return payload;
}

function firstObject(value, predicate, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return null;
  seen.add(value);
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstObject(entry, predicate, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  for (const entry of Object.values(value)) {
    const found = firstObject(entry, predicate, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function cleanText(value, fallback, maxLength = 300) {
  const normalized = String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return normalized.slice(0, maxLength) || fallback;
}

export function parseWechatProfile(payload, sourceUrl) {
  const candidate = firstObject(unwrap(payload), (value) => (
    typeof value.id === "string"
    && value.objectDesc
    && Array.isArray(value.objectDesc.media)
  ));
  if (!candidate) {
    throw sidecarError(
      "桌面微信没有返回可下载的视频详情，请在微信中打开目标视频后重试。",
      "WECHAT_VIDEO_NOT_OBSERVED",
      "resolve-wechat",
    );
  }
  const media = candidate.objectDesc.media.find((entry) => entry?.url) ?? null;
  if (!media) {
    throw sidecarError(
      "视频详情中没有媒体地址。",
      "WECHAT_MEDIA_URL_MISSING",
      "resolve-wechat",
      null,
      false,
    );
  }
  const mediaUrl = `${media.url}${media.urlToken ?? ""}`;
  const directDurationMs = Number(media.spec?.[0]?.durationMs);
  const playLengthSeconds = Number(media.videoPlayLen);
  let parsedMediaUrl;
  try {
    parsedMediaUrl = new URL(mediaUrl);
  } catch {
    throw sidecarError(
      "视频详情中的媒体地址无效。",
      "WECHAT_MEDIA_URL_INVALID",
      "resolve-wechat",
      null,
      false,
    );
  }
  if (!["http:", "https:"].includes(parsedMediaUrl.protocol)) {
    throw sidecarError(
      "视频详情中的媒体协议不受支持。",
      "WECHAT_MEDIA_URL_INVALID",
      "resolve-wechat",
      null,
      false,
    );
  }
  return {
    author: cleanText(candidate.contact?.nickname, "微信视频号", 200),
    download: {
      authorName: cleanText(candidate.contact?.nickname, "微信视频号", 200),
      durationMs: Number.isFinite(directDurationMs)
        ? directDurationMs
        : (Number.isFinite(playLengthSeconds) ? playLengthSeconds * 1000 : 0),
      fileFormat: cleanText(media.spec?.[0]?.fileFormat, "mp4", 20),
      id: candidate.id,
      key: media.decodeKey === undefined || media.decodeKey === null
        ? ""
        : String(media.decodeKey),
      sourceURL: sourceUrl,
      title: cleanText(candidate.objectDesc.description, "微信视频号视频"),
      url: mediaUrl,
    },
    id: candidate.id,
    title: cleanText(candidate.objectDesc.description, "微信视频号视频"),
  };
}

export function parseWechatResolvedProfile(payload, sourceUrl) {
  const data = unwrap(payload);
  const resolved = Array.isArray(data?.resolved) ? data.resolved : [];
  const candidate = resolved.find((entry) => (
    entry
    && typeof entry === "object"
    && typeof entry.id === "string"
    && typeof entry.url === "string"
  ));
  if (!candidate) {
    throw sidecarError(
      "微信分享链接暂未解析出可下载视频，请保持目标视频页面打开后重试。",
      "WECHAT_SHARE_NOT_RESOLVED",
      "resolve-wechat",
    );
  }

  let parsedMediaUrl;
  try {
    parsedMediaUrl = new URL(candidate.url);
  } catch {
    throw sidecarError(
      "微信分享解析返回了无效媒体地址。",
      "WECHAT_MEDIA_URL_INVALID",
      "resolve-wechat",
      null,
      false,
    );
  }
  if (!["http:", "https:"].includes(parsedMediaUrl.protocol)) {
    throw sidecarError(
      "微信分享解析返回了不受支持的媒体协议。",
      "WECHAT_MEDIA_URL_INVALID",
      "resolve-wechat",
      null,
      false,
    );
  }

  const title = cleanText(candidate.title, "微信视频号视频");
  const author = cleanText(candidate.authorName, "微信视频号", 200);
  const durationMs = Number(candidate.durationMs);
  return {
    author,
    download: {
      authorName: author,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      fileFormat: "mp4",
      id: candidate.id,
      key: candidate.key === undefined || candidate.key === null
        ? ""
        : String(candidate.key),
      resolution: cleanText(candidate.resolution, "", 40),
      sourceURL: sourceUrl,
      title,
      url: candidate.url,
    },
    id: candidate.id,
    title,
  };
}

export function parseWechatBrowseProfile(payload, sourceUrl, {
  notBeforeMs = 0,
} = {}) {
  const records = listFromBrowsePayload(payload);
  const candidate = records.find((entry) => {
    if (!entry || typeof entry !== "object" || !entry.id || !entry.videoUrl) return false;
    const observedAt = Date.parse(entry.browseTime);
    if (!Number.isFinite(observedAt) || observedAt < notBeforeMs - 5000) return false;
    try {
      const pageUrl = new URL(entry.pageUrl);
      return pageUrl.hostname === "channels.weixin.qq.com"
        && ["/web/pages/feed", "/web/pages/home"].some((prefix) => (
          pageUrl.pathname.startsWith(prefix)
        ));
    } catch {
      return false;
    }
  });
  if (!candidate) {
    throw sidecarError(
      "本次微信高级模式启动后尚未观察到当前视频，请保持目标视频页面打开后重试。",
      "WECHAT_CURRENT_VIDEO_NOT_OBSERVED",
      "resolve-wechat",
    );
  }

  let parsedMediaUrl;
  try {
    parsedMediaUrl = new URL(candidate.videoUrl);
  } catch {
    throw sidecarError(
      "微信当前页面记录中的媒体地址无效。",
      "WECHAT_MEDIA_URL_INVALID",
      "resolve-wechat",
      null,
      false,
    );
  }
  if (!["http:", "https:"].includes(parsedMediaUrl.protocol)) {
    throw sidecarError(
      "微信当前页面记录中的媒体协议不受支持。",
      "WECHAT_MEDIA_URL_INVALID",
      "resolve-wechat",
      null,
      false,
    );
  }

  const title = cleanText(candidate.title, "微信视频号视频");
  const author = cleanText(candidate.author, "微信视频号", 200);
  const rawDuration = Number(candidate.duration);
  const durationMs = Number.isFinite(rawDuration) && rawDuration > 0
    ? (rawDuration < 24 * 60 * 60 ? rawDuration * 1000 : rawDuration)
    : 0;
  return {
    author,
    download: {
      authorName: author,
      durationMs,
      fileFormat: cleanText(candidate.fileFormat, "mp4", 20),
      id: String(candidate.id),
      key: candidate.decryptKey === undefined || candidate.decryptKey === null
        ? ""
        : String(candidate.decryptKey),
      resolution: cleanText(candidate.resolution, "", 40),
      sourceURL: sourceUrl,
      title,
      url: candidate.videoUrl,
    },
    id: String(candidate.id),
    title,
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ensureInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedCandidate;
  }
  throw sidecarError(
    "下载结果不在视频知识捕手管理的临时目录中，已拒绝继续处理。",
    "WECHAT_DOWNLOAD_OUTSIDE_WORKDIR",
    "download-wechat",
    null,
    false,
  );
}

function listFromDownloadPayload(payload) {
  const data = unwrap(payload);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  return [];
}

function listFromBrowsePayload(payload) {
  const data = unwrap(payload);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  return [];
}

async function downloadedMediaHasKnownHeader(mediaPath) {
  const handle = await open(mediaPath, "r");
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 12) return false;
    const limit = Math.min(bytesRead, 32);
    for (let index = 4; index + 4 <= limit; index += 1) {
      const boxType = header.subarray(index, index + 4).toString("ascii");
      if (["ftyp", "styp", "moov", "mdat"].includes(boxType)) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

export class WechatSidecar {
  constructor(configDir, {
    apiBase = DEFAULT_API_BASE,
    bufferCaptureTimeoutMs = 2 * 60 * 1000,
    bufferRuntimeFactory = prepareWechatBufferRuntime,
    fetchImpl = fetch,
    pollIntervalMs = 500,
    proxyBase = DEFAULT_PROXY_BASE,
    spawnImpl = spawn,
    startupTimeoutMs = 30000,
  } = {}) {
    this.configDir = path.resolve(configDir);
    this.apiBase = apiBase;
    this.bufferCaptureTimeoutMs = bufferCaptureTimeoutMs;
    this.bufferRuntimeFactory = bufferRuntimeFactory;
    this.fetchImpl = fetchImpl;
    this.pollIntervalMs = pollIntervalMs;
    this.proxyBase = proxyBase;
    this.spawnImpl = spawnImpl;
    this.startupTimeoutMs = startupTimeoutMs;
    this.child = null;
    this.bufferRunId = null;
    this.bufferRunRoot = null;
    this.captureDir = null;
    this.downloadDir = path.join(resolveWorkDir(this.configDir), "wechat-downloads");
    this.upstreamDownloadDir = null;
    this.logDir = path.join(this.configDir, "logs", "wx-channel");
    this.logFile = path.join(this.logDir, "wx_channel.log");
    this.observationStartedAt = 0;
    this.profileCache = new Map();
  }

  async start() {
    this.observationStartedAt = Date.now();
    this.profileCache.clear();
    if (await this.health().then((value) => value.serviceReady).catch(() => false)) {
      return { mode: "existing", pid: null };
    }
    const bufferRuntime = await this.bufferRuntimeFactory(this.configDir);
    const executable = bufferRuntime.executablePath;
    this.bufferRunId = bufferRuntime.runId;
    this.bufferRunRoot = bufferRuntime.runRoot;
    this.captureDir = bufferRuntime.captureDir;
    this.upstreamDownloadDir = bufferRuntime.downloadDir;
    await Promise.all([
      mkdir(this.downloadDir, { recursive: true }),
      mkdir(this.logDir, { recursive: true }),
    ]);
    const child = this.spawnImpl(executable, [], {
      cwd: path.dirname(executable),
      env: {
        ...process.env,
        WX_CHANNEL_DOWNLOADS_DIR: this.downloadDir,
        WX_CHANNEL_LOG_FILE: this.logFile,
      },
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    this.child = child;
    let exitDetails = null;
    let spawnError = null;
    child.once?.("exit", (code, signal) => {
      exitDetails = { code, signal };
      if (this.child === child) this.child = null;
    });
    child.once?.("error", (error) => {
      spawnError = error;
      if (this.child === child) this.child = null;
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.startupTimeoutMs) {
      if (spawnError || exitDetails) {
        const detail = exitDetails
          ? `（退出码 ${exitDetails.code ?? "未知"}${exitDetails.signal ? `，信号 ${exitDetails.signal}` : ""}）`
          : "";
        throw sidecarError(
          `微信视频号组件在服务就绪前退出${detail}，请查看受管日志后安全重试。`,
          "WECHAT_SIDECAR_EXITED",
          "start-wechat",
          spawnError,
        );
      }
      const status = await this.health().catch(() => ({ serviceReady: false }));
      if (status.serviceReady) return { mode: "started", pid: child.pid ?? null };
      await wait(this.pollIntervalMs);
    }
    await this.stop();
    throw sidecarError(
      "微信视频号组件在 30 秒内未就绪，请查看受管日志并确认本机端口未被占用。",
      "WECHAT_SIDECAR_START_TIMEOUT",
      "start-wechat",
    );
  }

  async stop() {
    this.profileCache.clear();
    if (!this.child) return { stopped: false };
    const child = this.child;
    this.child = null;
    const exited = new Promise((resolve) => child.once?.("exit", resolve));
    const stopped = child.kill();
    if (stopped) {
      await Promise.race([exited, wait(5000)]);
    }
    return { stopped };
  }

  async purgeManagedArtifacts() {
    const purgeTargets = [
      rm(this.downloadDir, { recursive: true, force: true }),
      rm(this.logDir, { recursive: true, force: true }),
    ];
    if (this.bufferRunRoot) {
      purgeTargets.push(rm(this.bufferRunRoot, { recursive: true, force: true }));
    }
    await Promise.all(purgeTargets);
    this.bufferRunId = null;
    this.bufferRunRoot = null;
    this.captureDir = null;
    this.upstreamDownloadDir = null;
    return { purged: true };
  }

  async waitForBufferCapture({ timeoutMs = this.bufferCaptureTimeoutMs } = {}) {
    if (!this.captureDir || !this.bufferRunId) return null;
    const expectedPrefix = `p0004-${this.bufferRunId}-buffer-`;
    const startedAt = Date.now();
    let firstVideoCandidateAt = 0;
    while (Date.now() - startedAt < timeoutMs) {
      let entries = [];
      try {
        entries = await readdir(this.captureDir, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const candidates = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(expectedPrefix)) continue;
        const candidate = ensureInside(this.captureDir, path.join(this.captureDir, entry.name));
        let metadata;
        try {
          metadata = await stat(candidate);
        } catch {
          continue;
        }
        if (!metadata.isFile() || metadata.size <= 0) continue;
        if (!(await downloadedMediaHasKnownHeader(candidate).catch(() => false))) continue;
        candidates.push({
          audio: /audio/i.test(entry.name),
          mediaPath: candidate,
          name: entry.name,
          size: metadata.size,
        });
      }
      candidates.sort((left, right) => (
        Number(right.audio) - Number(left.audio)
        || right.size - left.size
      ));
      const selected = candidates[0];
      if (selected) {
        if (selected.audio || (firstVideoCandidateAt && Date.now() - firstVideoCandidateAt >= 5000)) {
          await mkdir(this.downloadDir, { recursive: true });
          const target = ensureInside(
            this.downloadDir,
            path.join(this.downloadDir, `${Date.now()}-${selected.name}`),
          );
          await rename(selected.mediaPath, target);
          return target;
        }
        if (!firstVideoCandidateAt) firstVideoCandidateAt = Date.now();
      }
      await wait(Math.max(50, this.pollIntervalMs));
    }
    return null;
  }

  async health() {
    let serviceReady = false;
    let clientReady = false;
    try {
      await requestJson(this.fetchImpl, `${this.proxyBase}/api/health`, {}, 1500);
      serviceReady = true;
    } catch {
      serviceReady = false;
    }
    if (serviceReady) {
      try {
        const status = unwrap(await requestJson(
          this.fetchImpl,
          `${this.apiBase}/api/channels/status`,
          {},
          2500,
        ));
        clientReady = Boolean(
          status?.connected
          || status?.clientReady
          || status?.available
          || status?.client_count > 0
          || status?.clientCount > 0
          || status?.clients > 0
          || status?.ready_clients > 0
          || status?.profile_ready_clients > 0
          || status?.feed_ready_clients > 0
        );
      } catch {
        clientReady = false;
      }
    }
    return {
      clientReady,
      downloadDir: this.downloadDir,
      managedProcess: Boolean(this.child),
      serviceReady,
    };
  }

  async resolveVideo(sourceUrl, {
    notBeforeMs = this.observationStartedAt,
  } = {}) {
    const cached = this.profileCache.get(sourceUrl);
    if (cached && Date.now() - cached.resolvedAt < 5 * 60 * 1000) {
      return cached.profile;
    }

    let shareError = null;
    try {
      const payload = await requestJson(this.fetchImpl, `${this.apiBase}/api/channels/share/resolve`, {
        body: JSON.stringify({ urls: [sourceUrl] }),
        method: "POST",
      }, 20000);
      const profile = parseWechatResolvedProfile(payload, sourceUrl);
      this.profileCache.set(sourceUrl, { profile, resolvedAt: Date.now() });
      return profile;
    } catch (error) {
      shareError = error;
    }

    let currentPageError = null;
    try {
      const payload = await requestJson(
        this.fetchImpl,
        `${this.apiBase}/api/browse?page=1&pageSize=10&sortBy=browse_time&sortOrder=desc`,
        {},
        5000,
      );
      const profile = parseWechatBrowseProfile(payload, sourceUrl, {
        notBeforeMs,
      });
      this.profileCache.set(sourceUrl, { profile, resolvedAt: Date.now() });
      return profile;
    } catch (error) {
      currentPageError = error;
    }

    try {
      const url = new URL(`${this.apiBase}/api/channels/feed/profile`);
      url.searchParams.set("url", sourceUrl);
      const payload = await requestJson(this.fetchImpl, url, {}, 20000);
      const profile = parseWechatProfile(payload, sourceUrl);
      this.profileCache.set(sourceUrl, { profile, resolvedAt: Date.now() });
      return profile;
    } catch (error) {
      if (currentPageError?.code === "WECHAT_CURRENT_VIDEO_NOT_OBSERVED") {
        throw currentPageError;
      }
      if (error?.code === "WECHAT_VIDEO_NOT_OBSERVED" && shareError) {
        throw shareError;
      }
      throw error;
    }
  }

  async resolveCurrentPageVideo(sourceUrl, {
    notBeforeMs = this.observationStartedAt,
  } = {}) {
    const health = await this.health();
    if (!health.clientReady) {
      throw sidecarError(
        "桌面微信视频号页面尚未连接；请在高级模式启动后重新打开并播放目标视频。",
        "WECHAT_CLIENT_NOT_READY",
        "resolve-wechat",
      );
    }
    const payload = await requestJson(
      this.fetchImpl,
      `${this.apiBase}/api/browse?page=1&pageSize=10&sortBy=browse_time&sortOrder=desc`,
      {},
      5000,
    );
    const profile = parseWechatBrowseProfile(payload, sourceUrl, { notBeforeMs });
    this.profileCache.set(sourceUrl, { profile, resolvedAt: Date.now() });
    return profile;
  }

  async download(sourceUrl, options = {}) {
    const health = await this.health();
    if (!health.serviceReady) {
      throw sidecarError(
        "微信视频号组件尚未启动。",
        "WECHAT_SIDECAR_NOT_RUNNING",
        "connect-wechat",
      );
    }
    const profile = await this.resolveVideo(sourceUrl);
    return this.downloadResolvedProfile(profile, { ...options, skipHealth: true });
  }

  async downloadResolvedProfile(profile, {
    onProgress = () => {},
    skipHealth = false,
    timeoutMs = 15 * 60 * 1000,
  } = {}) {
    const health = skipHealth ? { serviceReady: true } : await this.health();
    if (!health.serviceReady) {
      throw sidecarError(
        "微信视频号组件尚未启动。",
        "WECHAT_SIDECAR_NOT_RUNNING",
        "connect-wechat",
      );
    }
    if (
      !profile
      || typeof profile !== "object"
      || !profile.download
      || typeof profile.download.url !== "string"
      || !profile.download.id
    ) {
      throw sidecarError(
        "视频解析器没有返回可下载的媒体资料。",
        "WECHAT_RESOLVED_PROFILE_INVALID",
        "resolve-wechat",
        null,
        false,
      );
    }
    let parsedMediaUrl;
    try {
      parsedMediaUrl = new URL(profile.download.url);
    } catch {
      throw sidecarError(
        "视频解析器返回了无效媒体地址。",
        "WECHAT_MEDIA_URL_INVALID",
        "resolve-wechat",
        null,
        false,
      );
    }
    if (!["http:", "https:"].includes(parsedMediaUrl.protocol)) {
      throw sidecarError(
        "视频解析器返回了不受支持的媒体协议。",
        "WECHAT_MEDIA_URL_INVALID",
        "resolve-wechat",
        null,
        false,
      );
    }
    const bufferedResult = async () => {
      const mediaPath = await this.waitForBufferCapture();
      if (!mediaPath) return null;
      return {
        author: profile.author,
        durationSeconds: Number(profile.download.durationMs ?? 0) / 1000,
        mediaPath,
        title: profile.title,
        videoId: profile.id,
      };
    };
    const requestVideo = profile.download;
    let trackedVideoId = profile.id;
    let plainRetryAttempted = false;
    const startBatch = async (video, forceRedownload) => requestJson(
      this.fetchImpl,
      `${this.proxyBase}/__wx_channels_api/batch_start`,
      {
        body: JSON.stringify({ forceRedownload, videos: [video] }),
        method: "POST",
      },
      30000,
    );
    const startPlainRetry = async () => {
      plainRetryAttempted = true;
      trackedVideoId = `${profile.id}-plain-${Date.now()}`;
      await startBatch({
        ...requestVideo,
        id: trackedVideoId,
        key: "",
      }, true);
    };
    await startBatch(requestVideo, false);

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await wait(1000);
      let progress = null;
      try {
        progress = unwrap(await requestJson(
          this.fetchImpl,
          `${this.proxyBase}/__wx_channels_api/batch_progress`,
          {},
          5000,
        ));
        onProgress(progress);
      } catch {
        // Download records remain authoritative when progress polling is transiently unavailable.
      }
      const recordsPayload = await requestJson(
        this.fetchImpl,
        `${this.proxyBase}/api/downloads?page=1&pageSize=100`,
        {},
        5000,
      );
      const record = listFromDownloadPayload(recordsPayload).find((entry) => (
        String(entry.videoId ?? entry.video_id ?? "") === String(trackedVideoId)
      ));
      if (record?.status === "failed") {
        if (!plainRetryAttempted && requestVideo.key) {
          await startPlainRetry();
          continue;
        }
        const captured = await bufferedResult();
        if (captured) return captured;
        throw sidecarError(
          `微信视频下载失败：${cleanText(record.errorMessage, "未知错误", 300)}`,
          "WECHAT_DOWNLOAD_FAILED",
          "download-wechat",
        );
      }
      if (record?.status === "completed" && record.filePath) {
        const candidate = path.isAbsolute(record.filePath)
          ? record.filePath
          : path.join(this.downloadDir, record.filePath);
        let mediaPath;
        try {
          mediaPath = ensureInside(this.downloadDir, candidate);
        } catch (error) {
          if (error?.code !== "WECHAT_DOWNLOAD_OUTSIDE_WORKDIR" || !this.upstreamDownloadDir) {
            throw error;
          }
          const upstreamPath = ensureInside(this.upstreamDownloadDir, candidate);
          let upstreamMetadata;
          try {
            upstreamMetadata = await stat(upstreamPath);
          } catch (cause) {
            throw sidecarError(
              "上游下载记录已完成，但对应媒体文件不存在。",
              "WECHAT_DOWNLOAD_FILE_MISSING",
              "download-wechat",
              cause,
            );
          }
          if (
            !upstreamMetadata.isFile()
            || upstreamMetadata.size <= 0
            || upstreamMetadata.mtimeMs < startedAt - 10000
          ) {
            throw sidecarError(
              "上游下载结果不是本次任务刚生成的有效媒体文件，已拒绝接管。",
              "WECHAT_DOWNLOAD_FILE_INVALID",
              "download-wechat",
            );
          }
          await mkdir(this.downloadDir, { recursive: true });
          const adoptedName = `${Date.now()}-${path.basename(upstreamPath)}`;
          mediaPath = ensureInside(this.downloadDir, path.join(this.downloadDir, adoptedName));
          try {
            await rename(upstreamPath, mediaPath);
          } catch (cause) {
            throw sidecarError(
              "无法把上游下载结果迁入视频知识捕手管理的临时目录。",
              "WECHAT_DOWNLOAD_ADOPTION_FAILED",
              "download-wechat",
              cause,
            );
          }
        }
        let metadata;
        try {
          metadata = await stat(mediaPath);
        } catch (error) {
          throw sidecarError(
            "下载记录已完成，但媒体文件不存在。",
            "WECHAT_DOWNLOAD_FILE_MISSING",
            "download-wechat",
            error,
          );
        }
        if (!metadata.isFile() || metadata.size <= 0) {
          throw sidecarError(
            "下载结果不是有效媒体文件。",
            "WECHAT_DOWNLOAD_FILE_INVALID",
            "download-wechat",
          );
        }
        if (!(await downloadedMediaHasKnownHeader(mediaPath))) {
          await rm(mediaPath, { force: true });
          const captured = await bufferedResult();
          if (captured) return captured;
          throw sidecarError(
            "微信下载结果仍是加密字节流，且当前页面没有生成可用的本地播放器缓冲；请重新打开目标视频并播放至结束后安全重试。",
            "WECHAT_DECRYPTION_FAILED",
            "decrypt-wechat",
          );
        }
        return {
          author: profile.author,
          durationSeconds: Number(record.duration ?? 0),
          mediaPath,
          title: profile.title,
          videoId: profile.id,
        };
      }
      if (Number(progress?.failed ?? 0) > 0 && Number(progress?.running ?? 0) === 0) {
        if (!plainRetryAttempted && requestVideo.key) {
          await startPlainRetry();
          continue;
        }
        const captured = await bufferedResult();
        if (captured) return captured;
        throw sidecarError(
          "微信视频下载队列报告失败。",
          "WECHAT_DOWNLOAD_FAILED",
          "download-wechat",
        );
      }
    }
    const captured = await bufferedResult();
    if (captured) return captured;
    throw sidecarError(
      "微信视频下载等待超时。",
      "WECHAT_DOWNLOAD_TIMEOUT",
      "download-wechat",
    );
  }
}
