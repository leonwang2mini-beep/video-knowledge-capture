import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { findChromiumBrowser } from "./yuanbao-session.mjs";

export const DOUYIN_ANONYMOUS_SESSION_TIMEOUT_MS = 75 * 1000;

export class AnonymousBrowserSessionError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "AnonymousBrowserSessionError";
    this.code = code;
    this.retryable = options.retryable ?? true;
    this.stage = "download-public";
  }
}

function sessionError(message, code, cause) {
  return new AnonymousBrowserSessionError(message, code, { cause });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

class CdpClient {
  constructor(url, { WebSocketImpl = globalThis.WebSocket } = {}) {
    if (typeof WebSocketImpl !== "function") {
      throw sessionError(
        "当前 Node.js 缺少隔离浏览器控制能力。",
        "PUBLIC_MEDIA_BROWSER_RUNTIME_UNSUPPORTED",
      );
    }
    this.socket = new WebSocketImpl(url);
    this.nextId = 1;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(sessionError(
        "无法连接匿名隔离浏览器。",
        "PUBLIC_MEDIA_BROWSER_CONTROL_FAILED",
      )), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!payload.id || !this.pending.has(payload.id)) return;
      const pending = this.pending.get(payload.id);
      this.pending.delete(payload.id);
      clearTimeout(pending.timeout);
      if (payload.error) {
        pending.reject(sessionError(
          "匿名隔离浏览器未能返回会话状态。",
          "PUBLIC_MEDIA_BROWSER_CONTROL_FAILED",
        ));
      } else {
        pending.resolve(payload.result ?? {});
      }
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(sessionError(
          "匿名隔离浏览器已提前关闭。",
          "PUBLIC_MEDIA_BROWSER_CLOSED",
        ));
      }
      this.pending.clear();
    });
  }

  async call(method, params = {}, timeoutMs = 10000) {
    await this.opened;
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(sessionError(
          "匿名隔离浏览器响应超时。",
          "PUBLIC_MEDIA_BROWSER_CONTROL_TIMEOUT",
        ));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Closing an already closed diagnostics socket is harmless.
    }
  }
}

async function readDevToolsUrl(profileDir, timeoutMs = 20000) {
  const filePath = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [portLine, browserPath] = (await readFile(filePath, "utf8")).trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && browserPath?.startsWith("/devtools/browser/")) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    } catch {
      // Chromium creates the file only after its isolated profile is ready.
    }
    await wait(200);
  }
  throw sessionError(
    "匿名隔离浏览器未能在限定时间内启动。",
    "PUBLIC_MEDIA_BROWSER_START_TIMEOUT",
  );
}

function cookieMatchesDomains(cookie, allowedDomains) {
  const domain = String(cookie?.domain ?? "").replace(/^\./, "").toLowerCase();
  return domain !== "" && allowedDomains.some((allowed) => (
    domain === allowed || domain.endsWith(`.${allowed}`)
  ));
}

function sanitizeCookies(cookies, allowedDomains) {
  return cookies
    .filter((cookie) => (
      cookieMatchesDomains(cookie, allowedDomains)
      && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(String(cookie.name ?? ""))
      && typeof cookie.value === "string"
      && cookie.value.length > 0
      && cookie.value.length <= 16 * 1024
      && !/[\t\r\n]/.test(cookie.value)
    ))
    .slice(0, 100)
    .map((cookie) => ({
      domain: String(cookie.domain),
      expires: Number.isFinite(cookie.expires) ? cookie.expires : 0,
      name: String(cookie.name),
      path: String(cookie.path || "/"),
      secure: cookie.secure === true,
      value: cookie.value,
    }));
}

export async function captureAnonymousDouyinSession({
  bootstrapUrl,
  browserFinder = findChromiumBrowser,
  browserPath,
  spawnImpl = spawn,
  timeoutMs = DOUYIN_ANONYMOUS_SESSION_TIMEOUT_MS,
  url,
  WebSocketImpl = globalThis.WebSocket,
  workDir,
} = {}) {
  if (!url || !workDir) {
    throw sessionError(
      "抖音匿名会话参数无效。",
      "PUBLIC_MEDIA_BROWSER_INPUT_INVALID",
    );
  }
  const profileDir = path.join(path.resolve(workDir), `anonymous-douyin-${randomUUID()}`);
  if (!isInside(workDir, profileDir)) {
    throw sessionError(
      "抖音匿名会话目录越界。",
      "PUBLIC_MEDIA_BROWSER_PATH_INVALID",
    );
  }
  await mkdir(profileDir, { recursive: true });
  const executable = browserPath ?? await browserFinder();
  const launchUrl = bootstrapUrl || url;
  const requiresTargetCookies = launchUrl !== url;
  const child = spawnImpl(executable, [
    `--user-data-dir=${profileDir}`,
    "--profile-directory=Default",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=msEdgeFirstRunExperience",
    launchUrl,
  ], {
    cwd: path.dirname(executable),
    env: process.env,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  let client;
  let exited = false;
  let spawnFailure = null;
  child.once("exit", () => { exited = true; });
  child.once("error", (error) => { spawnFailure = error; });
  try {
    const websocketUrl = await readDevToolsUrl(profileDir);
    if (spawnFailure) throw spawnFailure;
    client = new CdpClient(websocketUrl, { WebSocketImpl });
    const version = await client.call("Browser.getVersion");
    const deadline = Date.now() + timeoutMs;
    let targetOpened = false;
    while (Date.now() < deadline) {
      if (spawnFailure) throw spawnFailure;
      if (exited) {
        throw sessionError(
          "抖音匿名隔离浏览器已提前关闭。",
          "PUBLIC_MEDIA_BROWSER_CLOSED",
        );
      }
      const result = await client.call("Storage.getCookies");
      const cookies = sanitizeCookies(
        Array.isArray(result.cookies) ? result.cookies : [],
        ["douyin.com", "iesdouyin.com"],
      );
      const hasSessionId = cookies.some((cookie) => cookie.name === "s_v_web_id");
      if (requiresTargetCookies && hasSessionId && !targetOpened) {
        await client.call("Target.createTarget", { url });
        targetOpened = true;
      }
      const hasTargetCookie = cookies.some((cookie) => cookie.name === "ttwid");
      if (hasSessionId && (!requiresTargetCookies || hasTargetCookie)) {
        const userAgent = String(version.userAgent ?? "").trim();
        if (!userAgent || userAgent.length > 1000) {
          throw sessionError(
            "抖音匿名浏览器 User-Agent 无效。",
            "PUBLIC_MEDIA_BROWSER_SESSION_INVALID",
          );
        }
        await client.call("Browser.close").catch(() => {});
        return { cookies, userAgent };
      }
      await wait(800);
    }
    throw sessionError(
      "抖音未能建立匿名公开会话，可稍后安全重试。",
      "PUBLIC_MEDIA_ANONYMOUS_SESSION_TIMEOUT",
    );
  } catch (error) {
    if (error instanceof AnonymousBrowserSessionError) throw error;
    throw sessionError(
      "无法建立抖音匿名公开会话。",
      "PUBLIC_MEDIA_ANONYMOUS_SESSION_FAILED",
      error,
    );
  } finally {
    client?.close();
    if (!exited) child.kill?.();
    await wait(400);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}
