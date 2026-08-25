#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { CaptureError, captureVideo, retryFailure } from "./core.mjs";
import { extractPublicMetadata } from "./content-extractor.mjs";

class UsageError extends Error {}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      throw new UsageError(`无法识别的参数：${key}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`参数 ${key} 缺少值。`);
    }
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function requireOption(options, key) {
  if (!options[key]) {
    throw new UsageError(`缺少必需参数 --${key}。`);
  }
  return options[key];
}

function printHelp() {
  process.stdout.write([
    "视频知识捕手本地 CLI",
    "",
    "采集：",
    "  node src/cli.mjs capture --url <public-url> --inbox <path> [--title <text>] [--transcript <text>] [--note <text>] [--state-dir <path>]",
    "",
    "重试：",
    "  node src/cli.mjs retry --failure-id <id> --inbox <path> [--state-dir <path>]",
    "",
  ].join("\n"));
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return 0;
  }

  const options = parseOptions(args);
  let result;
  if (command === "capture") {
    result = await captureVideo({
      contentExtractor: extractPublicMetadata,
      inboxDir: requireOption(options, "inbox"),
      note: options.note ?? "",
      providedTitle: options.title ?? "",
      stateDir: options["state-dir"],
      transcript: options.transcript ?? "",
      url: requireOption(options, "url"),
    });
  } else if (command === "retry") {
    result = await retryFailure({
      contentExtractor: extractPublicMetadata,
      failureId: requireOption(options, "failure-id"),
      inboxDir: requireOption(options, "inbox"),
      stateDir: options["state-dir"],
    });
  } else {
    throw new UsageError(`未知命令：${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      if (error instanceof UsageError) {
        process.stderr.write(`${JSON.stringify({ error: error.message, code: "USAGE_ERROR" })}\n`);
        process.exitCode = 2;
        return;
      }
      if (error instanceof CaptureError) {
        process.stderr.write(`${JSON.stringify({
          error: error.message,
          code: error.code,
          stage: error.stage,
          retryable: error.retryable,
          failure_id: error.failureId,
        })}\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`${JSON.stringify({ error: "未处理的内部错误", code: "INTERNAL_ERROR" })}\n`);
      process.exitCode = 1;
    });
}
