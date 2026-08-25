#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { resolveDefaultConfigDir } from "../src/app-config.mjs";
import { verifyRuntimeIntegrity } from "../src/runtime-manager.mjs";

export async function main(argv = process.argv.slice(2)) {
  const configIndex = argv.indexOf("--config-dir");
  const configDir = configIndex >= 0 ? argv[configIndex + 1] : resolveDefaultConfigDir();
  if (configIndex >= 0 && !configDir) throw new Error("--config-dir 缺少值。");
  const status = await verifyRuntimeIntegrity(configDir);
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return status.ready ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code ?? "RUNTIME_VERIFY_FAILED",
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
