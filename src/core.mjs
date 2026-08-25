import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { detectPlatform } from "./platforms.mjs";

const FAILURE_LEDGER = "failures.jsonl";
const RETRY_LEDGER = "retry-events.jsonl";
const MATERIAL_START = "<!-- video-knowledge-capture:material:start -->";
const MATERIAL_END = "<!-- video-knowledge-capture:material:end -->";
const MAX_PROVIDED_TITLE_LENGTH = 300;
const MAX_MANUAL_TRANSCRIPT_LENGTH = 40000;
const MAX_AUTOMATIC_TRANSCRIPT_LENGTH = 500000;
const MAX_TRANSCRIPT_SEGMENTS = 10000;
const DOUYIN_VIDEO_ID_PATTERN = /^\d{10,30}$/;
const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "from",
  "gclid",
  "modal_id",
  "share_source",
  "source",
  "spm",
]);

class NoteAlreadyExistsError extends Error {}

export class CaptureError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "CaptureError";
    this.code = options.code ?? "CAPTURE_FAILED";
    this.stage = options.stage ?? "capture";
    this.retryable = options.retryable ?? false;
    this.failureId = options.failureId ?? null;
  }
}

function validationError(message, code) {
  return new CaptureError(message, {
    code,
    stage: "validate",
    retryable: false,
  });
}

function normalizeNote(note) {
  if (note === undefined || note === null) {
    return "";
  }
  if (typeof note !== "string") {
    throw validationError("备注必须是字符串。", "INVALID_NOTE");
  }
  return note.trim();
}

function normalizeProvidedTitle(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw validationError("视频标题必须是字符串。", "INVALID_PROVIDED_TITLE");
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length > MAX_PROVIDED_TITLE_LENGTH) {
    throw validationError(
      `视频标题最多 ${MAX_PROVIDED_TITLE_LENGTH} 个字符。`,
      "PROVIDED_TITLE_TOO_LONG",
    );
  }
  return normalized;
}

function normalizeTranscript(value, maxLength = MAX_MANUAL_TRANSCRIPT_LENGTH) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw validationError("视频文案或字幕必须是字符串。", "INVALID_TRANSCRIPT");
  }
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length > maxLength) {
    throw validationError(
      `视频文案或字幕最多 ${maxLength} 个字符。`,
      "TRANSCRIPT_TOO_LONG",
    );
  }
  return normalized;
}

function normalizeMaterial(value, transcript) {
  if (value === undefined || value === null) {
    return {
      durationSeconds: null,
      language: null,
      model: null,
      segments: [],
      source: transcript ? "user-pasted" : "none",
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("视频内容来源信息无效。", "INVALID_MATERIAL");
  }
  const allowedSources = new Set([
    "local-asr",
    "public-url-asr",
    "wechat-local-asr",
    "user-pasted",
    "none",
  ]);
  if (!allowedSources.has(value.source)) {
    throw validationError("自动内容来源无效。", "INVALID_MATERIAL_SOURCE");
  }
  const rawSegments = value.segments ?? [];
  if (!Array.isArray(rawSegments) || rawSegments.length > MAX_TRANSCRIPT_SEGMENTS) {
    throw validationError("字幕时间段数量无效。", "INVALID_MATERIAL_SEGMENTS");
  }
  const segments = rawSegments.map((segment) => {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const text = String(segment?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || !text) {
      throw validationError("字幕时间段格式无效。", "INVALID_MATERIAL_SEGMENTS");
    }
    return { start, end, text };
  });
  const durationSeconds = Number(value.durationSeconds);
  return {
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds >= 0
      ? durationSeconds
      : (segments.at(-1)?.end ?? null),
    language: normalizeContentText(value.language, 40),
    model: normalizeContentText(value.model, 100),
    segments,
    source: value.source,
  };
}

function redactUrlCredentials(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = "redacted";
    }
    return url.toString();
  } catch {
    return String(rawUrl ?? "");
  }
}

function normalizePlatformSpecificUrl(url) {
  if (
    detectPlatform(url).id !== "douyin"
    || /^\/video\/\d+\/?$/i.test(url.pathname)
  ) {
    return url;
  }
  const modalId = url.searchParams.get("modal_id")?.trim() ?? "";
  if (!DOUYIN_VIDEO_ID_PATTERN.test(modalId)) {
    return url;
  }
  return new URL(`https://www.douyin.com/video/${modalId}`);
}

