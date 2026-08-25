#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AppConfigError,
  loadAppConfig,
  resolveDefaultConfigDir,
  resolveStateDir,
  saveAppConfig,
  validateInboxDirectory,
  validateRetainedMediaDirectory,
} from "./app-config.mjs";
import {
  CaptureError,
  captureVideo,
  listFailureRecords,
  normalizeVideoUrl,
  retryFailure,
} from "./core.mjs";
import { extractPublicMetadata } from "./content-extractor.mjs";
import { MediaJobError, MediaJobService } from "./media-jobs.mjs";
import { detectPlatform } from "./platforms.mjs";
import {
  canAutoDownloadPlatform,
  PublicMediaDownloadError,
} from "./public-media-downloader.mjs";
import { getRuntimeStatus, installRuntime, RuntimeError } from "./runtime-manager.mjs";
import { MediaProcessingError } from "./transcriber.mjs";
import { APP_VERSION } from "./version.mjs";
import {
  manageWechatCertificate,
  WechatCertificateError,
} from "./wechat-certificate.mjs";
import { WechatSidecarError } from "./wechat-sidecar.mjs";
import { WindowsCredentialError } from "./windows-credential.mjs";
import { YuanbaoResolverError } from "./yuanbao-resolver.mjs";
import { YuanbaoSessionError } from "./yuanbao-session.mjs";

const DEFAULT_PORT = 43127;
const MAX_BODY_BYTES = 256 * 1024;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(projectRoot, "web");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function baseHeaders(contentType) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, baseHeaders("application/json; charset=utf-8"));
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "请求必须使用 application/json。", "JSON_REQUIRED");
  }

  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "请求内容过大。", "BODY_TOO_LARGE");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "请求内容过大。", "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "JSON 格式无效。", "INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "请求内容必须是 JSON 对象。", "INVALID_JSON_OBJECT");
  }
  return parsed;
}

function enforceSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) {
    return;
  }
  const expectedOrigin = `http://${request.headers.host}`;
  if (origin !== expectedOrigin) {
    throw new HttpError(403, "拒绝跨来源请求。", "ORIGIN_REJECTED");
  }
}

function validateCapturePayload(payload) {
  if (typeof payload.url !== "string" || payload.url.trim() === "") {
    throw new HttpError(400, "请粘贴一个公开视频链接。", "URL_REQUIRED");
  }
  if (payload.url.length > 4096) {
    throw new HttpError(400, "视频链接过长。", "URL_TOO_LONG");
  }
  if (payload.note !== undefined && typeof payload.note !== "string") {
    throw new HttpError(400, "备注必须是文本。", "INVALID_NOTE");
  }
  if ((payload.note ?? "").length > 10000) {
    throw new HttpError(400, "备注最多 10000 个字符。", "NOTE_TOO_LONG");
  }
  if (
    payload.providedTitle !== undefined
    && typeof payload.providedTitle !== "string"
  ) {
    throw new HttpError(400, "视频标题必须是文本。", "INVALID_PROVIDED_TITLE");
  }
  if ((payload.providedTitle ?? "").length > 300) {
    throw new HttpError(400, "视频标题最多 300 个字符。", "PROVIDED_TITLE_TOO_LONG");
  }
  if (payload.transcript !== undefined && typeof payload.transcript !== "string") {
    throw new HttpError(400, "视频文案或字幕必须是文本。", "INVALID_TRANSCRIPT");
  }
  if ((payload.transcript ?? "").length > 40000) {
    throw new HttpError(400, "视频文案或字幕最多 40000 个字符。", "TRANSCRIPT_TOO_LONG");
  }
  return {
    note: payload.note ?? "",
    providedTitle: payload.providedTitle ?? "",
    transcript: payload.transcript ?? "",
    url: payload.url,
  };
}

function validateIntakePayload(payload) {
  const capture = validateCapturePayload({ url: payload.url });
  if (payload.keepMedia !== undefined && typeof payload.keepMedia !== "boolean") {
    throw new HttpError(400, "保留视频选项必须是布尔值。", "INVALID_KEEP_MEDIA");
  }
  return {
    keepMedia: payload.keepMedia !== false,
    url: capture.url,
  };
}

