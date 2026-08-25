import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_PROCESS_OUTPUT = 1024 * 1024;
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;

export class MediaProcessingError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options.cause });
    this.name = "MediaProcessingError";
    this.code = code;
    this.stage = options.stage ?? "transcribe";
    this.retryable = options.retryable ?? true;
  }
}

function processingError(message, code, stage, cause, retryable = true) {
  return new MediaProcessingError(message, code, { cause, retryable, stage });
}

export function runProcess(command, args, {
  cwd,
  timeoutMs = 2 * 60 * 60 * 1000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_PROCESS_OUTPUT) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_PROCESS_OUTPUT) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(processingError("本地媒体处理超时。", "PROCESS_TIMEOUT", "transcribe"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ code, signal, stderr, stdout });
        return;
      }
      const error = new Error(stderr.trim() || stdout.trim() || `process exited ${code}`);
      error.exitCode = code;
      reject(error);
    });
  });
}

function parseTimestamp(value) {
  const match = String(value).trim().match(/^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match;
  return (
    Number(hours) * 3600
    + Number(minutes) * 60
    + Number(seconds)
    + Number(milliseconds) / 1000
  );
}

export function parseSrt(value) {
  const source = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!source) return [];
  const segments = [];
  for (const block of source.split(/\n{2,}/)) {
    const lines = block.split("\n").map((line) => line.trim());
    const timelineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timelineIndex === -1) continue;
    const [startText, endText] = lines[timelineIndex].split("-->").map((part) => part.trim());
    const start = parseTimestamp(startText);
    const end = parseTimestamp(endText);
    const text = lines.slice(timelineIndex + 1).join(" ").replace(/\s+/g, " ").trim();
    if (start === null || end === null || !text) continue;
    segments.push({ start, end, text });
  }
  return segments;
}

async function assertFile(filePath, code, message) {
  let metadata;
  try {
    metadata = await stat(filePath);
  } catch (error) {
    throw processingError(message, code, "prepare-media", error, false);
  }
  if (!metadata.isFile()) {
    throw processingError(message, code, "prepare-media", null, false);
  }
  return metadata;
}

export async function transcribeMedia({
  ffmpegPath,
  inputPath,
  language = "auto",
  modelName = "small-multilingual",
  modelPath,
  run = runProcess,
  whisperPath,
  workDir,
}) {
  for (const [name, value] of Object.entries({
    ffmpegPath,
    inputPath,
    modelPath,
    whisperPath,
    workDir,
  })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw processingError(
        `${name} 必须是绝对路径。`,
        "MEDIA_PATH_INVALID",
        "prepare-media",
        null,
        false,
      );
    }
  }
  const inputMetadata = await assertFile(
    inputPath,
    "MEDIA_SOURCE_MISSING",
    "待转写的媒体文件不存在。",
  );
  if (inputMetadata.size <= 0 || inputMetadata.size > MAX_MEDIA_BYTES) {
    throw processingError(
      "媒体文件为空或超过 4 GiB 限制。",
      "MEDIA_SIZE_INVALID",
      "prepare-media",
      null,
      false,
    );
  }
  await Promise.all([
    assertFile(ffmpegPath, "FFMPEG_MISSING", "FFmpeg 不可用。"),
    assertFile(whisperPath, "WHISPER_MISSING", "whisper.cpp 不可用。"),
    assertFile(modelPath, "WHISPER_MODEL_MISSING", "Whisper 模型不可用。"),
  ]);

  const audioPath = path.join(workDir, "audio.wav");
  const outputPrefix = path.join(workDir, "transcript");
  try {
    await run(ffmpegPath, [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ], { cwd: workDir, timeoutMs: 60 * 60 * 1000 });
  } catch (error) {
    throw processingError(
      "FFmpeg 无法从媒体中提取音频。",
      "AUDIO_EXTRACTION_FAILED",
      "extract-audio",
      error,
    );
  }

  try {
    await run(whisperPath, [
      "-m",
      modelPath,
      "-f",
      audioPath,
      "-l",
      language,
      "-osrt",
      "-ojf",
      "-of",
      outputPrefix,
      "-np",
    ], { cwd: workDir, timeoutMs: 2 * 60 * 60 * 1000 });
  } catch (error) {
    throw processingError(
      "whisper.cpp 本地转写失败。",
      "TRANSCRIPTION_FAILED",
      "transcribe",
      error,
    );
  }

  const srtPath = `${outputPrefix}.srt`;
  let srt;
  try {
    srt = await readFile(srtPath, "utf8");
  } catch (error) {
    throw processingError(
      "转写完成但没有生成 SRT 字幕。",
      "TRANSCRIPT_OUTPUT_MISSING",
      "transcribe",
      error,
    );
  }
  const segments = parseSrt(srt);
  if (segments.length === 0) {
    throw processingError(
      "没有识别到可写入的语音内容。",
      "NO_SPEECH_RECOGNIZED",
      "transcribe",
      null,
      false,
    );
  }
  const transcript = segments.map((segment) => segment.text).join("\n");
  return {
    artifacts: {
      audioPath,
      jsonPath: `${outputPrefix}.json`,
      srtPath,
    },
    durationSeconds: segments.at(-1).end,
    language,
    model: modelName,
    segments,
    transcript,
  };
}
