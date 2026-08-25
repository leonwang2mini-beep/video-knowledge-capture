import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { resolveRuntimeDir } from "./app-config.mjs";

const MANIFEST_FILE = "runtime-manifest.json";

export const RUNTIME_COMPONENTS = Object.freeze({
  ytDlp: {
    archiveName: "yt-dlp.exe",
    digest: "52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8",
    digestAlgorithm: "sha256",
    executable: "yt-dlp.exe",
    kind: "file",
    license: "Unlicense; bundled executable includes third-party licenses",
    source: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe",
    version: "2026.07.04",
  },
  ffmpeg: {
    archiveName: "ffmpeg-8.1.2-essentials_build.zip",
    digest: "db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec",
    digestAlgorithm: "sha256",
    executable: "ffmpeg.exe",
    kind: "zip",
    license: "GPL-3.0",
    source: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip",
    version: "8.1.2",
  },
  whisper: {
    archiveName: "whisper-bin-x64.zip",
    digest: "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a",
    digestAlgorithm: "sha256",
    executable: "whisper-cli.exe",
    kind: "zip",
    license: "MIT",
    source: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip",
    version: "1.9.2",
  },
  whisperModel: {
    archiveName: "ggml-small.bin",
    digest: "55356645c2b361a969dfd0ef2c5a50d530afd8d5",
    digestAlgorithm: "sha1",
    executable: "ggml-small.bin",
    kind: "file",
    license: "MIT model distribution; upstream Whisper model terms apply",
    source: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    version: "small-multilingual",
  },
  wxChannel: {
    archiveName: "wx_channel_v5.7.1.zip",
    digest: "c17370359bb31b040e7cb527c83ad9d1d0174f90c1205f120ef36aeec2b4178b",
    digestAlgorithm: "sha256",
    executable: "wx_channel.exe",
    kind: "zip",
    license: "MIT",
    source: "https://github.com/nobiyou/wx_channel/releases/download/v5.7.1/wx_channel_v5.7.1.zip",
    version: "5.7.1",
  },
});

export class RuntimeError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "RuntimeError";
    this.code = code;
    this.component = options.component ?? null;
    this.retryable = options.retryable ?? false;
  }
}

function runtimeError(message, code, component, cause, retryable = false) {
  return new RuntimeError(message, code, { cause, component, retryable });
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

async function downloadAndVerify(componentName, component, destination, {
  fetchImpl = fetch,
} = {}) {
  const temporaryPath = `${destination}.${process.pid}-${randomUUID()}.download`;
  await mkdir(path.dirname(destination), { recursive: true });

  let response;
  try {
    response = await fetchImpl(component.source, {
      headers: { "User-Agent": "P0004-VideoKnowledgeCapture/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
  } catch (error) {
    throw runtimeError(
      `${componentName} 下载连接失败。`,
      "RUNTIME_DOWNLOAD_FAILED",
      componentName,
      error,
      true,
    );
  }
  if (!response.ok || !response.body) {
    throw runtimeError(
      `${componentName} 下载返回 HTTP ${response.status}。`,
      "RUNTIME_DOWNLOAD_FAILED",
      componentName,
      null,
      true,
    );
  }

  const digest = createHash(component.digestAlgorithm);
  let handle;
  try {
    handle = await open(temporaryPath, "wx");
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      digest.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw runtimeError(
      `${componentName} 下载文件无法保存。`,
      "RUNTIME_DOWNLOAD_WRITE_FAILED",
      componentName,
      error,
      true,
    );
  }

  const actualDigest = digest.digest("hex");
  if (actualDigest.toLowerCase() !== component.digest.toLowerCase()) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw runtimeError(
      `${componentName} 哈希校验失败，已拒绝安装。`,
      "RUNTIME_DIGEST_MISMATCH",
      componentName,
    );
  }
  await rm(destination, { force: true }).catch(() => {});
  await rename(temporaryPath, destination);
  return actualDigest;
}

async function digestFile(filePath, algorithm = "sha256") {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

function runCommand(command, args, { cwd, timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 20000) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(runtimeError("解压运行超时。", "RUNTIME_EXTRACT_TIMEOUT", null));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `tar exited ${code}`));
    });
  });
}

