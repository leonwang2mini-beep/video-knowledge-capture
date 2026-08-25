import { spawn } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkDir } from "./app-config.mjs";
import { assertRuntimeReady } from "./runtime-manager.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const certificateScript = path.join(projectRoot, "scripts", "wechat-certificate.ps1");

export class WechatCertificateError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "WechatCertificateError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.stage = "wechat-certificate";
  }
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(command, { spawnImpl = spawn } = {}) {
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawnImpl("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedCommand,
    ], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => { stdout += chunk; });
    child.stderr?.on?.("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stderr, stdout });
      else reject(new Error(stderr.trim() || stdout.trim() || `PowerShell exited ${code}`));
    });
  });
}

function runForExitCode(command, args, { spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function readCertificateThumbprint(candidates) {
  for (const candidate of candidates) {
    try {
      const certificate = new X509Certificate(await readFile(candidate));
      return certificate.fingerprint.replaceAll(":", "");
    } catch {
      // Try the next managed certificate location.
    }
  }
  throw new Error("SunnyRoot.cer is unavailable for postcondition verification.");
}

async function assertCertificatePostcondition(action, thumbprint, options) {
  const [machinePresent, userPresent] = await Promise.all([
    runForExitCode("certutil.exe", ["-store", "Root", thumbprint], options),
    runForExitCode("certutil.exe", ["-user", "-store", "Root", thumbprint], options),
  ]);
  const present = machinePresent || userPresent;
  if ((action === "install" && !present) || (action === "uninstall" && present)) {
    throw new Error(`SunnyNet certificate postcondition failed for ${action}.`);
  }
}

export async function manageWechatCertificate(configDir, action, options = {}) {
  if (process.platform !== "win32") {
    throw new WechatCertificateError(
      "微信证书管理当前仅支持 Windows。",
      "WECHAT_CERTIFICATE_PLATFORM_UNSUPPORTED",
    );
  }
  if (!["install", "uninstall"].includes(action)) {
    throw new WechatCertificateError(
      "微信证书操作无效。",
      "WECHAT_CERTIFICATE_ACTION_INVALID",
    );
  }
  const runtime = await assertRuntimeReady(configDir, ["wxChannel"]);
  const executablePath = runtime.components.wxChannel.path;
  const workRoot = resolveWorkDir(configDir);
  const downloadDirectory = path.join(workRoot, "wechat-downloads");
  const logFile = path.join(path.resolve(configDir), "logs", "wx-channel", "wx_channel.log");
  const resultFile = path.join(
    path.resolve(configDir),
    "state",
    "certificate-actions",
    `${randomUUID()}.json`,
  );
  await mkdir(path.dirname(resultFile), { recursive: true });
  const certificateCandidates = [
    path.join(downloadDirectory, "SunnyRoot.cer"),
    path.join(path.dirname(executablePath), "downloads", "SunnyRoot.cer"),
  ];
  let existingThumbprint = "";
  try {
    existingThumbprint = await readCertificateThumbprint(certificateCandidates);
  } catch {
    if (action === "uninstall") {
      throw new WechatCertificateError(
        "找不到受管 SunnyRoot.cer，无法精确卸载证书。",
        "WECHAT_CERTIFICATE_FILE_MISSING",
      );
    }
  }
  const elevatedCommand = [
    "&",
    quotePowerShell(certificateScript),
    "-Action",
    quotePowerShell(action),
    "-ExecutablePath",
    quotePowerShell(executablePath),
    "-WorkingDirectory",
    quotePowerShell(path.dirname(executablePath)),
    "-DownloadDirectory",
    quotePowerShell(downloadDirectory),
    "-LogFile",
    quotePowerShell(logFile),
    "-ResultFile",
    quotePowerShell(resultFile),
    "-Thumbprint",
    quotePowerShell(existingThumbprint),
  ].join(" ");
  const elevatedEncoded = Buffer.from(elevatedCommand, "utf16le").toString("base64");
  const launcherCommand = [
    "$process = Start-Process",
    "-FilePath powershell.exe",
    `-ArgumentList @('-NoLogo','-NoProfile','-EncodedCommand','${elevatedEncoded}')`,
    "-Verb RunAs -Wait -PassThru;",
    "exit $process.ExitCode",
  ].join(" ");
  let actionError = null;
  try {
    await runPowerShell(launcherCommand, options);
  } catch (error) {
    actionError = error;
  }
  let actionResult = null;
  try {
    actionResult = JSON.parse(await readFile(resultFile, "utf8"));
  } catch {
    actionResult = null;
  }
  await rm(resultFile, { force: true }).catch(() => {});
  try {
    const thumbprint = await readCertificateThumbprint(certificateCandidates);
    await assertCertificatePostcondition(action, thumbprint, options);
  } catch (postconditionError) {
    throw new WechatCertificateError(
      action === "install"
        ? `微信 HTTPS 根证书安装未完成。${actionResult?.message ? ` ${actionResult.message}` : ""}`
        : `微信 HTTPS 根证书卸载未完成。${actionResult?.message ? ` ${actionResult.message}` : ""}`,
      action === "install"
        ? "WECHAT_CERTIFICATE_INSTALL_FAILED"
        : "WECHAT_CERTIFICATE_UNINSTALL_FAILED",
      { cause: actionError ?? postconditionError, retryable: true },
    );
  }
  return { action, status: action === "install" ? "installed" : "uninstalled" };
}
