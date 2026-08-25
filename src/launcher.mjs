#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveDefaultConfigDir } from "./app-config.mjs";
import { openDefaultBrowser, startLocalApp } from "./server.mjs";
import { APP_VERSION } from "./version.mjs";

export const APP_PORT = 43127;
const MINIMUM_NODE_MAJOR = 20;

export class LauncherError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "LauncherError";
    this.code = code;
  }
}

export function assertSupportedNode(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw new LauncherError(
      `需要 Node.js ${MINIMUM_NODE_MAJOR} 或更高版本，当前版本为 ${version}。`,
      "NODE_VERSION_UNSUPPORTED",
    );
  }
  return major;
}

export async function readRunningApp({
  fetchImpl = fetch,
  port = APP_PORT,
} = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return payload.app === "video-knowledge-capture"
      && payload.status === "ok"
      && payload.binding === "127.0.0.1"
      ? payload
      : null;
  } catch {
    return null;
  }
}

export async function isAppAlreadyRunning(options = {}) {
  const payload = await readRunningApp(options);
  return payload?.version === APP_VERSION;
}

export async function launchDesktopApp({
  configDir = resolveDefaultConfigDir(),
  fetchImpl = fetch,
  logger = console,
  nodeVersion = process.versions.node,
  openBrowser = true,
  openBrowserImpl = openDefaultBrowser,
  port = APP_PORT,
  startAppImpl = startLocalApp,
} = {}) {
  assertSupportedNode(nodeVersion);
  const expectedUrl = `http://127.0.0.1:${port}`;

  const runningApp = await readRunningApp({ fetchImpl, port });
  if (runningApp?.version === APP_VERSION) {
    logger.log?.(`视频知识捕手已经在运行：${expectedUrl}`);
    if (openBrowser) {
      openBrowserImpl(expectedUrl);
    }
    return { mode: "existing", server: null, url: expectedUrl };
  }
  if (runningApp) {
    throw new LauncherError(
      `检测到仍在运行的视频知识捕手 ${runningApp.version ?? "旧版本"}。请关闭原启动窗口，再双击启动 ${APP_VERSION}。`,
      "APP_VERSION_CONFLICT",
    );
  }

  let started;
  try {
    started = await startAppImpl({
      configDir,
      logger,
      openBrowser: false,
      port,
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      throw new LauncherError(
        `端口 ${port} 已被其他程序占用，请关闭占用程序后重试。`,
        "PORT_IN_USE",
        { cause: error },
      );
    }
    throw error;
  }

  if (openBrowser) {
    openBrowserImpl(started.url);
  }
  return { mode: "started", ...started };
}

function parseArguments(args) {
  const options = {
    configDir: resolveDefaultConfigDir(),
    openBrowser: true,
    port: APP_PORT,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") {
      options.openBrowser = false;
      continue;
    }
    if (argument === "--port" || argument === "--config-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new LauncherError(`参数 ${argument} 缺少值。`, "INVALID_ARGUMENT");
      }
      if (argument === "--port") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new LauncherError("端口必须是 1 到 65535 之间的整数。", "INVALID_PORT");
        }
        options.port = port;
      } else {
        options.configDir = path.resolve(value);
      }
      index += 1;
      continue;
    }
    throw new LauncherError(`未知参数：${argument}`, "INVALID_ARGUMENT");
  }
  return options;
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
    launchDesktopApp(options)
      .then((result) => {
        if (!result.server) {
          return;
        }
        const stop = () => result.server.close(() => process.exit(0));
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      })
      .catch((error) => {
        process.stderr.write(`启动失败：${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
