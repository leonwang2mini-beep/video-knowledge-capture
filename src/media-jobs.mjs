import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  loadAppConfig,
  resolveStateDir,
  resolveWorkDir,
} from "./app-config.mjs";
import { captureVideo, normalizeVideoUrl } from "./core.mjs";
import { detectPlatform } from "./platforms.mjs";
import {
  canAutoDownloadPlatform,
  downloadPublicMedia,
} from "./public-media-downloader.mjs";
import { assertRuntimeReady } from "./runtime-manager.mjs";
import { transcribeMedia } from "./transcriber.mjs";
import { WechatSidecar } from "./wechat-sidecar.mjs";
import { YuanbaoResolver } from "./yuanbao-resolver.mjs";

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const COPYFILE_EXCL = 1;
const ALLOWED_MEDIA_EXTENSIONS = new Set([
  ".aac", ".flac", ".m4a", ".mkv", ".mov", ".mp3", ".mp4", ".ogg", ".wav", ".webm",
]);

export class MediaJobError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "MediaJobError";
    this.code = code;
    this.stage = options.stage ?? "media-job";
    this.retryable = options.retryable ?? false;
  }
}

function jobError(message, code, stage, cause, retryable = false) {
  return new MediaJobError(message, code, { cause, retryable, stage });
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, maximum, label) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw jobError(`${label}必须是文本。`, "MEDIA_JOB_INPUT_INVALID", "validate-job");
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length > maximum) {
    throw jobError(`${label}最多 ${maximum} 个字符。`, "MEDIA_JOB_INPUT_TOO_LONG", "validate-job");
  }
  return normalized;
}

function safeFileName(value) {
  const base = path.basename(String(value || "media"));
  const extension = path.extname(base).toLowerCase();
  if (!ALLOWED_MEDIA_EXTENSIONS.has(extension)) {
    throw jobError(
      "请选择常见的视频或音频文件。",
      "MEDIA_FILE_TYPE_UNSUPPORTED",
      "upload-media",
    );
  }
  return `source${extension}`;
}

function insideRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryPath, filePath);
}

async function hashMediaFile(filePath) {
  const metadata = await stat(filePath);
  if (!metadata.isFile()) {
    throw new Error("media path is not a file");
  }
  const hash = createHash("sha256");
  const handle = await open(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), size };
}

function serializeError(error) {
  const serialized = {
    code: String(error?.code ?? "MEDIA_JOB_FAILED").slice(0, 100),
    message: String(error?.message ?? "媒体任务失败。").slice(0, 1000),
    retryable: error?.retryable !== false,
    stage: String(error?.stage ?? "media-job").slice(0, 100),
  };
  if (error?.details && typeof error.details === "object") {
    const details = {};
    for (const key of [
      "failureCategory",
      "formatId",
      "profile",
      "resolution",
    ]) {
      const value = error.details[key];
      if (typeof value === "string" && value.trim()) details[key] = value.slice(0, 200);
    }
    for (const key of ["attempt", "attempts", "estimatedSize", "exitCode"]) {
      const value = error.details[key];
      if (Number.isFinite(value) && value >= 0) details[key] = value;
    }
    if (typeof error.details.fallbackAttempted === "boolean") {
      details.fallbackAttempted = error.details.fallbackAttempted;
    }
    if (Object.keys(details).length) serialized.details = details;
  }
  return serialized;
}

function publicJob(job) {
  return {
    cleanedAt: job.cleanedAt ?? null,
    createdAt: job.createdAt,
    error: job.error ?? null,
    fileName: job.request.fileName ?? null,
    jobId: job.jobId,
    keepMedia: job.request.keepMedia === true,
    note: job.request.note,
    progress: job.progress ?? null,
    providedTitle: job.request.providedTitle,
    resolverMode: job.request.resolverMode ?? null,
    result: job.result ?? null,
    retainedMediaPath: job.retainedMedia?.path ?? job.result?.retainedMediaPath ?? null,
    retryable: job.retryable ?? false,
    sourceType: job.sourceType,
    sourceMetadata: job.sourceMetadata ?? null,
    sourceUrl: job.request.url,
    stage: job.stage,
    status: job.status,
    updatedAt: job.updatedAt,
    workRetained: job.workRetained === true,
  };
}

