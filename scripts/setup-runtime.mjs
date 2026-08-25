#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { resolveDefaultConfigDir } from "../src/app-config.mjs";
import { installRuntime } from "../src/runtime-manager.mjs";

function parseArguments(args) {
  const result = { components: null, configDir: resolveDefaultConfigDir() };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--config-dir" && value) result.configDir = value;
    else if (argument === "--components" && value) {
      result.components = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    } else throw new Error(`无法识别或缺少参数值：${argument}`);
    index += 1;
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const status = await installRuntime(options.configDir, {
    ...(options.components ? { components: options.components } : {}),
  });
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code ?? "RUNTIME_SETUP_FAILED",
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
