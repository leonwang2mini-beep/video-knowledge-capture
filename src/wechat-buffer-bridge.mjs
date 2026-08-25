import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { resolveWorkDir } from "./app-config.mjs";
import { assertRuntimeIntegrity } from "./runtime-manager.mjs";

const CACHE_MONITOR_MARKER = Buffer.from(
  "<script>\n\t// 初始化视频缓存监控",
  "utf8",
);
const SCRIPT_CLOSING_TAG = Buffer.from("</script>", "utf8");

export class WechatBufferBridgeError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "WechatBufferBridgeError";
    this.code = code;
    this.stage = options.stage ?? "prepare-wechat-buffer";
    this.retryable = options.retryable ?? false;
  }
}

function bridgeError(message, code, cause, retryable = false) {
  return new WechatBufferBridgeError(message, code, { cause, retryable });
}

function digestBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function validateRunId(runId) {
  if (typeof runId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(runId)) {
    throw bridgeError("微信缓冲捕获运行标识无效。", "WECHAT_BUFFER_RUN_ID_INVALID");
  }
  return runId;
}

export function buildWechatBufferCaptureScript(runId) {
  const safeRunId = validateRunId(runId);
  const encodedRunId = JSON.stringify(safeRunId);
  return `<script>
(function installP0004BufferCapture() {
  if (window.__p0004_buffer_capture_installed__) return;
  window.__p0004_buffer_capture_installed__ = true;
  const runId = ${encodedRunId};
  const maxBuffers = 6;
  const chunkBytes = 1024 * 1024;
  let bufferCounter = 0;
  const statesByBuffer = new WeakMap();
  const statesByMediaSource = new WeakMap();
  const activeStates = new Set();

  const extensionFor = (mime) => /webm/i.test(mime) ? '.webm' : '.mp4';
  const safeMime = (mime) => String(mime || 'unknown').replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
  const initialize = async (state) => {
    if (state.uploadId) return state.uploadId;
    const response = await fetch('/__wx_channels_api/init_upload', {method: 'POST'});
    const payload = await response.json();
    if (!payload || !payload.uploadId) throw new Error('capture-init-failed');
    state.uploadId = payload.uploadId;
    return state.uploadId;
  };
  const uploadPart = async (state, bytes) => {
    const uploadId = await initialize(state);
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      const piece = bytes.slice(offset, Math.min(offset + chunkBytes, bytes.byteLength));
      const form = new FormData();
      form.append('uploadId', uploadId);
      form.append('index', String(state.parts));
      form.append('total', '1000000');
      form.append('size', String(piece.byteLength));
      form.append('chunk', new Blob([piece], {type: 'application/octet-stream'}), 'capture.part');
      const response = await fetch('/__wx_channels_api/upload_chunk', {method: 'POST', body: form});
      if (!response.ok) throw new Error('capture-chunk-failed');
      state.parts += 1;
    }
  };
  const finalize = (state) => {
    if (!state || state.finalized || state.parts === 0) return;
    state.finalized = true;
    state.queue = state.queue.then(async () => {
      const uploadId = await initialize(state);
      const filename = 'p0004-' + runId + '-buffer-' + state.index + '-' + safeMime(state.mime) + extensionFor(state.mime);
      const response = await fetch('/__wx_channels_api/complete_upload', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({uploadId, total: state.parts, filename, authorName: 'p0004-capture-' + runId})
      });
      if (!response.ok) throw new Error('capture-complete-failed');
      activeStates.delete(state);
    }).catch(() => {});
  };
  const finalizeAll = () => Array.from(activeStates).forEach(finalize);

  try {
    if (typeof MediaSource === 'undefined' || typeof SourceBuffer === 'undefined') return;
    const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function(mime) {
      const sourceBuffer = originalAddSourceBuffer.call(this, mime);
      if (bufferCounter >= maxBuffers) return sourceBuffer;
      const state = {index: ++bufferCounter, mime: String(mime || 'unknown'), parts: 0, uploadId: null, finalized: false, queue: Promise.resolve()};
      statesByBuffer.set(sourceBuffer, state);
      const mediaStates = statesByMediaSource.get(this) || [];
      mediaStates.push(state);
      statesByMediaSource.set(this, mediaStates);
      activeStates.add(state);
      return sourceBuffer;
    };
    const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function(buffer) {
      const state = statesByBuffer.get(this);
      if (state && !state.finalized && buffer) {
        const view = ArrayBuffer.isView(buffer)
          ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
          : new Uint8Array(buffer);
        const copy = new Uint8Array(view);
        state.queue = state.queue.then(() => uploadPart(state, copy)).catch(() => {});
      }
      return originalAppendBuffer.call(this, buffer);
    };
    const originalEndOfStream = MediaSource.prototype.endOfStream;
    MediaSource.prototype.endOfStream = function() {
      const states = statesByMediaSource.get(this) || [];
      const result = originalEndOfStream.apply(this, arguments);
      states.forEach(finalize);
      return result;
    };
    document.addEventListener('ended', (event) => {
      if (event && event.target && event.target.tagName === 'VIDEO') finalizeAll();
    }, true);
    setInterval(() => {
      const videos = Array.from(document.querySelectorAll('video'));
      if (videos.some((video) => Number.isFinite(video.duration) && video.duration > 0 && (video.ended || video.currentTime >= video.duration - 0.25))) {
        finalizeAll();
      }
    }, 1000);
  } catch (_) {}
})();
</script>`;
}