async function configuredInbox(configDir) {
  const config = await loadAppConfig(configDir);
  if (!config.inboxDir) {
    throw new HttpError(409, "请先配置 Obsidian Inbox。", "CONFIG_REQUIRED");
  }
  return config.inboxDir;
}

async function buildStatus(configDir) {
  let config;
  try {
    config = await loadAppConfig(configDir);
  } catch (error) {
    if (error instanceof AppConfigError) {
      return {
        configured: false,
        inboxDir: null,
        inboxStatus: "error",
        retainedMediaDir: null,
        wechatAdvancedEnabled: false,
        message: error.message,
        errorCode: error.code,
      };
    }
    throw error;
  }

  if (!config.inboxDir) {
    return {
      configured: false,
      inboxDir: null,
      inboxStatus: "not-configured",
      retainedMediaDir: config.retainedMediaDir ?? path.join(path.resolve(configDir), "retained-media"),
      wechatAdvancedEnabled: config.wechatAdvancedEnabled,
      message: "设置一次 Inbox 后即可开始采集。",
      errorCode: null,
    };
  }

  try {
    const inboxDir = await validateInboxDirectory(config.inboxDir);
    return {
      configured: true,
      inboxDir,
      inboxStatus: "ready",
      retainedMediaDir: config.retainedMediaDir ?? path.join(path.resolve(configDir), "retained-media"),
      wechatAdvancedEnabled: config.wechatAdvancedEnabled,
      message: "Inbox 已就绪。",
      errorCode: null,
    };
  } catch (error) {
    if (error instanceof AppConfigError) {
      return {
        configured: true,
        inboxDir: config.inboxDir,
        inboxStatus: "unavailable",
        retainedMediaDir: config.retainedMediaDir ?? path.join(path.resolve(configDir), "retained-media"),
        wechatAdvancedEnabled: config.wechatAdvancedEnabled,
        message: error.message,
        errorCode: error.code,
      };
    }
    throw error;
  }
}

function publicFailureRecord(record) {
  return {
    failureId: record.failure_id,
    captureId: record.capture_id,
    failedAt: record.failed_at,
    stage: record.stage,
    errorCode: record.error_code,
    message: record.message,
    retryable: record.retryable,
    sourceUrl: record.retry_input?.url ?? "",
    note: record.retry_input?.note ?? "",
    resolution: record.resolution,
    lastRetry: record.last_retry
      ? {
          attemptedAt: record.last_retry.attempted_at,
          result: record.last_retry.result,
          notePath: record.last_retry.note_path ?? null,
          errorCode: record.last_retry.error_code ?? null,
        }
      : null,
  };
}

function captureResult(result) {
  return {
    status: result.status,
    captureId: result.captureId,
    content: result.content
      ? {
          errorCode: result.content.errorCode,
          errorMessage: result.content.errorMessage,
          fieldCount: result.content.fieldCount,
          status: result.content.status,
          title: result.content.title,
        }
      : null,
    material: result.material ?? null,
    notePath: result.notePath,
    platform: result.platform,
    retriedFailureId: result.retriedFailureId ?? null,
  };
}

