import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkDir } from "./app-config.mjs";
import { loadRuntimeManifest } from "./runtime-manager.mjs";
import { resolveWechatBufferExecutablePath } from "./wechat-buffer-bridge.mjs";

const ACTIONS = new Set(["install", "status", "uninstall"]);
const DEFAULT_SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/wechat-firewall.ps1", import.meta.url),
);
const MAX_OUTPUT_CHARS = 128 * 1024;

export class WechatFirewallError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "WechatFirewallError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

function firewallError(message, code, cause, retryable = false) {
  return new WechatFirewallError(message, code, { cause, retryable });
}

export async function resolveWechatFirewallTargets(configDir, {
  tempRoot = os.tmpdir(),
} = {}) {
  const resolvedConfigDir = path.resolve(configDir);
  const manifest = await loadRuntimeManifest(resolvedConfigDir);
  const sourceExecutablePath = manifest?.components?.wxChannel?.path;
  if (typeof sourceExecutablePath !== "string" || !path.isAbsolute(sourceExecutablePath)) {
    throw firewallError(
      "微信视频号运行时尚未安装，无法配置本机专用防火墙规则。",
      "WECHAT_FIREWALL_RUNTIME_MISSING",
      null,
      true,
    );
  }
  return {
    managedWorkRoot: resolveWorkDir(resolvedConfigDir),
    patchedExecutablePath: resolveWechatBufferExecutablePath(resolvedConfigDir),
    sourceExecutablePath: path.resolve(sourceExecutablePath),
    tempRoot: path.resolve(tempRoot),
  };
}

export function buildWechatFirewallPowerShellArgs({
  action,
  scriptPath = DEFAULT_SCRIPT_PATH,
  targets,
}) {
  if (!ACTIONS.has(action)) {
    throw firewallError("微信防火墙操作无效。", "WECHAT_FIREWALL_ACTION_INVALID");
  }
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", path.resolve(scriptPath),
    "-Action", action,
    "-PatchedExecutablePath", targets.patchedExecutablePath,
    "-SourceExecutablePath", targets.sourceExecutablePath,
    "-ManagedWorkRoot", targets.managedWorkRoot,
    "-TempRoot", targets.tempRoot,
  ];
}

function runPowerShell(args, {
  spawnImpl = spawn,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("powershell.exe", args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(0, MAX_OUTPUT_CHARS);
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(0, MAX_OUTPUT_CHARS);
    });
    const timer = setTimeout(() => {
      child.kill?.();
      reject(firewallError(
        "配置微信本机专用防火墙规则超时。",
        "WECHAT_FIREWALL_TIMEOUT",
        null,
        true,
      ));
    }, timeoutMs);
    child.once?.("error", (error) => {
      clearTimeout(timer);
      reject(firewallError(
        "无法启动 Windows 防火墙配置程序。",
        "WECHAT_FIREWALL_START_FAILED",
        error,
        true,
      ));
    });
    child.once?.("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(firewallError(
          "Windows 防火墙规则配置失败，请在管理员 PowerShell 中重试。",
          "WECHAT_FIREWALL_COMMAND_FAILED",
          new Error(stderr.trim().slice(0, 2000)),
          true,
        ));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(firewallError(
          "Windows 防火墙配置程序返回了无效结果。",
          "WECHAT_FIREWALL_RESULT_INVALID",
          error,
        ));
      }
    });
  });
}

export async function manageWechatFirewall(configDir, action, options = {}) {
  if (process.platform !== "win32") {
    throw firewallError(
      "微信本机专用防火墙规则仅支持 Windows。",
      "WECHAT_FIREWALL_PLATFORM_UNSUPPORTED",
    );
  }
  const targets = await resolveWechatFirewallTargets(configDir, options);
  const args = buildWechatFirewallPowerShellArgs({
    action,
    scriptPath: options.scriptPath,
    targets,
  });
  return runPowerShell(args, options);
}
