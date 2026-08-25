import { randomUUID } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CONFIG_FILE = "config.json";

export class AppConfigError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "AppConfigError";
    this.code = code;
  }
}

export function resolveDefaultConfigDir({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  if (env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, "VideoKnowledgeCapture");
  }
  return path.join(homeDir, ".video-knowledge-capture");
}

export function resolveStateDir(configDir) {
  return path.join(path.resolve(configDir), "state");
}

export function resolveRuntimeDir(configDir) {
  return path.join(path.resolve(configDir), "runtime");
}

export function resolveWorkDir(configDir) {
  return path.join(path.resolve(configDir), "work");
}

function defaultConfig() {
  return {
    inboxDir: null,
    retainedMediaDir: null,
    wechatAdvancedEnabled: false,
  };
}

function stripMatchingQuotes(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export async function validateInboxDirectory(inboxDir) {
  if (typeof inboxDir !== "string" || inboxDir.trim() === "") {
    throw new AppConfigError("请输入 Obsidian Inbox 的完整路径。", "INBOX_REQUIRED");
  }

  const candidate = stripMatchingQuotes(inboxDir);
  if (!path.isAbsolute(candidate)) {
    throw new AppConfigError("Inbox 必须使用完整绝对路径。", "INBOX_PATH_NOT_ABSOLUTE");
  }
  const resolved = path.resolve(candidate);

  let metadata;
  try {
    metadata = await stat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AppConfigError("该 Inbox 目录不存在，请先在 Obsidian vault 中创建。", "INBOX_NOT_FOUND", {
        cause: error,
      });
    }
    throw new AppConfigError("无法检查该 Inbox 目录。", "INBOX_UNAVAILABLE", {
      cause: error,
    });
  }

  if (!metadata.isDirectory()) {
    throw new AppConfigError("所选 Inbox 路径不是文件夹。", "INBOX_NOT_DIRECTORY");
  }

  try {
    await access(resolved, constants.W_OK);
  } catch (error) {
    throw new AppConfigError("该 Inbox 当前不可写。", "INBOX_NOT_WRITABLE", {
      cause: error,
    });
  }

  return resolved;
}

export async function validateRetainedMediaDirectory(retainedMediaDir) {
  if (typeof retainedMediaDir !== "string" || retainedMediaDir.trim() === "") {
    throw new AppConfigError("请输入下载视频保存位置的完整路径。", "RETAINED_MEDIA_DIR_REQUIRED");
  }

  const candidate = stripMatchingQuotes(retainedMediaDir);
  if (!path.isAbsolute(candidate)) {
    throw new AppConfigError(
      "视频保存位置必须使用完整绝对路径。",
      "RETAINED_MEDIA_PATH_NOT_ABSOLUTE",
    );
  }
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new AppConfigError(
      "视频保存位置不能直接使用磁盘根目录。",
      "RETAINED_MEDIA_ROOT_NOT_ALLOWED",
    );
  }

  try {
    await mkdir(resolved, { recursive: true });
    const metadata = await stat(resolved);
    if (!metadata.isDirectory()) {
      throw new AppConfigError(
        "视频保存位置不是文件夹。",
        "RETAINED_MEDIA_NOT_DIRECTORY",
      );
    }
    await access(resolved, constants.W_OK);
  } catch (error) {
    if (error instanceof AppConfigError) throw error;
    throw new AppConfigError(
      "无法创建或写入视频保存位置。",
      "RETAINED_MEDIA_NOT_WRITABLE",
      { cause: error },
    );
  }

  return resolved;
}

export async function loadAppConfig(configDir) {
  const configPath = path.join(path.resolve(configDir), CONFIG_FILE);
  let content;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return defaultConfig();
    }
    throw new AppConfigError("无法读取本地配置。", "CONFIG_READ_FAILED", {
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new AppConfigError("本地配置已损坏，请重新配置 Inbox。", "CONFIG_INVALID", {
      cause: error,
    });
  }

  if (!parsed || typeof parsed !== "object") {
    throw new AppConfigError("本地配置格式无效。", "CONFIG_INVALID");
  }
  if (
    parsed.inboxDir !== null
    && (typeof parsed.inboxDir !== "string" || !path.isAbsolute(parsed.inboxDir))
  ) {
    throw new AppConfigError("本地配置缺少有效的 Inbox 路径。", "CONFIG_INVALID");
  }
  if (
    parsed.wechatAdvancedEnabled !== undefined
    && typeof parsed.wechatAdvancedEnabled !== "boolean"
  ) {
    throw new AppConfigError("本地配置中的微信高级模式状态无效。", "CONFIG_INVALID");
  }
  if (
    parsed.retainedMediaDir !== undefined
    && parsed.retainedMediaDir !== null
    && (typeof parsed.retainedMediaDir !== "string"
      || !path.isAbsolute(parsed.retainedMediaDir)
      || path.resolve(parsed.retainedMediaDir) === path.parse(path.resolve(parsed.retainedMediaDir)).root)
  ) {
    throw new AppConfigError("本地配置中的视频保存位置无效。", "CONFIG_INVALID");
  }

  return {
    inboxDir: parsed.inboxDir ? path.resolve(parsed.inboxDir) : null,
    retainedMediaDir: parsed.retainedMediaDir ? path.resolve(parsed.retainedMediaDir) : null,
    wechatAdvancedEnabled: parsed.wechatAdvancedEnabled === true,
  };
}

export async function saveAppConfig(configDir, updates = {}) {
  const resolvedConfigDir = path.resolve(configDir);
  await mkdir(resolvedConfigDir, { recursive: true });

  const existing = await loadAppConfig(resolvedConfigDir);
  const next = { ...existing };
  if (Object.hasOwn(updates, "inboxDir")) {
    next.inboxDir = await validateInboxDirectory(updates.inboxDir);
  }
  if (Object.hasOwn(updates, "wechatAdvancedEnabled")) {
    if (typeof updates.wechatAdvancedEnabled !== "boolean") {
      throw new AppConfigError(
        "微信高级模式状态必须是布尔值。",
        "INVALID_WECHAT_ADVANCED_MODE",
      );
    }
    next.wechatAdvancedEnabled = updates.wechatAdvancedEnabled;
  }
  if (Object.hasOwn(updates, "retainedMediaDir")) {
    next.retainedMediaDir = await validateRetainedMediaDirectory(updates.retainedMediaDir);
  }
  if (!next.inboxDir) {
    throw new AppConfigError("请先配置 Obsidian Inbox。", "INBOX_REQUIRED");
  }

  const configPath = path.join(resolvedConfigDir, CONFIG_FILE);
  const temporaryPath = path.join(
    resolvedConfigDir,
    `.config-${process.pid}-${randomUUID()}.tmp`,
  );
  const payload = `${JSON.stringify({
    schemaVersion: 3,
    inboxDir: next.inboxDir,
    retainedMediaDir: next.retainedMediaDir,
    wechatAdvancedEnabled: next.wechatAdvancedEnabled,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`;

  let handle;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, configPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await unlink(temporaryPath).catch(() => {});
    throw new AppConfigError("无法保存本地配置。", "CONFIG_WRITE_FAILED", {
      cause: error,
    });
  }

  return next;
}