function errorResponse(error) {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      payload: { error: { code: error.code, message: error.message } },
    };
  }
  if (error instanceof AppConfigError) {
    return {
      status: error.code === "CONFIG_WRITE_FAILED" ? 500 : 400,
      payload: { error: { code: error.code, message: error.message } },
    };
  }
  if (error instanceof CaptureError) {
    const validationCodes = new Set([
      "INVALID_NOTE",
      "INVALID_PROVIDED_TITLE",
      "INVALID_TRANSCRIPT",
      "INVALID_URL",
      "PROVIDED_TITLE_TOO_LONG",
      "TRANSCRIPT_TOO_LONG",
      "UNSUPPORTED_PROTOCOL",
      "URL_CREDENTIALS_NOT_ALLOWED",
    ]);
    return {
      status: validationCodes.has(error.code) ? 400 : 422,
      payload: {
        error: {
          code: error.code,
          message: error.message,
          stage: error.stage,
          retryable: error.retryable,
          failureId: error.failureId,
        },
      },
    };
  }
  if (
    error instanceof MediaJobError
    || error instanceof RuntimeError
    || error instanceof MediaProcessingError
    || error instanceof WechatCertificateError
    || error instanceof WechatSidecarError
    || error instanceof WindowsCredentialError
    || error instanceof YuanbaoResolverError
    || error instanceof YuanbaoSessionError
    || error instanceof PublicMediaDownloadError
  ) {
    return {
      status: error.code?.endsWith("NOT_FOUND") ? 404 : 422,
      payload: {
        error: {
          code: error.code ?? "MEDIA_JOB_FAILED",
          message: error.message,
          retryable: error.retryable ?? false,
          stage: error.stage ?? "media-job",
        },
      },
    };
  }
  return {
    status: 500,
    payload: { error: { code: "INTERNAL_ERROR", message: "本地服务发生未处理错误。" } },
  };
}

async function serveStatic(requestPath, response) {
  const entry = staticFiles.get(requestPath);
  if (!entry) {
    return false;
  }
  const [fileName, contentType] = entry;
  const content = await readFile(path.join(webRoot, fileName));
  response.writeHead(200, baseHeaders(contentType));
  response.end(content);
  return true;
}

