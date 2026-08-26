#!/usr/bin/env node

import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  resolveDefaultConfigDir,
  resolveWorkDir,
} from "../src/app-config.mjs";
import { prepareWechatBufferRuntime } from "../src/wechat-buffer-bridge.mjs";
import { manageWechatFirewall } from "../src/wechat-firewall.mjs";

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function main(argv = process.argv.slice(2)) {
  const [action, ...args] = argv;
  if (!["install", "status", "uninstall"].includes(action)) {
    throw new Error(
      "用法：node scripts/wechat-firewall.mjs <install|status|uninstall> [--config-dir <path>]",
    );
  }
  const configIndex = args.indexOf("--config-dir");
  const configDir = configIndex >= 0 ? args[configIndex + 1] : resolveDefaultConfigDir();
  if (configIndex >= 0 && !configDir) throw new Error("--config-dir 缺少值。");

  if (action === "install") {
    const prepared = await prepareWechatBufferRuntime(configDir, {
      runId: "firewall-bootstrap-runtime",
    });
    const workRoot = resolveWorkDir(configDir);
    if (!isInside(workRoot, prepared.runRoot)) {
      throw new Error("防火墙初始化目录越界。");
    }
    await rm(prepared.runRoot, { recursive: true, force: true });
  }

  const result = await manageWechatFirewall(configDir, action);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code ?? "WECHAT_FIREWALL_FAILED",
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
