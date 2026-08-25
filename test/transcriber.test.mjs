import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseSrt, transcribeMedia } from "../src/transcriber.mjs";

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-transcriber-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("parseSrt preserves timestamped multilingual speech", () => {
  assert.deepEqual(parseSrt([
    "1",
    "00:00:00,250 --> 00:00:02,500",
    "第一句内容。",
    "",
    "2",
    "00:00:02.750 --> 00:01:03,125",
    "Second line",
    "with continuation",
  ].join("\r\n")), [
    { start: 0.25, end: 2.5, text: "第一句内容。" },
    { start: 2.75, end: 63.125, text: "Second line with continuation" },
  ]);
});

test("transcribeMedia orchestrates ffmpeg and whisper without network access", async () => {
  await withTempDirectory(async (root) => {
    const workDir = path.join(root, "work");
    await mkdir(workDir);
    const files = {
      ffmpegPath: path.join(root, "ffmpeg.exe"),
      inputPath: path.join(root, "sample.mp4"),
      modelPath: path.join(root, "ggml-small.bin"),
      whisperPath: path.join(root, "whisper-cli.exe"),
    };
    await Promise.all(Object.values(files).map((filePath) => writeFile(filePath, "fixture")));

    const calls = [];
    const run = async (command, args) => {
      calls.push({ args, command });
      if (command === files.ffmpegPath) {
        await writeFile(args.at(-1), "wav-fixture");
        return { code: 0, stderr: "", stdout: "" };
      }
      const outputPrefix = args[args.indexOf("-of") + 1];
      await writeFile(`${outputPrefix}.srt`, [
        "1",
        "00:00:00,000 --> 00:00:01,500",
        "本地转写测试。",
      ].join("\n"));
      await writeFile(`${outputPrefix}.json`, "{}\n");
      return { code: 0, stderr: "", stdout: "" };
    };

    const result = await transcribeMedia({ ...files, run, workDir });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, files.ffmpegPath);
    assert.ok(calls[0].args.includes("16000"));
    assert.equal(calls[1].command, files.whisperPath);
    assert.ok(calls[1].args.includes("-osrt"));
    assert.equal(result.transcript, "本地转写测试。");
    assert.equal(result.durationSeconds, 1.5);
    assert.deepEqual(result.segments, [
      { start: 0, end: 1.5, text: "本地转写测试。" },
    ]);
    assert.equal(await readFile(result.artifacts.srtPath, "utf8"), [
      "1",
      "00:00:00,000 --> 00:00:01,500",
      "本地转写测试。",
    ].join("\n"));
  });
});