export function createLocalServer({
  certificateManager = manageWechatCertificate,
  configDir = resolveDefaultConfigDir(),
  contentExtractor = extractPublicMetadata,
  directoryOpener = openLocalDirectory,
  logger = console,
  mediaJobService = null,
} = {}) {
  const resolvedConfigDir = path.resolve(configDir);
  const stateDir = resolveStateDir(resolvedConfigDir);
  const mediaJobs = mediaJobService ?? new MediaJobService(resolvedConfigDir, {
    contentExtractor,
  });

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const requestPath = requestUrl.pathname;

      if (request.method === "GET" && await serveStatic(requestPath, response)) {
        return;
      }

      if (!requestPath.startsWith("/api/")) {
        throw new HttpError(404, "页面不存在。", "NOT_FOUND");
      }

      if (!["GET", "HEAD"].includes(request.method ?? "")) {
        enforceSameOrigin(request);
      }

      if (request.method === "GET" && requestPath === "/api/health") {
        sendJson(response, 200, {
          app: "video-knowledge-capture",
          version: APP_VERSION,
          status: "ok",
          binding: "127.0.0.1",
        });
        return;
      }

      if (request.method === "GET" && requestPath === "/api/status") {
        sendJson(response, 200, {
          app: { name: "视频知识捕手", version: APP_VERSION },
          configuration: await buildStatus(resolvedConfigDir),
        });
        return;
      }

      if (request.method === "PUT" && requestPath === "/api/config") {
        const payload = await readJsonBody(request);
        const updates = {};
        if (Object.hasOwn(payload, "inboxDir")) updates.inboxDir = payload.inboxDir;
        if (Object.hasOwn(payload, "wechatAdvancedEnabled")) {
          updates.wechatAdvancedEnabled = payload.wechatAdvancedEnabled;
        }
        if (Object.hasOwn(payload, "retainedMediaDir")) {
          updates.retainedMediaDir = payload.retainedMediaDir;
        }
        if (Object.keys(updates).length === 0) {
          throw new HttpError(400, "没有可保存的配置。", "CONFIG_UPDATE_EMPTY");
        }
        await saveAppConfig(resolvedConfigDir, updates);
        sendJson(response, 200, { configuration: await buildStatus(resolvedConfigDir) });
        return;
      }

      if (request.method === "POST" && requestPath === "/api/retained-media/open") {
        if (!request.headers.origin) {
          throw new HttpError(
            403,
            "打开视频目录只能由本地应用页面触发。",
            "ORIGIN_REQUIRED",
          );
        }
        const config = await loadAppConfig(resolvedConfigDir);
        const retainedMediaDir = await validateRetainedMediaDirectory(
          config.retainedMediaDir ?? path.join(resolvedConfigDir, "retained-media"),
        );
        try {
          await directoryOpener(retainedMediaDir);
        } catch {
          throw new HttpError(
            500,
            "无法打开视频保存目录，请复制页面中的完整路径后手动打开。",
            "RETAINED_MEDIA_OPEN_FAILED",
          );
        }
        sendJson(response, 200, { retainedMediaDir });
        return;
      }

      if (request.method === "GET" && requestPath === "/api/runtime") {
        sendJson(response, 200, { runtime: await getRuntimeStatus(resolvedConfigDir) });
        return;
      }

      if (request.method === "POST" && requestPath === "/api/runtime/install") {
        const payload = await readJsonBody(request);
        const runtime = await installRuntime(resolvedConfigDir, {
          ...(Array.isArray(payload.components) ? { components: payload.components } : {}),
        });
        sendJson(response, 200, { runtime });
        return;
      }

      if (request.method === "GET" && requestPath === "/api/wechat/status") {
        const [configuration, runtime, sidecar] = await Promise.all([
          loadAppConfig(resolvedConfigDir),
          getRuntimeStatus(resolvedConfigDir),
          mediaJobs.sidecar.health(),
        ]);
        sendJson(response, 200, {
          wechat: {
            advancedEnabled: configuration.wechatAdvancedEnabled,
            runtimeReady: runtime.components.wxChannel.ready,
            ...sidecar,
          },
        });
        return;
      }

      if (request.method === "POST" && requestPath === "/api/wechat/start") {
        await readJsonBody(request);
        const configuration = await loadAppConfig(resolvedConfigDir);
        if (!configuration.wechatAdvancedEnabled) {
          throw new HttpError(
            409,
            "请先显式启用微信高级模式。",
            "WECHAT_ADVANCED_MODE_DISABLED",
          );
        }
        sendJson(response, 200, {
          wechat: await mediaJobs.sidecar.start(),
        });
        return;
      }

      if (request.method === "POST" && requestPath === "/api/wechat/stop") {
        await readJsonBody(request);
        sendJson(response, 200, {
          wechat: await mediaJobs.sidecar.stop(),
        });
        return;
      }

      if (request.method === "GET" && requestPath === "/api/yuanbao/status") {
        sendJson(response, 200, {
          yuanbao: await mediaJobs.yuanbaoResolver.session.status(),
        });
        return;
      }

      if (request.method === "POST" && requestPath === "/api/yuanbao/login/start") {
        await readJsonBody(request);
        const configuration = await loadAppConfig(resolvedConfigDir);
        if (!configuration.wechatAdvancedEnabled) {
          throw new HttpError(
            409,
            "请先显式启用微信高级模式。",
            "WECHAT_ADVANCED_MODE_DISABLED",
          );
        }
        sendJson(response, 202, {
          yuanbao: await mediaJobs.yuanbaoResolver.session.startLogin(),
        });
        return;
      }

      if (request.method === "POST" && requestPath === "/api/yuanbao/login/cancel") {
        await readJsonBody(request);
        sendJson(response, 200, {
          yuanbao: await mediaJobs.yuanbaoResolver.session.cancelLogin(),
        });
        return;
      }

      if (request.method === "POST" && requestPath === "/api/yuanbao/session/forget") {
        await readJsonBody(request);
        sendJson(response, 200, {
          yuanbao: await mediaJobs.yuanbaoResolver.session.forget(),
        });
        return;
      }

      const certificateMatch = requestPath.match(
        /^\/api\/wechat\/certificate\/(install|uninstall)$/,
      );
      if (request.method === "POST" && certificateMatch) {
        await readJsonBody(request);
        const configuration = await loadAppConfig(resolvedConfigDir);
        if (!configuration.wechatAdvancedEnabled) {
          throw new HttpError(
            409,
            "请先显式启用微信高级模式。",
            "WECHAT_ADVANCED_MODE_DISABLED",
          );
        }
        await mediaJobs.sidecar.stop();
        sendJson(response, 200, {
          certificate: await certificateManager(resolvedConfigDir, certificateMatch[1]),
        });
        return;
      }

      if (request.method === "GET" && requestPath === "/api/media/jobs") {
        sendJson(response, 200, { jobs: await mediaJobs.list(100) });
        return;
      }

      if (request.method === "POST" && requestPath === "/api/media/jobs") {
        await configuredInbox(resolvedConfigDir);
        const payload = await readJsonBody(request);
        const job = await mediaJobs.create({
          fileName: payload.fileName,
          keepMedia: payload.keepMedia,
          note: payload.note,
          providedTitle: payload.providedTitle,
          resolverMode: payload.resolverMode,
          sourceType: payload.sourceType,
          url: payload.url,
        });
        sendJson(response, 202, { job });
        return;
      }

      if (request.method === "POST" && requestPath === "/api/intakes") {
        await configuredInbox(resolvedConfigDir);
        const payload = validateIntakePayload(await readJsonBody(request));
        const canonicalUrl = normalizeVideoUrl(payload.url);
        const platform = detectPlatform(canonicalUrl);

        if (platform.id === "wechat-channels") {
          const configuration = await loadAppConfig(resolvedConfigDir);
          if (!configuration.wechatAdvancedEnabled) {
            throw new HttpError(
              409,
              "微信视频号首次使用需要完成一次本地授权设置。",
              "WECHAT_SETUP_REQUIRED",
            );
          }
          const yuanbao = await mediaJobs.yuanbaoResolver.session.status();
          if (!yuanbao.configured) {
            throw new HttpError(
              409,
              "微信视频号首次使用需要登录腾讯元宝。",
              "YUANBAO_LOGIN_REQUIRED",
            );
          }
          const job = await mediaJobs.create({
            keepMedia: payload.keepMedia,
            resolverMode: "yuanbao-local",
            sourceType: "wechat",
            url: canonicalUrl,
          });
          sendJson(response, 202, { intake: { kind: "media-job", platform }, job });
          return;
        }

        if (canAutoDownloadPlatform(platform.id)) {
          const job = await mediaJobs.create({
            keepMedia: payload.keepMedia,
            sourceType: "public-url",
            url: canonicalUrl,
          });
          sendJson(response, 202, { intake: { kind: "media-job", platform }, job });
          return;
        }

        const inboxDir = await configuredInbox(resolvedConfigDir);
        const result = await captureVideo({
          contentExtractor,
          createInbox: false,
          inboxDir,
          stateDir,
          url: canonicalUrl,
        });
        sendJson(response, result.status === "created" ? 201 : 200, {
          capture: captureResult(result),
          intake: { kind: "link-note", platform },
        });
        return;
      }

      const mediaJobMatch = requestPath.match(/^\/api\/media\/jobs\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && mediaJobMatch) {
        sendJson(response, 200, { job: await mediaJobs.get(mediaJobMatch[1]) });
        return;
      }

      const uploadMatch = requestPath.match(/^\/api\/media\/jobs\/([0-9a-f-]+)\/source$/i);
      if (request.method === "PUT" && uploadMatch) {
        const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
        if (!contentType.startsWith("application/octet-stream")) {
          throw new HttpError(415, "媒体上传必须使用 application/octet-stream。", "MEDIA_BINARY_REQUIRED");
        }
        const contentLength = Number(request.headers["content-length"] ?? Number.NaN);
        const job = await mediaJobs.acceptUpload(uploadMatch[1], request, { contentLength });
        sendJson(response, 202, { job });
        return;
      }

      const mediaRetryMatch = requestPath.match(/^\/api\/media\/jobs\/([0-9a-f-]+)\/retry$/i);
      if (request.method === "POST" && mediaRetryMatch) {
        await readJsonBody(request);
        sendJson(response, 202, { job: await mediaJobs.retry(mediaRetryMatch[1]) });
        return;
      }

      const mediaCleanupMatch = requestPath.match(/^\/api\/media\/jobs\/([0-9a-f-]+)\/cleanup$/i);
      if (request.method === "POST" && mediaCleanupMatch) {
        await readJsonBody(request);
        sendJson(response, 200, { job: await mediaJobs.cleanup(mediaCleanupMatch[1]) });
        return;
      }

      if (request.method === "GET" && requestPath === "/api/failures") {
        const failures = await listFailureRecords({ stateDir, limit: 100 });
        sendJson(response, 200, {
          failures: failures.map(publicFailureRecord),
          pendingCount: failures.filter((record) => record.resolution === "pending").length,
        });
        return;
      }

      if (request.method === "POST" && requestPath === "/api/captures") {
        const inboxDir = await configuredInbox(resolvedConfigDir);
        const payload = validateCapturePayload(await readJsonBody(request));
        const result = await captureVideo({
          contentExtractor,
          createInbox: false,
          inboxDir,
          note: payload.note,
          providedTitle: payload.providedTitle,
          stateDir,
          transcript: payload.transcript,
          url: payload.url,
        });
        sendJson(response, result.status === "created" ? 201 : 200, {
          capture: captureResult(result),
        });
        return;
      }

      const retryMatch = request.method === "POST"
        ? requestPath.match(/^\/api\/failures\/([0-9a-f-]+)\/retry$/i)
        : null;
      if (retryMatch) {
        const inboxDir = await configuredInbox(resolvedConfigDir);
        const result = await retryFailure({
          contentExtractor,
          createInbox: false,
          failureId: retryMatch[1],
          inboxDir,
          stateDir,
        });
        sendJson(response, 200, { capture: captureResult(result) });
        return;
      }

      throw new HttpError(404, "接口不存在。", "NOT_FOUND");
    } catch (error) {
      const { status, payload } = errorResponse(error);
      if (status >= 500) {
        logger.error?.("local-server-error", error);
      }
      if (!response.headersSent) {
        sendJson(response, status, payload);
      } else {
        response.end();
      }
    }
  });
  server.once("close", () => {
    mediaJobs.sidecar?.stop?.().catch?.(() => {});
    mediaJobs.yuanbaoResolver?.session?.close?.().catch?.(() => {});
  });
  return server;
}