export class MediaJobService {
  constructor(configDir, {
    capture = captureVideo,
    contentExtractor,
    runtimeResolver = assertRuntimeReady,
    sidecar,
    transcriber = transcribeMedia,
    publicDownloader = downloadPublicMedia,
    yuanbaoResolver,
  } = {}) {
    this.configDir = path.resolve(configDir);
    this.stateDir = resolveStateDir(this.configDir);
    this.jobsDir = path.join(this.stateDir, "media-jobs");
    this.workRoot = resolveWorkDir(this.configDir);
    this.defaultRetainedMediaRoot = path.join(this.configDir, "retained-media");
    this.jobs = new Map();
    this.capture = capture;
    this.contentExtractor = contentExtractor;
    this.runtimeResolver = runtimeResolver;
    this.sidecar = sidecar ?? new WechatSidecar(this.configDir);
    this.transcriber = transcriber;
    this.publicDownloader = publicDownloader;
    this.yuanbaoResolver = yuanbaoResolver ?? new YuanbaoResolver(this.configDir);
    this.ready = this.initialize();
  }

  async initialize() {
    await Promise.all([
      mkdir(this.jobsDir, { recursive: true }),
      mkdir(path.join(this.workRoot, "jobs"), { recursive: true }),
    ]);
    const entries = await readdir(this.jobsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await readFile(path.join(this.jobsDir, entry.name), "utf8"));
        if (!job?.jobId) continue;
        if (["queued", "running", "uploading"].includes(job.status)) {
          job.status = "failed";
          job.stage = "interrupted";
          job.error = {
            code: "MEDIA_JOB_INTERRUPTED",
            message: "应用在任务完成前退出，可安全重试。",
            retryable: true,
            stage: "interrupted",
          };
          job.retryable = true;
          job.workRetained = true;
          job.updatedAt = nowIso();
          await atomicWriteJson(this.jobPath(job.jobId), job);
        }
        this.jobs.set(job.jobId, job);
      } catch {
        // A damaged single job must not prevent the local app from starting.
      }
    }
  }

  jobPath(jobId) {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  async persist(job) {
    job.updatedAt = nowIso();
    this.jobs.set(job.jobId, job);
    await atomicWriteJson(this.jobPath(job.jobId), job);
  }

  async get(jobId) {
    await this.ready;
    const job = this.jobs.get(jobId);
    if (!job) throw jobError("媒体任务不存在。", "MEDIA_JOB_NOT_FOUND", "read-job");
    return publicJob(job);
  }

  async list(limit = 50) {
    await this.ready;
    const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
    return [...this.jobs.values()]
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, safeLimit)
      .map(publicJob);
  }

  async create({
    fileName = "",
    keepMedia = false,
    note = "",
    providedTitle = "",
    resolverMode = "desktop",
    sourceType,
    url,
  }) {
    await this.ready;
    if (!["local-upload", "public-url", "wechat"].includes(sourceType)) {
      throw jobError("媒体任务类型无效。", "MEDIA_JOB_TYPE_INVALID", "validate-job");
    }
    if (typeof keepMedia !== "boolean") {
      throw jobError(
        "成功后保留媒体选项必须是布尔值。",
        "MEDIA_KEEP_OPTION_INVALID",
        "validate-job",
      );
    }
    const canonicalUrl = normalizeVideoUrl(url);
    const platform = detectPlatform(canonicalUrl);
    if (sourceType === "wechat" && detectPlatform(canonicalUrl).id !== "wechat-channels") {
      throw jobError(
        "微信高级模式只接受微信视频号分享链接。",
        "WECHAT_URL_REQUIRED",
        "validate-job",
      );
    }
    if (sourceType === "public-url" && !canAutoDownloadPlatform(platform.id)) {
      throw jobError(
        "该页面暂不支持自动下载。",
        "PUBLIC_MEDIA_PLATFORM_UNSUPPORTED",
        "validate-job",
      );
    }
    if (
      sourceType === "wechat"
      && !["desktop", "yuanbao-local"].includes(resolverMode)
    ) {
      throw jobError(
        "微信视频解析方式无效。",
        "WECHAT_RESOLVER_INVALID",
        "validate-job",
      );
    }
    if (
      sourceType === "wechat"
      && [...this.jobs.values()].some((job) => (
        job.sourceType === "wechat"
        && ["queued", "running", "uploading"].includes(job.status)
      ))
    ) {
      throw jobError(
        "一次只能处理一个微信视频号任务。",
        "WECHAT_JOB_ALREADY_ACTIVE",
        "validate-job",
        null,
        true,
      );
    }
    const normalizedFileName = sourceType === "local-upload" ? safeFileName(fileName) : null;
    const jobId = randomUUID();
    const workDir = path.join(this.workRoot, "jobs", jobId);
    await mkdir(workDir, { recursive: true });
    const job = {
      schemaVersion: 1,
      artifacts: {},
      createdAt: nowIso(),
      error: null,
      jobId,
      progress: null,
      request: {
        fileName: normalizedFileName,
        keepMedia,
        note: normalizeText(note, 10000, "备注"),
        providedTitle: normalizeText(providedTitle, 300, "标题"),
        resolverMode: sourceType === "wechat" ? resolverMode : null,
        url: canonicalUrl,
      },
      result: null,
      retryable: false,
      sourceType,
      stage: sourceType === "local-upload" ? "awaiting-upload" : "queued",
      status: sourceType === "local-upload" ? "awaiting-upload" : "queued",
      updatedAt: nowIso(),
      workDir,
      workRetained: false,
    };
    await this.persist(job);
    if (["public-url", "wechat"].includes(sourceType)) this.schedule(jobId);
    return publicJob(job);
  }

  async acceptUpload(jobId, readable, { contentLength } = {}) {
    await this.ready;
    const job = this.jobs.get(jobId);
    if (!job) throw jobError("媒体任务不存在。", "MEDIA_JOB_NOT_FOUND", "upload-media");
    if (job.sourceType !== "local-upload" || job.status !== "awaiting-upload") {
      throw jobError("该任务当前不能接收文件。", "MEDIA_UPLOAD_STATE_INVALID", "upload-media");
    }
    if (Number.isFinite(contentLength) && (contentLength <= 0 || contentLength > MAX_UPLOAD_BYTES)) {
      throw jobError("媒体文件为空或超过 4 GiB 限制。", "MEDIA_SIZE_INVALID", "upload-media");
    }
    job.status = "uploading";
    job.stage = "upload-media";
    await this.persist(job);
    const sourcePath = path.join(job.workDir, job.request.fileName);
    const hash = createHash("sha256");
    let size = 0;
    let handle;
    try {
      handle = await open(sourcePath, "wx");
      for await (const chunk of readable) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_UPLOAD_BYTES) {
          throw jobError("媒体文件超过 4 GiB 限制。", "MEDIA_SIZE_INVALID", "upload-media");
        }
        hash.update(buffer);
        await handle.write(buffer);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (size === 0) {
        throw jobError("媒体文件为空。", "MEDIA_SIZE_INVALID", "upload-media");
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(sourcePath).catch(() => {});
      job.status = "failed";
      job.stage = "upload-media";
      job.error = serializeError(error);
      job.retryable = false;
      job.workRetained = true;
      await this.persist(job);
      throw error;
    }
    job.artifacts.mediaPath = sourcePath;
    job.artifacts.mediaSha256 = hash.digest("hex");
    job.artifacts.mediaSize = size;
    job.status = "queued";
    job.stage = "queued";
    await this.persist(job);
    this.schedule(jobId);
    return publicJob(job);
  }

  schedule(jobId) {
    queueMicrotask(() => {
      this.process(jobId).catch(() => {});
    });
  }

  async update(job, values) {
    Object.assign(job, values);
    await this.persist(job);
  }

  async process(jobId) {
    await this.ready;
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "queued") return;
    await this.update(job, {
      error: null,
      progress: null,
      retryable: false,
      stage: "prepare-media",
      status: "running",
      workRetained: false,
    });

    let mediaPath = job.artifacts.mediaPath ?? null;
    let sourceMetadata = job.sourceMetadata ?? null;
    let runtime = null;
    try {
      const config = await loadAppConfig(this.configDir);
      if (!config.inboxDir) {
        throw jobError("请先配置 Obsidian Inbox。", "CONFIG_REQUIRED", "prepare-media");
      }
      if (job.sourceType === "wechat") {
        if (!config.wechatAdvancedEnabled) {
          throw jobError(
            "微信高级模式尚未启用。",
            "WECHAT_ADVANCED_MODE_DISABLED",
            "prepare-media",
          );
        }
        if (!mediaPath) {
          const resolverMode = job.request.resolverMode ?? "desktop";
          let resolvedProfile = null;
          if (resolverMode === "yuanbao-local") {
            await this.update(job, { stage: "resolve-yuanbao" });
            resolvedProfile = await this.yuanbaoResolver.resolveVideo(job.request.url);
            await this.sidecar.start();
          }
          await this.update(job, { stage: "download-wechat" });
          const downloadOptions = {
            onProgress: (progress) => {
              job.progress = {
                downloaded: Number(progress?.currentTask?.downloaded ?? 0),
                percentage: Number(progress?.currentTask?.progress ?? 0),
                total: Number(progress?.currentTask?.total ?? 0),
              };
            },
          };
          sourceMetadata = resolvedProfile
            ? await this.sidecar.downloadResolvedProfile(resolvedProfile, downloadOptions)
            : await this.sidecar.download(job.request.url, downloadOptions);
          sourceMetadata = {
            ...sourceMetadata,
            strategy: resolverMode === "yuanbao-local"
              ? "wechat-yuanbao-local"
              : "wechat-local-sidecar",
          };
          mediaPath = sourceMetadata.mediaPath;
          job.sourceMetadata = {
            author: sourceMetadata.author,
            strategy: sourceMetadata.strategy,
            title: sourceMetadata.title,
            videoId: sourceMetadata.videoId,
          };
          job.artifacts.mediaPath = mediaPath;
          job.artifacts.videoId = sourceMetadata.videoId;
          await this.persist(job);
        }
      }

      if (job.sourceType === "public-url" && !mediaPath) {
        runtime = await this.runtimeResolver(this.configDir, [
          "ytDlp",
          "ffmpeg",
          "whisper",
          "whisperModel",
        ]);
        await this.update(job, { stage: "download-public" });
        const platform = detectPlatform(job.request.url);
        sourceMetadata = await this.publicDownloader({
          ffmpegPath: runtime.components.ffmpeg.path,
          keepMedia: job.request.keepMedia === true,
          platformId: platform.id,
          url: job.request.url,
          workDir: job.workDir,
          ytDlpPath: runtime.components.ytDlp.path,
        });
        mediaPath = sourceMetadata.mediaPath;
        job.sourceMetadata = {
          author: sourceMetadata.author,
          downloadAttempt: sourceMetadata.downloadAttempt ?? null,
          downloadProfile: sourceMetadata.downloadProfile ?? null,
          estimatedSize: sourceMetadata.estimatedSize ?? null,
          formatId: sourceMetadata.formatId ?? null,
          resolution: sourceMetadata.resolution ?? null,
          strategy: sourceMetadata.strategy,
          title: sourceMetadata.title,
          videoId: sourceMetadata.videoId,
        };
        job.artifacts.mediaPath = mediaPath;
        job.artifacts.videoId = sourceMetadata.videoId;
        await this.persist(job);
      }

      runtime ??= await this.runtimeResolver(this.configDir, [
          "ffmpeg",
          "whisper",
          "whisperModel",
        ]);
      await this.update(job, { stage: "extract-audio" });
      const transcription = await this.transcriber({
        ffmpegPath: runtime.components.ffmpeg.path,
        inputPath: mediaPath,
        language: "auto",
        modelName: runtime.components.whisperModel.version,
        modelPath: runtime.components.whisperModel.path,
        whisperPath: runtime.components.whisper.path,
        workDir: job.workDir,
      });
      job.artifacts.audioPath = transcription.artifacts.audioPath;
      job.artifacts.srtPath = transcription.artifacts.srtPath;
      job.artifacts.jsonPath = transcription.artifacts.jsonPath;
      await this.update(job, { stage: "write-note" });

      const contentExtractor = sourceMetadata
        ? async () => ({
            author: sourceMetadata.author,
            status: "extracted",
            strategy: sourceMetadata.strategy ?? (
              job.sourceType === "public-url" ? "yt-dlp-public" : "wechat-local-sidecar"
            ),
            title: sourceMetadata.title,
          })
        : this.contentExtractor;
      const result = await this.capture({
        contentExtractor,
        createInbox: false,
        inboxDir: config.inboxDir,
        material: {
          durationSeconds: transcription.durationSeconds,
          language: transcription.language,
          model: transcription.model,
          segments: transcription.segments,
          source: job.sourceType === "wechat"
            ? "wechat-local-asr"
            : job.sourceType === "public-url"
              ? "public-url-asr"
              : "local-asr",
        },
        note: job.request.note,
        providedTitle: job.request.providedTitle,
        stateDir: this.stateDir,
        transcript: transcription.transcript,
        url: job.request.url,
      });

      let retainedMedia = job.retainedMedia ?? null;
      if (job.request.keepMedia === true) {
        await this.update(job, { stage: "retain-media" });
        retainedMedia = await this.retainMedia(job, mediaPath, result.captureId);
      }

      await this.update(job, { stage: "cleanup" });
      await this.cleanupArtifacts(job);
      if (job.sourceType === "wechat") {
        await this.sidecar.stop();
        await this.sidecar.purgeManagedArtifacts?.();
      }
      job.result = {
        captureId: result.captureId,
        captureStatus: result.status,
        materialSource: result.material.source,
        notePath: result.notePath,
        retainedMediaPath: retainedMedia?.path ?? null,
        retainedMediaSha256: retainedMedia?.sha256 ?? null,
        retainedMediaSize: retainedMedia?.size ?? 0,
        segmentCount: result.material.segmentCount,
        transcriptCharCount: result.material.transcriptCharCount,
      };
      job.status = "completed";
      job.stage = "completed";
      job.retryable = false;
      job.workRetained = false;
      await this.persist(job);
    } catch (error) {
      job.status = "failed";
      job.error = serializeError(error);
      job.stage = job.error.stage;
      job.retryable = job.error.retryable;
      job.workRetained = true;
      await this.persist(job);
      throw error;
    }
  }

  async cleanupArtifacts(job) {
    const candidates = new Set([
      job.workDir,
      job.artifacts.mediaPath,
    ]);
    for (const candidate of candidates) {
      if (!candidate || !insideRoot(this.workRoot, candidate)) continue;
      await rm(candidate, { recursive: true, force: true });
    }
    job.cleanedAt = nowIso();
    job.artifacts = {};
  }

  async retainMedia(job, mediaPath, captureId) {
    if (!mediaPath || !insideRoot(this.workRoot, mediaPath)) {
      throw jobError(
        "待保留媒体不在本应用受管工作目录中。",
        "MEDIA_RETAIN_SOURCE_OUTSIDE_WORKDIR",
        "retain-media",
      );
    }
    if (!/^[a-f0-9]{64}$/.test(String(captureId ?? ""))) {
      throw jobError(
        "媒体对应的采集标识无效。",
        "MEDIA_RETAIN_CAPTURE_ID_INVALID",
        "retain-media",
      );
    }
    const extension = path.extname(mediaPath).toLowerCase();
    if (!ALLOWED_MEDIA_EXTENSIONS.has(extension)) {
      throw jobError(
        "下载媒体的文件类型不能安全保留。",
        "MEDIA_RETAIN_TYPE_UNSUPPORTED",
        "retain-media",
      );
    }
    const source = await hashMediaFile(mediaPath);
    if (source.size <= 0) {
      throw jobError(
        "下载媒体为空，不能保留。",
        "MEDIA_RETAIN_SOURCE_INVALID",
        "retain-media",
      );
    }
    const config = await loadAppConfig(this.configDir);
    const retainedMediaRoot = path.resolve(
      config.retainedMediaDir ?? this.defaultRetainedMediaRoot,
    );
    if (
      retainedMediaRoot === this.workRoot
      || insideRoot(this.workRoot, retainedMediaRoot)
    ) {
      throw jobError(
        "视频保留目录不能位于任务临时工作区中。",
        "MEDIA_RETAIN_PATH_INVALID",
        "retain-media",
        null,
        false,
      );
    }
    const retainDir = path.join(retainedMediaRoot, String(captureId));
    const retainedPath = path.join(retainDir, `${source.sha256}${extension}`);
    if (!insideRoot(retainedMediaRoot, retainedPath)) {
      throw jobError(
        "媒体保留路径越界。",
        "MEDIA_RETAIN_PATH_INVALID",
        "retain-media",
      );
    }
    await mkdir(retainDir, { recursive: true });
    const temporaryPath = path.join(
      retainDir,
      `.${job.jobId}-${randomUUID()}.tmp`,
    );
    try {
      await copyFile(mediaPath, temporaryPath, COPYFILE_EXCL);
      const copied = await hashMediaFile(temporaryPath);
      if (copied.sha256 !== source.sha256 || copied.size !== source.size) {
        throw jobError(
          "媒体副本校验失败，原临时媒体已保留以便安全重试。",
          "MEDIA_RETAIN_COPY_MISMATCH",
          "retain-media",
          null,
          true,
        );
      }
      try {
        await link(temporaryPath, retainedPath);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await hashMediaFile(retainedPath);
        if (existing.sha256 !== source.sha256 || existing.size !== source.size) {
          throw jobError(
            "保留目录中存在同名但内容不一致的媒体，已拒绝覆盖。",
            "MEDIA_RETAIN_CONFLICT",
            "retain-media",
            error,
            false,
          );
        }
      }
    } catch (error) {
      if (error instanceof MediaJobError) throw error;
      throw jobError(
        "无法把媒体保存到受管保留目录。",
        "MEDIA_RETAIN_FAILED",
        "retain-media",
        error,
        true,
      );
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
    job.retainedMedia = {
      path: retainedPath,
      retainedAt: nowIso(),
      sha256: source.sha256,
      size: source.size,
    };
    await this.persist(job);
    return job.retainedMedia;
  }

  async retry(jobId) {
    await this.ready;
    const job = this.jobs.get(jobId);
    if (!job) throw jobError("媒体任务不存在。", "MEDIA_JOB_NOT_FOUND", "retry-media");
    if (job.status !== "failed" || !job.retryable) {
      throw jobError("该媒体任务当前不可重试。", "MEDIA_JOB_NOT_RETRYABLE", "retry-media");
    }
    job.request.url = normalizeVideoUrl(job.request.url);
    if (job.sourceType === "local-upload") {
      const mediaPath = job.artifacts.mediaPath;
      try {
        const metadata = await stat(mediaPath);
        if (!metadata.isFile()) throw new Error("not a file");
      } catch {
        throw jobError(
          "原媒体文件已不存在，请重新创建上传任务。",
          "MEDIA_SOURCE_MISSING",
          "retry-media",
        );
      }
    }
    job.status = "queued";
    job.stage = "queued";
    job.error = null;
    job.retryable = false;
    await this.persist(job);
    this.schedule(jobId);
    return publicJob(job);
  }

  async cleanup(jobId) {
    await this.ready;
    const job = this.jobs.get(jobId);
    if (!job) throw jobError("媒体任务不存在。", "MEDIA_JOB_NOT_FOUND", "cleanup-media");
    if (!["failed", "completed"].includes(job.status)) {
      throw jobError("运行中的任务不能清理。", "MEDIA_JOB_CLEANUP_STATE_INVALID", "cleanup-media");
    }
    await this.cleanupArtifacts(job);
    if (job.sourceType === "wechat") {
      await this.sidecar.stop();
      await this.sidecar.purgeManagedArtifacts?.();
    }
    job.status = job.status === "failed" ? "cleaned" : job.status;
    job.stage = job.status === "cleaned" ? "cleaned" : job.stage;
    job.retryable = false;
    job.workRetained = false;
    await this.persist(job);
    return publicJob(job);
  }
}
