import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { resolveWorkDir } from "./app-config.mjs";
import { protectCredential, unprotectCredential } from "./windows-credential.mjs";

const LOGIN_URL = "https://yuanbao.tencent.com/";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export class YuanbaoSessionError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "YuanbaoSessionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.stage = options.stage ?? "yuanbao-session";
  }
}

function sessionError(message, code, options = {}) {
  return new YuanbaoSessionError(message, code, options);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function candidateBrowserPaths(env = process.env) {
  return [
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
}

export async function findChromiumBrowser({ env = process.env } = {}) {
  for (const candidate of candidateBrowserPaths(env)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the explicit Windows install locations.
    }
  }
  throw sessionError(
    "未找到 Microsoft Edge 或 Google Chrome，无法启动腾讯元宝隔离登录窗口。",
    "YUANBAO_BROWSER_NOT_FOUND",
  );
}

class CdpClient {
  constructor(url, { WebSocketImpl = globalThis.WebSocket } = {}) {
    if (typeof WebSocketImpl !== "function") {
      throw sessionError(
        "当前 Node.js 缺少浏览器控制能力，请使用项目已验证的 Node.js 24。",
        "YUANBAO_BROWSER_RUNTIME_UNSUPPORTED",
      );
    }
    this.socket = new WebSocketImpl(url);
    this.pending = new Map();
    this.nextId = 1;
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(sessionError(
        "无法连接隔离浏览器控制端口。",
        "YUANBAO_BROWSER_CONTROL_FAILED",
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
          "隔离浏览器未能读取腾讯元宝登录状态。",
          "YUANBAO_BROWSER_CONTROL_FAILED",
        ));
      } else {
        pending.resolve(payload.result ?? {});
      }
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(sessionError(
          "腾讯元宝隔离登录窗口已关闭。",
          "YUANBAO_LOGIN_WINDOW_CLOSED",
          { retryable: true },
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
          "隔离浏览器响应超时。",
          "YUANBAO_BROWSER_CONTROL_TIMEOUT",
          { retryable: true },
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

async function readDevToolsPort(profileDir, { signal, timeoutMs = 20000 } = {}) {
  const filePath = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw sessionError("腾讯元宝登录已取消。", "YUANBAO_LOGIN_CANCELLED", { retryable: true });
    }
    try {
      const [portLine, browserPath] = (await readFile(filePath, "utf8")).trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && browserPath?.startsWith("/devtools/browser/")) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    } catch {
      // Edge creates the file after its isolated profile is ready.
    }
    await wait(200);
  }
  throw sessionError(
    "腾讯元宝隔离浏览器未能在限定时间内启动。",
    "YUANBAO_BROWSER_START_TIMEOUT",
    { retryable: true },
  );
}

function cookieAppliesToHost(cookie, host) {
  const domain = String(cookie?.domain ?? "").replace(/^\./, "").toLowerCase();
  return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
}

export async function captureYuanbaoCookie({
  browserPath,
  profileDir,
  signal,
  spawnImpl = spawn,
  timeoutMs = LOGIN_TIMEOUT_MS,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  if (!browserPath || !profileDir) {
    throw sessionError("隔离浏览器参数无效。", "YUANBAO_BROWSER_INPUT_INVALID");
  }
  await mkdir(profileDir, { recursive: true });
  const child = spawnImpl(browserPath, [
    `--user-data-dir=${profileDir}`,
    "--profile-directory=Default",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=msEdgeFirstRunExperience",
    `--app=${LOGIN_URL}`,
  ], {
    cwd: path.dirname(browserPath),
    env: process.env,
    shell: false,
    stdio: "ignore",
    windowsHide: false,
  });
  let exited = false;
  let spawnFailure = null;
  child.once("exit", () => { exited = true; });
  child.once("error", (error) => { spawnFailure = error; });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  let client;
  try {
    const websocketUrl = await readDevToolsPort(profileDir, { signal });
    if (spawnFailure) throw spawnFailure;
    client = new CdpClient(websocketUrl, { WebSocketImpl });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw sessionError("腾讯元宝登录已取消。", "YUANBAO_LOGIN_CANCELLED", { retryable: true });
      }
      if (exited) {
        throw sessionError(
          "腾讯元宝隔离登录窗口已关闭，请重新开始登录。",
          "YUANBAO_LOGIN_WINDOW_CLOSED",
          { retryable: true },
        );
      }
      const result = await client.call("Storage.getCookies");
      const cookies = Array.isArray(result.cookies)
        ? result.cookies.filter((cookie) => cookieAppliesToHost(cookie, "yuanbao.tencent.com"))
        : [];
      if (cookies.some((cookie) => cookie.name === "hy_token" && cookie.value)) {
        const cookieHeader = cookies
          .filter((cookie) => cookie.name && cookie.value)
          .sort((left, right) => String(right.path ?? "").length - String(left.path ?? "").length)
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; ");
        if (cookieHeader.length === 0 || cookieHeader.length > 128 * 1024) {
          throw sessionError("腾讯元宝登录态长度异常。", "YUANBAO_CREDENTIAL_INVALID");
        }
        await client.call("Browser.close").catch(() => {});
        return cookieHeader;
      }
      await wait(1200);
    }
    throw sessionError(
      "等待腾讯元宝扫码登录超时，请重新开始登录。",
      "YUANBAO_LOGIN_TIMEOUT",
      { retryable: true },
    );
  } catch (error) {
    if (spawnFailure && !(error instanceof YuanbaoSessionError)) {
      throw sessionError(
        "无法启动腾讯元宝隔离登录窗口。",
        "YUANBAO_BROWSER_START_FAILED",
        { cause: spawnFailure, retryable: true },
      );
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    client?.close();
    if (!exited) child.kill();
  }
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export class YuanbaoSessionService {
  constructor(configDir, {
    browserFinder = findChromiumBrowser,
    cookieCapture = captureYuanbaoCookie,
    protect = protectCredential,
    unprotect = unprotectCredential,
  } = {}) {
    this.configDir = path.resolve(configDir);
    this.loginRoot = path.join(resolveWorkDir(this.configDir), "yuanbao-login");
    this.sessionPath = path.join(this.configDir, "secrets", "yuanbao-session.json");
    this.browserFinder = browserFinder;
    this.cookieCapture = cookieCapture;
    this.protect = protect;
    this.unprotect = unprotect;
    this.controller = null;
    this.activePromise = null;
    this.state = "idle";
    this.error = null;
    this.startedAt = null;
    this.updatedAt = null;
  }

  async hasSession() {
    try {
      await access(this.sessionPath);
      return true;
    } catch {
      return false;
    }
  }

  async status() {
    return {
      configured: await this.hasSession(),
      error: this.error,
      startedAt: this.startedAt,
      state: this.state,
      updatedAt: this.updatedAt,
    };
  }

  async startLogin({ timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
    if (this.activePromise) {
      throw sessionError(
        "腾讯元宝隔离登录已经在进行中。",
        "YUANBAO_LOGIN_ALREADY_RUNNING",
        { retryable: true },
      );
    }
    const browserPath = await this.browserFinder();
    const profileDir = path.join(this.loginRoot, randomUUID());
    if (!isInside(this.loginRoot, profileDir)) {
      throw sessionError("隔离登录目录越界。", "YUANBAO_LOGIN_PATH_INVALID");
    }
    this.controller = new AbortController();
    this.state = "waiting-for-login";
    this.error = null;
    this.startedAt = new Date().toISOString();
    this.updatedAt = this.startedAt;
    this.activePromise = this.cookieCapture({
      browserPath,
      profileDir,
      signal: this.controller.signal,
      timeoutMs,
    }).then(async (cookieHeader) => {
      const protectedValue = await this.protect(cookieHeader);
      await atomicWriteJson(this.sessionPath, {
        createdAt: new Date().toISOString(),
        protectedValue,
        protection: "windows-dpapi-current-user",
        schemaVersion: 1,
      });
      this.state = "ready";
      this.error = null;
      this.updatedAt = new Date().toISOString();
    }).catch((error) => {
      this.state = error?.code === "YUANBAO_LOGIN_CANCELLED" ? "cancelled" : "failed";
      this.error = {
        code: error?.code ?? "YUANBAO_LOGIN_FAILED",
        message: String(error?.message ?? "腾讯元宝登录失败。").slice(0, 500),
        retryable: error?.retryable !== false,
      };
      this.updatedAt = new Date().toISOString();
    }).finally(async () => {
      if (isInside(this.loginRoot, profileDir)) {
        await rm(profileDir, { recursive: true, force: true }).catch(() => {});
      }
      this.controller = null;
      this.activePromise = null;
    });
    return this.status();
  }

  async cancelLogin() {
    if (!this.controller) return this.status();
    this.controller.abort();
    await this.activePromise?.catch(() => {});
    return this.status();
  }

  async loadCookie() {
    let record;
    try {
      record = JSON.parse(await readFile(this.sessionPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw sessionError(
          "请先在隔离窗口中登录腾讯元宝。",
          "YUANBAO_LOGIN_REQUIRED",
          { retryable: true },
        );
      }
      throw sessionError(
        "腾讯元宝加密登录态无法读取。",
        "YUANBAO_SESSION_INVALID",
        { cause: error },
      );
    }
    if (
      record?.schemaVersion !== 1
      || record?.protection !== "windows-dpapi-current-user"
      || typeof record?.protectedValue !== "string"
    ) {
      throw sessionError("腾讯元宝加密登录态格式无效。", "YUANBAO_SESSION_INVALID");
    }
    const cookie = await this.unprotect(record.protectedValue);
    if (!/(?:^|;\s*)hy_token=/.test(cookie)) {
      throw sessionError("腾讯元宝登录态缺少有效授权。", "YUANBAO_SESSION_INVALID");
    }
    return cookie;
  }

  async forget() {
    if (this.activePromise) {
      throw sessionError(
        "请先取消正在进行的腾讯元宝登录。",
        "YUANBAO_LOGIN_ALREADY_RUNNING",
        { retryable: true },
      );
    }
    await unlink(this.sessionPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    this.state = "idle";
    this.error = null;
    this.updatedAt = new Date().toISOString();
    return this.status();
  }

  async close() {
    await this.cancelLogin();
  }
}
