#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveDefaultConfigDir, saveAppConfig } from "../src/app-config.mjs";
import { installRuntime } from "../src/runtime-manager.mjs";
import { COMMUNITY_HOSTS } from "./doctor.mjs";
import { installAgentSkill } from "./install-agent-skill.mjs";
import { installHermesIntegration } from "./install-hermes-integration.mjs";

const CORE_RUNTIME_COMPONENTS = Object.freeze(["ffmpeg", "whisper", "whisperModel", "ytDlp"]);

function expandHosts(host) {
  if (host === "all") return [...COMMUNITY_HOSTS];
  if (!COMMUNITY_HOSTS.includes(host)) {
    throw new Error(`--host must be one of: ${COMMUNITY_HOSTS.join(", ")}, or all.`);
  }
  return [host];
}

export function parseArguments(argv) {
  const options = {
    configDir: resolveDefaultConfigDir(),
    hermesHome: process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"),
    host: null,
    inboxDir: null,
    retainedMediaDir: null,
    skipRuntime: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--host" && value) options.host = value.toLowerCase();
    else if (argument === "--inbox" && value) options.inboxDir = value;
    else if (argument === "--retained-media-dir" && value) options.retainedMediaDir = value;
    else if (argument === "--config-dir" && value) options.configDir = value;
    else if (argument === "--hermes-home" && value) options.hermesHome = value;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  if (!options.host) throw new Error("--host is required.");
  if (!options.inboxDir) throw new Error("--inbox is required.");
  expandHosts(options.host);
  return options;
}

export async function runCommunitySetup({
  host,
  inboxDir,
  retainedMediaDir = null,
  configDir = resolveDefaultConfigDir(),
  hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"),
  skipRuntime = false,
  env = process.env,
  homeDir = os.homedir(),
}, {
  configSaver = saveAppConfig,
  runtimeInstaller = installRuntime,
  agentSkillInstaller = installAgentSkill,
  hermesInstaller = installHermesIntegration,
} = {}) {
  const hosts = expandHosts(host);
  const resolvedConfigDir = path.resolve(configDir);
  if (resolvedConfigDir === path.parse(resolvedConfigDir).root) {
    throw new Error("Config directory cannot be a filesystem root.");
  }
  const config = await configSaver(resolvedConfigDir, {
    inboxDir,
    ...(retainedMediaDir ? { retainedMediaDir } : {}),
  });
  const runtime = skipRuntime
    ? { status: "skipped", reason: "explicit --skip-runtime" }
    : await runtimeInstaller(resolvedConfigDir, { components: [...CORE_RUNTIME_COMPONENTS] });

  const installations = [];
  for (const currentHost of hosts) {
    if (currentHost === "hermes") {
      installations.push({
        host: currentHost,
        ...await hermesInstaller({ hermesHome }),
      });
    } else {
      installations.push({
        host: currentHost,
        ...await agentSkillInstaller({ target: currentHost, env, homeDir }),
      });
    }
  }

  return {
    app: "video-knowledge-capture",
    status: "configured",
    config_dir: resolvedConfigDir,
    inbox_dir: config.inboxDir,
    retained_media_dir: config.retainedMediaDir,
    runtime,
    installations,
    next_actions: [
      "Run start-video-capture.cmd and keep its window open.",
      `Run npm.cmd run doctor -- --host ${host}.`,
      ...(hosts.includes("hermes")
        ? ["Enable the Hermes plugin and authorize the desired message channel explicitly."]
        : []),
    ],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runCommunitySetup(parseArguments(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code || "COMMUNITY_SETUP_FAILED",
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
