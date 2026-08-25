import { spawn } from "node:child_process";
import path from "node:path";

export class WindowsCredentialError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "WindowsCredentialError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.stage = "yuanbao-session";
  }
}

const ENTROPY_LABEL = "VideoKnowledgeCapture/Yuanbao/v1";
const MAX_OUTPUT_BYTES = 512 * 1024;

function encodedPowerShell(mode) {
  const operation = mode === "protect"
    ? "$result=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)"
    : "$result=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)";
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$raw=[Console]::In.ReadToEnd().Trim()",
    "$bytes=[Convert]::FromBase64String($raw)",
    `$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY_LABEL}')`,
    operation,
    "[Console]::Out.Write([Convert]::ToBase64String($result))",
  ].join(";");
  return Buffer.from(script, "utf16le").toString("base64");
}

function powershellPath(env = process.env) {
  const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function runDpapi(mode, value, {
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  if (platform !== "win32") {
    throw new WindowsCredentialError(
      "腾讯元宝隔离登录态当前只支持 Windows DPAPI。",
      "YUANBAO_DPAPI_UNSUPPORTED",
    );
  }
  const input = mode === "protect"
    ? Buffer.from(String(value), "utf8").toString("base64")
    : String(value);
  const child = spawnImpl(powershellPath(env), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedPowerShell(mode),
  ], {
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  child.stdout.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    if (Buffer.concat(stderr).length < MAX_OUTPUT_BYTES) stderr.push(chunk);
  });
  child.stdin.end(input);

  let code;
  try {
    code = await exited;
  } catch (error) {
    throw new WindowsCredentialError(
      "无法启动 Windows 登录态保护组件。",
      "YUANBAO_DPAPI_START_FAILED",
      { cause: error },
    );
  }
  if (outputBytes > MAX_OUTPUT_BYTES || code !== 0) {
    const detail = Buffer.concat(stderr).toString("utf8").replace(/\s+/g, " ").trim().slice(0, 300);
    throw new WindowsCredentialError(
      `Windows 登录态保护失败${detail ? `：${detail}` : "。"}`,
      "YUANBAO_DPAPI_FAILED",
    );
  }
  const encoded = Buffer.concat(stdout).toString("utf8").trim();
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0) throw new Error("empty result");
    return mode === "protect" ? encoded : bytes.toString("utf8");
  } catch (error) {
    throw new WindowsCredentialError(
      "Windows 登录态保护组件返回了无效结果。",
      "YUANBAO_DPAPI_INVALID_RESULT",
      { cause: error },
    );
  }
}

export async function protectCredential(value, options = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 * 1024) {
    throw new WindowsCredentialError("待保护的登录态无效。", "YUANBAO_CREDENTIAL_INVALID");
  }
  return runDpapi("protect", value, options);
}

export async function unprotectCredential(value, options = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 * 1024) {
    throw new WindowsCredentialError("受保护的登录态无效。", "YUANBAO_CREDENTIAL_INVALID");
  }
  return runDpapi("unprotect", value, options);
}