function parseArguments(args) {
  const options = {
    configDir: resolveDefaultConfigDir(),
    openBrowser: false,
    port: DEFAULT_PORT,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--open") {
      options.openBrowser = true;
      continue;
    }
    if (argument === "--port" || argument === "--config-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`参数 ${argument} 缺少值。`);
      }
      if (argument === "--port") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error("端口必须是 0 到 65535 之间的整数。");
        }
        options.port = port;
      } else {
        options.configDir = path.resolve(value);
      }
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return options;
}

export function openDefaultBrowser(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = process.env.ComSpec || "cmd.exe";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", () => {});
  child.unref();
}

export function openLocalDirectory(directoryPath) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = "explorer.exe";
    args = [directoryPath];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [directoryPath];
  } else {
    command = "xdg-open";
    args = [directoryPath];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function startLocalApp({
  certificateManager = manageWechatCertificate,
  configDir = resolveDefaultConfigDir(),
  contentExtractor = extractPublicMetadata,
  directoryOpener = openLocalDirectory,
  mediaJobService = null,
  openBrowser = false,
  port = DEFAULT_PORT,
  logger = console,
} = {}) {
  const resolvedMediaJobService = mediaJobService ?? new MediaJobService(configDir, {
    contentExtractor,
  });
  await resolvedMediaJobService.ready;
  const server = createLocalServer({
    configDir,
    certificateManager,
    contentExtractor,
    directoryOpener,
    logger,
    mediaJobService: resolvedMediaJobService,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}`;
  logger.log?.(`视频知识捕手已启动：${url}`);
  logger.log?.(`本地配置目录：${path.resolve(configDir)}`);
  logger.log?.("按 Ctrl+C 停止。仅监听 127.0.0.1。\n");
  if (openBrowser) {
    openDefaultBrowser(url);
  }
  return { server, url };
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }

  if (options) {
    startLocalApp(options)
      .then(({ server }) => {
        const stop = () => server.close(() => process.exit(0));
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      })
      .catch((error) => {
        const message = error?.code === "EADDRINUSE"
          ? `端口 ${options.port} 已被占用，视频知识捕手可能已经在运行。`
          : `启动失败：${error.message}`;
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      });
  }
}
