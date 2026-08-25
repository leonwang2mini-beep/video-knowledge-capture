#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { resolveDefaultConfigDir } from "../src/app-config.mjs";
import { manageWechatCertificate } from "../src/wechat-certificate.mjs";

export async function main(argv = process.argv.slice(2)) {
  const [action, ...args] = argv;
  if (!["install", "uninstall"].includes(action)) {
    throw new Error("用法：node scripts/wechat-certificate.mjs <install|uninstall> [--config-dir <path>]");
  }
  const configIndex = args.indexOf("--config-dir");
  const configDir = configIndex >= 0 ? args[configIndex + 1] : resolveDefaultConfigDir();
  if (configIndex >= 0 && !configDir) throw new Error("--config-dir 缺少值。");
  const result = await manageWechatCertificate(configDir, action);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code ?? "WECHAT_CERTIFICATE_FAILED",
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