export function patchWechatRuntimeBuffer(binary, replacementScript) {
  if (!Buffer.isBuffer(binary)) {
    throw bridgeError("微信运行时补丁输入必须是二进制缓冲区。", "WECHAT_BUFFER_PATCH_INPUT_INVALID");
  }
  const replacement = Buffer.from(replacementScript, "utf8");
  const start = binary.indexOf(CACHE_MONITOR_MARKER);
  if (start < 0) {
    throw bridgeError(
      "当前微信 sidecar 版本不包含已验收的缓存脚本标记，已拒绝补丁。",
      "WECHAT_BUFFER_PATCH_MARKER_MISSING",
    );
  }
  if (binary.indexOf(CACHE_MONITOR_MARKER, start + CACHE_MONITOR_MARKER.length) >= 0) {
    throw bridgeError(
      "当前微信 sidecar 包含多个缓存脚本标记，已拒绝补丁。",
      "WECHAT_BUFFER_PATCH_MARKER_AMBIGUOUS",
    );
  }
  const closingStart = binary.indexOf(SCRIPT_CLOSING_TAG, start);
  if (closingStart < 0) {
    throw bridgeError(
      "当前微信 sidecar 的缓存脚本不完整，已拒绝补丁。",
      "WECHAT_BUFFER_PATCH_TERMINATOR_MISSING",
    );
  }
  const slotLength = closingStart + SCRIPT_CLOSING_TAG.length - start;
  if (replacement.length > slotLength) {
    throw bridgeError(
      "微信缓冲捕获脚本超过已验证槽位，已拒绝补丁。",
      "WECHAT_BUFFER_PATCH_TOO_LARGE",
    );
  }

  const patched = Buffer.from(binary);
  replacement.copy(patched, start);
  patched.fill(0x20, start + replacement.length, start + slotLength);
  return {
    binary: patched,
    patchedOffset: start,
    replacementLength: replacement.length,
    slotLength,
  };
}

function isolatedConfig() {
  return [
    "port: 2025",
    "download_dir: downloads",
    "log_file: wx_channel.log",
    "log_max_mb: 20",
    "cloud_enabled: false",
    'cloud_hub_url: ""',
    'cloud_secret: ""',
    "radar_enabled: false",
    "metrics_enabled: false",
    "save_page_snapshot: false",
    "save_search_data: false",
    "save_page_js: false",
    "show_log_button: false",
    "enable_log_interception: false",
    "",
  ].join("\n");
}

export async function prepareWechatBufferRuntime(configDir, {
  runId = randomUUID(),
} = {}) {
  const safeRunId = validateRunId(runId);
  const runtime = await assertRuntimeIntegrity(configDir, ["wxChannel"]);
  const sourcePath = runtime.components.wxChannel.path;
  const sourceBinary = await readFile(sourcePath);
  const sourceDigest = digestBuffer(sourceBinary);
  const replacementScript = buildWechatBufferCaptureScript(safeRunId);
  const patch = patchWechatRuntimeBuffer(sourceBinary, replacementScript);
  const runRoot = path.join(resolveWorkDir(configDir), "wx-channel-buffer", safeRunId);
  const executablePath = path.join(runRoot, "wx_channel.exe");
  const configPath = path.join(runRoot, "config.yaml");
  await mkdir(path.dirname(runRoot), { recursive: true });
  await mkdir(runRoot, { recursive: false });

  let executableHandle;
  try {
    executableHandle = await open(executablePath, "wx");
    await executableHandle.writeFile(patch.binary);
    await executableHandle.sync();
    await executableHandle.close();
    executableHandle = undefined;
    await writeFile(configPath, isolatedConfig(), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    await executableHandle?.close().catch(() => {});
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});
    throw bridgeError(
      "无法创建隔离的微信缓冲捕获运行时。",
      "WECHAT_BUFFER_RUNTIME_CREATE_FAILED",
      error,
      true,
    );
  }

  const sourceAfter = await readFile(sourcePath);
  if (digestBuffer(sourceAfter) !== sourceDigest) {
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});
    throw bridgeError(
      "微信 sidecar 原始运行时在创建兼容副本期间发生变化，已中止。",
      "WECHAT_BUFFER_SOURCE_CHANGED",
    );
  }

  return {
    captureDir: path.join(runRoot, "downloads", `p0004-capture-${safeRunId}`),
    downloadDir: path.join(runRoot, "downloads"),
    executablePath,
    patchedDigest: digestBuffer(patch.binary),
    runId: safeRunId,
    runRoot,
    sourceDigest,
  };
}