async function findNamedFile(root, fileName, depth = 0) {
  if (depth > 8) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return candidate;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findNamedFile(path.join(root, entry.name), fileName, depth + 1);
    if (found) return found;
  }
  return null;
}

async function installOne(componentName, component, runtimeDir, options) {
  const componentDir = path.join(runtimeDir, componentName);
  const archiveDir = path.join(runtimeDir, "downloads");
  const archivePath = path.join(archiveDir, component.archiveName);
  await downloadAndVerify(componentName, component, archivePath, options);

  if (component.kind === "file") {
    await mkdir(componentDir, { recursive: true });
    const finalPath = path.join(componentDir, component.executable);
    await rm(finalPath, { force: true }).catch(() => {});
    await rename(archivePath, finalPath);
    return {
      fileDigest: component.digest,
      fileDigestAlgorithm: component.digestAlgorithm,
      path: finalPath,
    };
  }

  const extractDir = `${componentDir}.extract-${process.pid}-${randomUUID()}`;
  await mkdir(extractDir, { recursive: true });
  try {
    await runCommand(process.platform === "win32" ? "tar.exe" : "tar", [
      "-xf",
      archivePath,
      "-C",
      extractDir,
    ]);
    const executable = await findNamedFile(extractDir, component.executable);
    if (!executable) {
      throw runtimeError(
        `${componentName} 压缩包中没有 ${component.executable}。`,
        "RUNTIME_EXECUTABLE_MISSING",
        componentName,
      );
    }
    await rm(componentDir, { recursive: true, force: true });
    await rename(extractDir, componentDir);
    const relativeExecutable = path.relative(extractDir, executable);
    const finalPath = path.join(componentDir, relativeExecutable);
    return {
      fileDigest: await digestFile(finalPath),
      fileDigestAlgorithm: "sha256",
      path: finalPath,
    };
  } catch (error) {
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof RuntimeError) throw error;
    throw runtimeError(
      `${componentName} 解压失败。`,
      "RUNTIME_EXTRACT_FAILED",
      componentName,
      error,
      true,
    );
  } finally {
    await rm(archivePath, { force: true }).catch(() => {});
  }
}

export async function loadRuntimeManifest(configDir) {
  const manifestPath = path.join(resolveRuntimeDir(configDir), MANIFEST_FILE);
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw runtimeError("运行时清单无法读取。", "RUNTIME_MANIFEST_INVALID", null, error);
  }
}

export async function getRuntimeStatus(configDir) {
  const runtimeDir = resolveRuntimeDir(configDir);
  const manifest = await loadRuntimeManifest(configDir);
  const components = {};
  for (const [name, specification] of Object.entries(RUNTIME_COMPONENTS)) {
    const installed = manifest?.components?.[name] ?? null;
    const executablePath = installed?.path ? path.resolve(installed.path) : null;
    let ready = false;
    if (executablePath) {
      try {
        const metadata = await stat(executablePath);
        ready = metadata.isFile();
      } catch {
        ready = false;
      }
    }
    components[name] = {
      digest: specification.digest,
      path: ready ? executablePath : null,
      ready,
      version: specification.version,
    };
  }
  return {
    components,
    ready: Object.values(components).every((entry) => entry.ready),
    runtimeDir,
  };
}