export function normalizeVideoUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw validationError("必须提供公开视频链接。", "INVALID_URL");
  }

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw validationError("公开视频链接不是有效 URL。", "INVALID_URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw validationError("只接受 http/https 公共链接。", "UNSUPPORTED_PROTOCOL");
  }
  if (url.username || url.password) {
    throw validationError("公开视频链接不得包含用户名或密码。", "URL_CREDENTIALS_NOT_ALLOWED");
  }

  url = normalizePlatformSpecificUrl(url);
  url.hash = "";
  const keptParameters = [];
  for (const [key, value] of url.searchParams) {
    const normalizedKey = key.toLowerCase();
    if (!normalizedKey.startsWith("utm_") && !TRACKING_PARAMETERS.has(normalizedKey)) {
      keptParameters.push([key, value]);
    }
  }
  keptParameters.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    return leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue);
  });
  url.search = "";
  for (const [key, value] of keptParameters) {
    url.searchParams.append(key, value);
  }

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

export function createCaptureId(canonicalUrl) {
  return createHash("sha256").update(canonicalUrl, "utf8").digest("hex");
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function markdownUrl(value) {
  return String(value).replaceAll("<", "%3C").replaceAll(">", "%3E");
}

function normalizeContentText(value, maxLength) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function markdownText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function materialHash(transcript) {
  return createHash("sha256").update(transcript, "utf8").digest("hex");
}

function renderTranscriptQuote(transcript) {
  return transcript
    .split("\n")
    .map((line) => `> ${markdownText(line)}`)
    .join("\n");
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return [hours, minutes, remaining].map((value) => String(value).padStart(2, "0")).join(":");
}

function selectTimelineSegments(segments, maximum = 12) {
  if (segments.length <= maximum) return segments;
  const selected = [];
  for (let index = 0; index < maximum; index += 1) {
    const candidateIndex = Math.round(index * (segments.length - 1) / (maximum - 1));
    selected.push(segments[candidateIndex]);
  }
  return selected.filter((segment, index, values) => index === 0 || segment !== values[index - 1]);
}

function selectTranscriptExcerpts(segments, maximum = 5) {
  const seen = new Set();
  return [...segments]
    .filter((segment) => {
      const key = segment.text.replace(/[\s，。！？、：；,.!?;:]/g, "").toLowerCase();
      if (key.length < 8 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.text.length - left.text.length)
    .slice(0, maximum)
    .sort((left, right) => left.start - right.start);
}

function renderMaterialSection(transcript, material = normalizeMaterial(null, transcript)) {
  const section = [
    MATERIAL_START,
    "## 视频内容",
    "",
  ];
  if (transcript) {
    const automatic = material.source === "local-asr"
      || material.source === "public-url-asr"
      || material.source === "wechat-local-asr";
    section.push(`- 内容来源：${automatic ? "本机 whisper.cpp 机器转写" : "用户粘贴的视频文案或字幕"}`);
    if (material.language) section.push(`- 识别语言：${markdownText(material.language)}`);
    if (material.model) section.push(`- 转写模型：${markdownText(material.model)}`);
    if (material.durationSeconds !== null) {
      section.push(`- 媒体时长：${formatTimestamp(material.durationSeconds)}`);
    }
    section.push(
      `- 字符数：${transcript.length}`,
      `<!-- video-knowledge-capture:material-sha256:${materialHash(transcript)} -->`,
    );
    if (automatic) {
      section.push(
        "",
        "> [!warning] 机器转写",
        "> 以下内容由本机语音识别生成，背景音乐、方言、专有名词或多人重叠说话可能造成错误。",
      );
    }
    if (material.segments.length > 0) {
      const excerpts = selectTranscriptExcerpts(material.segments);
      if (excerpts.length > 0) {
        section.push("", "### 内容摘录", "");
        for (const segment of excerpts) {
          section.push(`- \`${formatTimestamp(segment.start)}\` ${markdownText(segment.text)}`);
        }
      }
      section.push("", "### 时间线", "");
      for (const segment of selectTimelineSegments(material.segments)) {
        section.push(`- \`${formatTimestamp(segment.start)}\` ${markdownText(segment.text)}`);
      }
      section.push("", "### 完整字幕", "");
      for (const segment of material.segments) {
        section.push(`> [${formatTimestamp(segment.start)}] ${markdownText(segment.text)}`);
      }
    } else {
      section.push("", renderTranscriptQuote(transcript));
    }
  } else {
    section.push(
      "> [!warning] 当前仅保存了链接",
      "> 公开页面没有提供可用的视频文案。请用同一链接再次提交，并粘贴视频文案或字幕来增强这条笔记。",
    );
  }
  section.push(MATERIAL_END);
  return section.join("\n");
}

function normalizeContentUrl(value) {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(String(value));
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeContentCode(value, fallback) {
  const normalized = String(value ?? "").toUpperCase().replace(/[^A-Z0-9_-]/g, "_");
  return normalized.slice(0, 80) || fallback;
}

function normalizeContentResult(value = {}) {
  const title = normalizeContentText(value.title, 300);
  const author = normalizeContentText(value.author, 200);
  const description = normalizeContentText(value.description, 1200);
  const publishedAt = normalizeContentText(value.publishedAt, 100);
  const siteName = normalizeContentText(value.siteName, 200);
  const fields = [title, author, description, publishedAt].filter(Boolean);
  const strategy = normalizeContentText(value.strategy, 80) ?? "public-html";

  if (value.status === "extracted" && fields.length > 0) {
    return {
      author,
      canonicalUrl: normalizeContentUrl(value.canonicalUrl),
      description,
      errorCode: null,
      errorMessage: null,
      fieldCount: fields.length,
      publishedAt,
      resolvedUrl: normalizeContentUrl(value.resolvedUrl),
      siteName,
      status: "extracted",
      strategy,
      title,
    };
  }
  if (value.status === "unavailable") {
    return {
      author: null,
      canonicalUrl: null,
      description: null,
      errorCode: normalizeContentCode(value.errorCode, "CONTENT_UNAVAILABLE"),
      errorMessage: normalizeContentText(
        value.errorMessage,
        500,
      ) ?? "公开页面信息暂时不可用。",
      fieldCount: 0,
      publishedAt: null,
      resolvedUrl: normalizeContentUrl(value.resolvedUrl),
      siteName: null,
      status: "unavailable",
      strategy,
      title: null,
    };
  }
  return {
    author: null,
    canonicalUrl: null,
    description: null,
    errorCode: normalizeContentCode(value.errorCode, "EXTRACTION_NOT_ATTEMPTED"),
    errorMessage: normalizeContentText(value.errorMessage, 500),
    fieldCount: 0,
    publishedAt: null,
    resolvedUrl: null,
    siteName: null,
    status: "not-attempted",
    strategy,
    title: null,
  };
}

function contentFromExtractorError(error) {
  return normalizeContentResult({
    status: "unavailable",
    errorCode: error?.code ?? "CONTENT_EXTRACTOR_FAILED",
    errorMessage: "公开页面信息提取失败，链接已继续收录。",
  });
}

export function renderMarkdown({
  captureId,
  canonicalUrl,
  collectedAt,
  content: rawContent,
  note,
  platform,
  providedTitle = "",
  sourceUrl,
  transcript = "",
  material = normalizeMaterial(null, transcript),
}) {
  const content = normalizeContentResult(rawContent);
  const title = providedTitle || content.title || `视频收藏 · ${platform.label}`;
  const noteBody = note || "（无）";
  const frontmatter = [
    "---",
    `title: ${yamlString(title)}`,
    `capture_id: ${yamlString(captureId)}`,
    `source_platform: ${yamlString(platform.id)}`,
    `source_url: ${yamlString(sourceUrl)}`,
    `canonical_url: ${yamlString(canonicalUrl)}`,
    `collected_at: ${yamlString(collectedAt)}`,
    `content_status: ${yamlString(content.status)}`,
    `content_strategy: ${yamlString(content.strategy)}`,
    `material_status: ${yamlString(transcript ? "provided" : "missing")}`,
    `material_source: ${yamlString(material.source)}`,
    `material_char_count: ${transcript.length}`,
  ];
  if (material.language) {
    frontmatter.push(`material_language: ${yamlString(material.language)}`);
  }
  if (material.model) {
    frontmatter.push(`material_model: ${yamlString(material.model)}`);
  }
  if (material.durationSeconds !== null) {
    frontmatter.push(`media_duration_seconds: ${material.durationSeconds}`);
  }
  if (providedTitle) {
    frontmatter.push(`provided_title: ${yamlString(providedTitle)}`);
  }
  if (content.title) {
    frontmatter.push(`source_title: ${yamlString(content.title)}`);
  }
  if (content.author) {
    frontmatter.push(`source_author: ${yamlString(content.author)}`);
  }
  if (content.description) {
    frontmatter.push(`source_description: ${yamlString(content.description)}`);
  }
  if (content.siteName) {
    frontmatter.push(`source_site: ${yamlString(content.siteName)}`);
  }
  if (content.publishedAt) {
    frontmatter.push(`source_published_at: ${yamlString(content.publishedAt)}`);
  }
  if (content.resolvedUrl) {
    frontmatter.push(`resolved_url: ${yamlString(content.resolvedUrl)}`);
  }
  if (content.canonicalUrl) {
    frontmatter.push(`page_canonical_url: ${yamlString(content.canonicalUrl)}`);
  }
  if (content.errorCode) {
    frontmatter.push(`content_error_code: ${yamlString(content.errorCode)}`);
  }
  frontmatter.push(
    "tags:",
    `  - ${yamlString("video-capture")}`,
    `  - ${yamlString(`platform/${platform.id}`)}`,
    "---",
  );

  const contentSection = [
    "## 公开页面信息",
    "",
  ];
  if (content.status === "extracted") {
    contentSection.push("- 提取状态：已获取公开元数据");
    if (content.title) {
      contentSection.push(`- 标题：${markdownText(content.title)}`);
    }
    if (content.author) {
      contentSection.push(`- 作者：${markdownText(content.author)}`);
    }
    if (content.siteName) {
      contentSection.push(`- 站点：${markdownText(content.siteName)}`);
    }
    if (content.publishedAt) {
      contentSection.push(`- 发布时间：${markdownText(content.publishedAt)}`);
    }
    if (content.resolvedUrl) {
      contentSection.push(`- 最终页面：<${markdownUrl(content.resolvedUrl)}>`);
    }
    if (content.description) {
      contentSection.push("", "### 简介", "", markdownText(content.description));
    }
  } else if (content.status === "unavailable") {
    contentSection.push(
      `- 提取状态：未获取到公开元数据（${content.errorCode}）`,
      `- 说明：${markdownText(content.errorMessage)}`,
    );
    if (content.resolvedUrl) {
      contentSection.push(`- 最终页面：<${markdownUrl(content.resolvedUrl)}>`);
    }
  } else {
    contentSection.push("- 提取状态：未尝试");
  }

  return [
    ...frontmatter,
    "",
    `# ${markdownText(title)}`,
    "",
    "## 来源",
    "",
    `- 平台：${platform.label}`,
    `- 原始链接：<${markdownUrl(sourceUrl)}>`,
    `- 规范链接：<${markdownUrl(canonicalUrl)}>`,
    `- 收集时间：${collectedAt}`,
    "",
    ...contentSection,
    "",
    renderMaterialSection(transcript, material),
    "",
    "## 个人备注",
    "",
    markdownText(noteBody),
    "",
  ].join("\n");
}

function resolveCapturePaths(inboxDir, stateDir) {
  if (typeof inboxDir !== "string" || inboxDir.trim() === "") {
    throw validationError("必须显式提供 Inbox 路径。", "INBOX_REQUIRED");
  }

  const inbox = path.resolve(inboxDir);
  const state = stateDir
    ? path.resolve(stateDir)
    : path.join(path.dirname(inbox), ".video-knowledge-capture");
  return { inbox, state };
}

async function appendJsonLine(filePath, value) {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}

function diagnosticMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "未知错误";
}

function errorDetails(error, fallback = {}) {
  if (error instanceof CaptureError) {
    return {
      code: error.code,
      stage: error.stage,
      retryable: error.retryable,
    };
  }
  return {
    code: fallback.code ?? "NOTE_WRITE_FAILED",
    stage: fallback.stage ?? "write",
    retryable: fallback.retryable ?? true,
  };
}

async function recordFailure({
  captureId,
  error,
  material = null,
  note,
  providedTitle = "",
  stateDir,
  transcript = "",
  url,
}) {
  const details = errorDetails(error);
  const failureId = randomUUID();
  const failure = {
    schema_version: "1.0",
    failure_id: failureId,
    capture_id: captureId,
    failed_at: new Date().toISOString(),
    stage: details.stage,
    error_code: details.code,
    message: diagnosticMessage(error),
    retryable: details.retryable,
    retry_input: {
      url: redactUrlCredentials(url),
      note,
      material,
      provided_title: providedTitle,
      transcript,
    },
  };

  try {
    await appendJsonLine(path.join(stateDir, FAILURE_LEDGER), failure);
  } catch (ledgerError) {
    throw new CaptureError(
      `采集失败，且失败记录无法写入：${diagnosticMessage(ledgerError)}`,
      {
        cause: error,
        code: "FAILURE_RECORD_WRITE_FAILED",
        stage: "record-failure",
        retryable: false,
      },
    );
  }

  throw new CaptureError(diagnosticMessage(error), {
    cause: error,
    code: details.code,
    stage: details.stage,
    retryable: details.retryable,
    failureId,
  });
}

async function writeNoteExclusively(notePath, markdown) {
  let handle;
  try {
    handle = await open(notePath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new NoteAlreadyExistsError();
    }
    throw error;
  }

  try {
    await handle.writeFile(markdown, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    handle = undefined;
    await unlink(notePath).catch(() => {});
    throw error;
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

function readFrontmatterString(markdown, key) {
  const match = markdown.match(new RegExp(`^${key}: (.+)$`, "m"));
  if (!match) {
    return null;
  }
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function setFrontmatterValue(markdown, key, serializedValue) {
  const line = `${key}: ${serializedValue}`;
  const pattern = new RegExp(`^${key}: .*$`, "m");
  if (pattern.test(markdown)) {
    return markdown.replace(pattern, line);
  }
  const tagsMarker = "\ntags:\n";
  const tagsIndex = markdown.indexOf(tagsMarker);
  if (tagsIndex !== -1) {
    return `${markdown.slice(0, tagsIndex)}\n${line}${markdown.slice(tagsIndex)}`;
  }
  throw new CaptureError("原笔记 frontmatter 结构无法安全更新。", {
    code: "MANAGED_NOTE_INVALID",
    stage: "update-note",
    retryable: false,
  });
}

function materialSummary(providedTitle, transcript, material) {
  return {
    status: transcript ? "provided" : "missing",
    source: material.source,
    segmentCount: material.segments.length,
    transcriptCharCount: transcript.length,
    titleProvided: Boolean(providedTitle),
  };
}

function mergeManualMaterial({
  captureId,
  markdown,
  material,
  platform,
  providedTitle,
  transcript,
}) {
  if (!markdown.includes(`capture_id: ${yamlString(captureId)}`)) {
    throw new CaptureError("目标文件与当前链接不匹配，已停止更新。", {
      code: "MANAGED_NOTE_ID_MISMATCH",
      stage: "update-note",
      retryable: false,
    });
  }

  let updated = markdown;
  let changed = false;

  if (providedTitle) {
    const existingProvidedTitle = readFrontmatterString(updated, "provided_title");
    if (existingProvidedTitle && existingProvidedTitle !== providedTitle) {
      throw new CaptureError("原笔记已有不同的用户标题，未自动覆盖。", {
        code: "MANUAL_TITLE_CONFLICT",
        stage: "update-note",
        retryable: false,
      });
    }
    if (!existingProvidedTitle) {
      const currentTitle = readFrontmatterString(updated, "title");
      const sourceTitle = readFrontmatterString(updated, "source_title");
      const fallbackTitle = `视频收藏 · ${platform.label}`;
      if (
        !currentTitle
        || (currentTitle !== fallbackTitle && currentTitle !== sourceTitle)
      ) {
        throw new CaptureError("原笔记标题已被修改，未自动覆盖。", {
          code: "MANUAL_TITLE_CONFLICT",
          stage: "update-note",
          retryable: false,
        });
      }
      updated = setFrontmatterValue(updated, "title", yamlString(providedTitle));
      updated = setFrontmatterValue(
        updated,
        "provided_title",
        yamlString(providedTitle),
      );
      updated = updated.replace(
        new RegExp(`^# ${currentTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
        `# ${markdownText(providedTitle)}`,
      );
      changed = true;
    }
  }

  if (transcript) {
    const newHash = materialHash(transcript);
    const existingHash = updated.match(
      /<!-- video-knowledge-capture:material-sha256:([0-9a-f]{64}) -->/,
    )?.[1];
    if (existingHash && existingHash !== newHash) {
      throw new CaptureError("原笔记已有不同的视频内容，未自动覆盖。", {
        code: "MANUAL_CONTENT_CONFLICT",
        stage: "update-note",
        retryable: false,
      });
    }

    if (!existingHash) {
      const startIndex = updated.indexOf(MATERIAL_START);
      const endIndex = updated.indexOf(MATERIAL_END);
      const materialSection = renderMaterialSection(transcript, material);
      if ((startIndex === -1) !== (endIndex === -1)) {
        throw new CaptureError("原笔记的视频内容区结构不完整，未自动更新。", {
          code: "MANAGED_SECTION_INVALID",
          stage: "update-note",
          retryable: false,
        });
      }
      if (startIndex !== -1) {
        updated = `${updated.slice(0, startIndex)}${materialSection}${updated.slice(
          endIndex + MATERIAL_END.length,
        )}`;
      } else {
        const noteMarker = "\n## 个人备注\n";
        const noteIndex = updated.indexOf(noteMarker);
        if (noteIndex === -1) {
          throw new CaptureError("原笔记缺少可定位的个人备注区，未自动更新。", {
            code: "MANAGED_NOTE_INVALID",
            stage: "update-note",
            retryable: false,
          });
        }
        updated = `${updated.slice(0, noteIndex)}\n${materialSection}\n${updated.slice(noteIndex)}`;
      }
      updated = setFrontmatterValue(updated, "material_status", yamlString("provided"));
      updated = setFrontmatterValue(updated, "material_source", yamlString(material.source));
      updated = setFrontmatterValue(updated, "material_char_count", transcript.length);
      if (material.language) {
        updated = setFrontmatterValue(updated, "material_language", yamlString(material.language));
      }
      if (material.model) {
        updated = setFrontmatterValue(updated, "material_model", yamlString(material.model));
      }
      if (material.durationSeconds !== null) {
        updated = setFrontmatterValue(
          updated,
          "media_duration_seconds",
          material.durationSeconds,
        );
      }
      changed = true;
    }
  }

  return { changed, markdown: updated };
}

async function writeNoteAtomically(notePath, markdown) {
  const temporaryPath = `${notePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, markdown, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, notePath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function enrichExistingNote({
  captureId,
  material,
  notePath,
  platform,
  providedTitle,
  transcript,
}) {
  if (!providedTitle && !transcript) {
    return { changed: false };
  }
  const markdown = await readFile(notePath, "utf8");
  const merged = mergeManualMaterial({
    captureId,
    markdown,
    material,
    platform,
    providedTitle,
    transcript,
  });
  if (merged.changed) {
    await writeNoteAtomically(notePath, merged.markdown);
  }
  return { changed: merged.changed };
}

export async function captureVideo({
  contentExtractor,
  createInbox = true,
  inboxDir,
  note: rawNote = "",
  now = () => new Date(),
  material: rawMaterial = null,
  providedTitle: rawProvidedTitle = "",
  stateDir,
  transcript: rawTranscript = "",
  url: rawUrl,
}) {
  const { inbox, state } = resolveCapturePaths(inboxDir, stateDir);

  try {
    await mkdir(state, { recursive: true });
  } catch (error) {
    throw new CaptureError(`状态目录不可写：${diagnosticMessage(error)}`, {
      cause: error,
      code: "STATE_DIRECTORY_UNAVAILABLE",
      stage: "prepare-state",
      retryable: false,
    });
  }

  let material;
  let note;
  let providedTitle;
  let transcript;
  let canonicalUrl;
  try {
    note = normalizeNote(rawNote);
    providedTitle = normalizeProvidedTitle(rawProvidedTitle);
    const automaticMaterial = rawMaterial?.source === "local-asr"
      || rawMaterial?.source === "public-url-asr"
      || rawMaterial?.source === "wechat-local-asr";
    transcript = normalizeTranscript(
      rawTranscript,
      automaticMaterial ? MAX_AUTOMATIC_TRANSCRIPT_LENGTH : MAX_MANUAL_TRANSCRIPT_LENGTH,
    );
    material = normalizeMaterial(rawMaterial, transcript);
    canonicalUrl = normalizeVideoUrl(rawUrl);
  } catch (error) {
    await recordFailure({
      captureId: null,
      error,
      material: rawMaterial && typeof rawMaterial === "object" ? rawMaterial : null,
      note: typeof rawNote === "string" ? rawNote : "",
      providedTitle: typeof rawProvidedTitle === "string" ? rawProvidedTitle : "",
      stateDir: state,
      transcript: typeof rawTranscript === "string" ? rawTranscript : "",
      url: rawUrl,
    });
  }

  const captureId = createCaptureId(canonicalUrl);
  const platform = detectPlatform(canonicalUrl);
  const sourceUrl = rawUrl.trim();
  const collectedAt = now().toISOString();
  const notePath = path.join(
    inbox,
    `video-${platform.id}-${captureId.slice(0, 16)}.md`,
  );

  try {
    if (createInbox) {
      await mkdir(inbox, { recursive: true });
    } else {
      const inboxMetadata = await stat(inbox);
      if (!inboxMetadata.isDirectory()) {
        const error = new Error("已配置的 Inbox 路径不是文件夹。");
        error.code = "ENOTDIR";
        throw error;
      }
    }
  } catch (error) {
    await recordFailure({
      captureId,
      error: new CaptureError(diagnosticMessage(error), {
        cause: error,
        code: "NOTE_WRITE_FAILED",
        stage: "write-note",
        retryable: true,
      }),
      material,
      note,
      providedTitle,
      stateDir: state,
      transcript,
      url: rawUrl,
    });
  }

  let noteExists = false;
  try {
    await stat(notePath);
    noteExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await recordFailure({
        captureId,
        error: new CaptureError(diagnosticMessage(error), {
          cause: error,
          code: "NOTE_WRITE_FAILED",
          stage: "write-note",
          retryable: true,
        }),
        material,
        note,
        providedTitle,
        stateDir: state,
        transcript,
        url: rawUrl,
      });
    }
  }

  if (noteExists) {
    let enrichment;
    try {
      enrichment = await enrichExistingNote({
        captureId,
        material,
        notePath,
        platform,
        providedTitle,
        transcript,
      });
    } catch (error) {
      await recordFailure({
        captureId,
        error: error instanceof CaptureError
          ? error
          : new CaptureError(diagnosticMessage(error), {
              cause: error,
              code: "NOTE_UPDATE_FAILED",
              stage: "update-note",
              retryable: true,
            }),
        material,
        note,
        providedTitle,
        stateDir: state,
        transcript,
        url: rawUrl,
      });
    }
    return {
      status: enrichment.changed ? "updated" : "duplicate",
      captureId,
      content: normalizeContentResult({
        status: "not-attempted",
        errorCode: enrichment.changed
          ? "EXISTING_NOTE_ENRICHED_NO_REFETCH"
          : "DUPLICATE_NO_REFETCH",
      }),
      material: materialSummary(providedTitle, transcript, material),
      notePath,
      platform,
    };
  }

  let content = normalizeContentResult();
  if (typeof contentExtractor === "function") {
    try {
      content = normalizeContentResult(await contentExtractor({
        canonicalUrl,
        platform,
        sourceUrl,
      }));
    } catch (error) {
      content = contentFromExtractorError(error);
    }
  }

  const markdown = renderMarkdown({
    captureId,
    canonicalUrl,
    collectedAt,
    content,
    note,
    platform,
    providedTitle,
    sourceUrl,
    transcript,
    material,
  });

  try {
    await writeNoteExclusively(notePath, markdown);
  } catch (error) {
    if (error instanceof NoteAlreadyExistsError) {
      let enrichment;
      try {
        enrichment = await enrichExistingNote({
          captureId,
          material,
          notePath,
          platform,
          providedTitle,
          transcript,
        });
      } catch (enrichmentError) {
        await recordFailure({
          captureId,
          error: enrichmentError instanceof CaptureError
            ? enrichmentError
            : new CaptureError(diagnosticMessage(enrichmentError), {
                cause: enrichmentError,
                code: "NOTE_UPDATE_FAILED",
                stage: "update-note",
                retryable: true,
              }),
          material,
          note,
          providedTitle,
          stateDir: state,
          transcript,
          url: rawUrl,
        });
      }
      return {
        status: enrichment.changed ? "updated" : "duplicate",
        captureId,
        content: normalizeContentResult({
          status: "not-attempted",
          errorCode: enrichment.changed
            ? "RACE_NOTE_ENRICHED_NO_REFETCH"
            : "DUPLICATE_RACE_NO_UPDATE",
        }),
        material: materialSummary(providedTitle, transcript, material),
        notePath,
        platform,
      };
    }
    await recordFailure({
      captureId,
      error: new CaptureError(diagnosticMessage(error), {
        cause: error,
        code: "NOTE_WRITE_FAILED",
        stage: "write-note",
        retryable: true,
      }),
      material,
      note,
      providedTitle,
      stateDir: state,
      transcript,
      url: rawUrl,
    });
  }

  return {
    status: "created",
    captureId,
    content,
    material: materialSummary(providedTitle, transcript, material),
    notePath,
    platform,
  };
}

async function readFailure(stateDir, failureId) {
  const records = await readJsonLines(path.join(stateDir, FAILURE_LEDGER), {
    allowMissing: false,
    unavailableCode: "FAILURE_LEDGER_UNAVAILABLE",
    unavailableMessage: "无法读取失败记录。",
  });

  for (const record of records.reverse()) {
    if (record.failure_id === failureId) {
      return record;
    }
  }

  throw new CaptureError("未找到指定失败记录。", {
    code: "FAILURE_NOT_FOUND",
    stage: "read-failure",
    retryable: false,
  });
}

async function readJsonLines(filePath, {
  allowMissing = true,
  unavailableCode = "LEDGER_UNAVAILABLE",
  unavailableMessage = "无法读取记录。",
} = {}) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      return [];
    }
    throw new CaptureError(unavailableMessage, {
      cause: error,
      code: unavailableCode,
      stage: "read-failure",
      retryable: false,
    });
  }

  const records = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new CaptureError(`${unavailableMessage.replace(/。$/, "")}，记录格式已损坏。`, {
        code: "FAILURE_LEDGER_INVALID",
        stage: "read-failure",
        retryable: false,
      });
    }
  }
  return records;
}

export async function listFailureRecords({ stateDir, limit = 50 }) {
  const resolvedState = path.resolve(stateDir);
  const [failures, retryEvents] = await Promise.all([
    readJsonLines(path.join(resolvedState, FAILURE_LEDGER)),
    readJsonLines(path.join(resolvedState, RETRY_LEDGER)),
  ]);
  const latestRetryByFailure = new Map();
  for (const event of retryEvents) {
    latestRetryByFailure.set(event.failure_id, event);
  }

  const safeLimit = Number.isInteger(limit)
    ? Math.min(Math.max(limit, 1), 200)
    : 50;
  return failures
    .sort((left, right) => String(right.failed_at).localeCompare(String(left.failed_at)))
    .slice(0, safeLimit)
    .map((failure) => {
      const lastRetry = latestRetryByFailure.get(failure.failure_id) ?? null;
      const resolved = lastRetry?.result === "created" || lastRetry?.result === "duplicate";
      return {
        ...failure,
        resolution: resolved ? "resolved" : "pending",
        last_retry: lastRetry,
      };
  });
}

export async function retryFailure({
  contentExtractor,
  createInbox = true,
  failureId,
  inboxDir,
  stateDir,
}) {
  if (typeof failureId !== "string" || failureId.trim() === "") {
    throw validationError("必须提供 failure ID。", "FAILURE_ID_REQUIRED");
  }
  const { state } = resolveCapturePaths(inboxDir, stateDir);
  const failure = await readFailure(state, failureId);
  if (!failure.retryable) {
    throw new CaptureError("该失败记录不可重试。", {
      code: "FAILURE_NOT_RETRYABLE",
      stage: "retry",
      retryable: false,
    });
  }

  try {
    const result = await captureVideo({
      contentExtractor,
      createInbox,
      inboxDir,
      material: failure.retry_input.material ?? null,
      note: failure.retry_input.note,
      providedTitle: failure.retry_input.provided_title ?? "",
      stateDir: state,
      transcript: failure.retry_input.transcript ?? "",
      url: failure.retry_input.url,
    });
    await appendJsonLine(path.join(state, RETRY_LEDGER), {
      schema_version: "1.0",
      failure_id: failureId,
      attempted_at: new Date().toISOString(),
      result: result.status,
      capture_id: result.captureId,
      note_path: result.notePath,
    });
    return { ...result, retriedFailureId: failureId };
  } catch (error) {
    await appendJsonLine(path.join(state, RETRY_LEDGER), {
      schema_version: "1.0",
      failure_id: failureId,
      attempted_at: new Date().toISOString(),
      result: "failed",
      next_failure_id: error instanceof CaptureError ? error.failureId : null,
      error_code: error instanceof CaptureError ? error.code : "CAPTURE_FAILED",
    });
    throw error;
  }
}
