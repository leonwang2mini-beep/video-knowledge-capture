#!/usr/bin/env node

import { access, constants, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadAppConfig, resolveDefaultConfigDir } from "../src/app-config.mjs";
import { getRuntimeStatus } from "../src/runtime-manager.mjs";
import { APP_VERSION } from "../src/version.mjs";
import { defaultSkillsDir } from "./install-agent-skill.mjs";

export const COMMUNITY_HOSTS = Object.freeze(["codex", "claude", "hermes", "openclaw"]);
const REQUIRED_RUNTIME_COMPONENTS = Object.freeze(["ffmpeg", "whisper", "whisperModel", "ytDlp"]);

function expandHosts(host) {
  if (host === "all") return [...COMMUNITY_HOSTS];
  if (!COMMUNITY_HOSTS.includes(host)) {
    throw new Error(`--host must be one of: ${COMMUNITY_HOSTS.join(", ")}, or all.`);
  }
  return [host];
}

export function parseArguments(argv) {
  const options = {
    configDir: resolveDefaultConfigDir(),
    host: null,
    hermesHome: process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"),
    shareable: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--shareable") {
      options.shareable = true;
      continue;
    }
    const value = argv[index + 1];
    if (argument === "--host" && value) options.host = value.toLowerCase();
    else if (argument === "--config-dir" && value) options.configDir = value;
    else if (argument === "--hermes-home" && value) options.hermesHome = value;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  if (!options.host) throw new Error("--host is required.");
  expandHosts(options.host);
  return options;
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function addCheck(checks, id, passed, summary, nextAction = null) {
  checks.push({
    id,
    status: passed ? "pass" : "fail",
    summary,
    ...(passed || !nextAction ? {} : { next_action: nextAction }),
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sensitivePathVariants(sensitivePaths) {
  return [...new Set(sensitivePaths
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .flatMap((value) => {
      const resolved = path.resolve(value);
      return [resolved, resolved.replaceAll("\\", "/"), resolved.replaceAll("/", "\\")];
    }))]
    .sort((left, right) => right.length - left.length);
}

function redactDoctorValue(value, pathVariants) {
  if (typeof value === "string") {
    return pathVariants.reduce(
      (redacted, candidate) => redacted.replace(
        new RegExp(escapeRegExp(candidate), "gi"),
        "<redacted-path>",
      ),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDoctorValue(entry, pathVariants));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactDoctorValue(entry, pathVariants)]),
    );
  }
  return value;
}

export function createShareableDoctorResult(result, sensitivePaths = []) {
  const redacted = redactDoctorValue(result, sensitivePathVariants(sensitivePaths));
  return {
    ...redacted,
    diagnostic_mode: "shareable",
    privacy: {
      paths_redacted: true,
      review_before_sharing: true,
      warning: "Review this report before posting it. Never add URLs, cookies, tokens, private media, or raw downloader output.",
    },
  };
}

export async function runDoctor({
  configDir = resolveDefaultConfigDir(),
  host,
  hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"),
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  nodeVersion = process.versions.node,
  fetchImpl = fetch,
  configLoader = loadAppConfig,
  runtimeStatusLoader = getRuntimeStatus,
  baseUrl = "http://127.0.0.1:43127",
  shareable = false,
} = {}) {
  const hosts = expandHosts(host);
  const checks = [];
  const sensitivePaths = [configDir, hermesHome, homeDir];
  addCheck(
    checks,
    "platform",
    platform === "win32",
    platform === "win32" ? "Windows host detected." : `Unsupported platform: ${platform}.`,
    "Run the local engine on Windows 10 or newer.",
  );
  const nodeMajor = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  addCheck(
    checks,
    "node",
    Number.isInteger(nodeMajor) && nodeMajor >= 20,
    `Node.js ${nodeVersion}.`,
    "Install Node.js 20 or newer.",
  );

  let config = null;
  try {
    config = await configLoader(path.resolve(configDir));
    if (config.inboxDir) sensitivePaths.push(config.inboxDir);
    if (config.inboxDir) await access(config.inboxDir, constants.W_OK);
    addCheck(
      checks,
      "inbox",
      Boolean(config.inboxDir),
      config.inboxDir ? `Writable Inbox configured at ${config.inboxDir}.` : "Inbox is not configured.",
      "Run setup:community with an existing writable Inbox path.",
    );
  } catch (error) {
    addCheck(
      checks,
      "inbox",
      false,
      `Inbox configuration is unavailable (${error.code || "CONFIG_ERROR"}).`,
      "Repair the configured Inbox path, then run doctor again.",
    );
  }

  try {
    const runtime = await runtimeStatusLoader(path.resolve(configDir));
    const missing = REQUIRED_RUNTIME_COMPONENTS.filter((name) => !runtime.components?.[name]?.ready);
    addCheck(
      checks,
      "runtime",
      missing.length === 0,
      missing.length === 0
        ? "Core downloader and transcription runtime is ready."
        : `Missing runtime components: ${missing.join(", ")}.`,
      "Run npm.cmd run setup:runtime.",
    );
  } catch (error) {
    addCheck(
      checks,
      "runtime",
      false,
      `Runtime status could not be read (${error.code || "RUNTIME_ERROR"}).`,
      "Run npm.cmd run setup:runtime, then run doctor again.",
    );
  }

  for (const currentHost of hosts) {
    let requiredFiles;
    if (currentHost === "hermes") {
      const resolvedHermesHome = path.resolve(hermesHome);
      requiredFiles = [
        path.join(resolvedHermesHome, "skills", "video-knowledge-capture", "SKILL.md"),
        path.join(resolvedHermesHome, "plugins", "video-knowledge-capture", "plugin.yaml"),
      ];
    } else {
      const skillsDir = defaultSkillsDir(currentHost, env, homeDir);
      requiredFiles = [path.join(skillsDir, "video-knowledge-capture", "SKILL.md")];
    }
    const present = (await Promise.all(requiredFiles.map(fileExists))).every(Boolean);
    addCheck(
      checks,
      `host-${currentHost}`,
      present,
      present ? `${currentHost} integration files are installed.` : `${currentHost} integration files are missing.`,
      currentHost === "hermes"
        ? "Run npm.cmd run setup:hermes."
        : `Run npm.cmd run setup:skill:${currentHost}.`,
    );
  }

  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    const health = response.ok ? await response.json() : null;
    const healthy = response.ok
      && health?.status === "ok"
      && health?.binding === "127.0.0.1"
      && health?.app === "video-knowledge-capture"
      && health?.version === APP_VERSION;
    const serviceSummary = health?.app === "video-knowledge-capture"
      && health?.binding === "127.0.0.1"
      && health?.status === "ok"
      && health?.version !== APP_VERSION
      ? `Local service version ${health.version || "unknown"} does not match repository version ${APP_VERSION}.`
      : `Local service health check failed${response.ok ? " validation" : ` with HTTP ${response.status}`}.`;
    addCheck(
      checks,
      "service",
      healthy,
      healthy
        ? `Local service ${health.version || "unknown"} is healthy on 127.0.0.1.`
        : serviceSummary,
      "Close any older service window, run start-video-capture.cmd, and keep its window open.",
    );
  } catch {
    addCheck(
      checks,
      "service",
      false,
      "Local service is unreachable at 127.0.0.1:43127.",
      "Run start-video-capture.cmd and keep its window open.",
    );
  }

  const result = {
    app: "video-knowledge-capture",
    version: APP_VERSION,
    status: checks.every((entry) => entry.status === "pass") ? "ready" : "needs_setup",
    hosts,
    config_dir: path.resolve(configDir),
    checks,
  };
  return shareable ? createShareableDoctorResult(result, sensitivePaths) : result;
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runDoctor(parseArguments(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "ready" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code || "DOCTOR_FAILED",
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