export async function installRuntime(configDir, {
  components = Object.keys(RUNTIME_COMPONENTS),
  fetchImpl = fetch,
} = {}) {
  if (process.platform !== "win32") {
    throw runtimeError("V1.0 运行时安装器当前仅支持 Windows。", "RUNTIME_PLATFORM_UNSUPPORTED");
  }
  const invalid = components.find((name) => !RUNTIME_COMPONENTS[name]);
  if (invalid) {
    throw runtimeError(`未知运行时组件：${invalid}`, "RUNTIME_COMPONENT_UNKNOWN", invalid);
  }
  const runtimeDir = resolveRuntimeDir(configDir);
  await mkdir(runtimeDir, { recursive: true });
  const previous = await loadRuntimeManifest(configDir);
  const installed = { ...(previous?.components ?? {}) };

  for (const componentName of components) {
    const specification = RUNTIME_COMPONENTS[componentName];
    const installedFile = await installOne(
      componentName,
      specification,
      runtimeDir,
      { fetchImpl },
    );
    installed[componentName] = {
      digest: specification.digest,
      digestAlgorithm: specification.digestAlgorithm,
      fileDigest: installedFile.fileDigest,
      fileDigestAlgorithm: installedFile.fileDigestAlgorithm,
      installedAt: new Date().toISOString(),
      license: specification.license,
      path: installedFile.path,
      source: specification.source,
      version: specification.version,
    };
  }

  await atomicWriteJson(path.join(runtimeDir, MANIFEST_FILE), {
    schemaVersion: 1,
    components: installed,
    updatedAt: new Date().toISOString(),
  });
  return getRuntimeStatus(configDir);
}

export async function verifyRuntimeIntegrity(configDir) {
  const status = await getRuntimeStatus(configDir);
  const manifest = await loadRuntimeManifest(configDir);
  const components = {};
  for (const [name, componentStatus] of Object.entries(status.components)) {
    const installed = manifest?.components?.[name];
    if (!componentStatus.ready || !installed?.fileDigest || !installed?.fileDigestAlgorithm) {
      components[name] = { ...componentStatus, integrity: "missing" };
      continue;
    }
    const actualDigest = await digestFile(componentStatus.path, installed.fileDigestAlgorithm);
    components[name] = {
      ...componentStatus,
      integrity: actualDigest.toLowerCase() === installed.fileDigest.toLowerCase()
        ? "verified"
        : "mismatch",
    };
  }
  return {
    components,
    ready: Object.values(components).every((entry) => (
      entry.ready && entry.integrity === "verified"
    )),
    runtimeDir: status.runtimeDir,
  };
}

export async function assertRuntimeReady(configDir, required = [
  "ffmpeg",
  "whisper",
  "whisperModel",
]) {
  const status = await getRuntimeStatus(configDir);
  const missing = required.filter((name) => !status.components[name]?.ready);
  if (missing.length > 0) {
    throw runtimeError(
      `缺少本地运行时：${missing.join(", ")}。请先安装内容处理组件。`,
      "RUNTIME_NOT_READY",
      missing[0],
      null,
      true,
    );
  }
  return status;
}

export async function assertRuntimeIntegrity(configDir, required = [
  "ffmpeg",
  "whisper",
  "whisperModel",
]) {
  const status = await getRuntimeStatus(configDir);
  const manifest = await loadRuntimeManifest(configDir);
  const missing = required.filter((name) => !status.components[name]?.ready);
  if (missing.length > 0) {
    throw runtimeError(
      `缺少本地运行时：${missing.join(", ")}。请先安装内容处理组件。`,
      "RUNTIME_NOT_READY",
      missing[0],
      null,
      true,
    );
  }

  const components = { ...status.components };
  for (const name of required) {
    const installed = manifest?.components?.[name];
    if (!installed?.fileDigest || !installed?.fileDigestAlgorithm) {
      throw runtimeError(
        `${name} 缺少安装后完整性摘要，已拒绝执行。`,
        "RUNTIME_INTEGRITY_MISSING",
        name,
      );
    }
    const actualDigest = await digestFile(
      status.components[name].path,
      installed.fileDigestAlgorithm,
    );
    if (actualDigest.toLowerCase() !== installed.fileDigest.toLowerCase()) {
      throw runtimeError(
        `${name} 的运行时文件完整性校验失败，已拒绝执行。`,
        "RUNTIME_INTEGRITY_MISMATCH",
        name,
      );
    }
    components[name] = {
      ...components[name],
      integrity: "verified",
    };
  }
  return {
    components,
    ready: true,
    runtimeDir: status.runtimeDir,
  };
}
