import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exactSyncFiles } from "./lib/managed-file-sync.mjs";


const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const declaredFiles = [
  ["integrations/hermes/plugin/video-knowledge-capture/plugin.yaml", "plugins/video-knowledge-capture/plugin.yaml"],
  ["integrations/hermes/plugin/video-knowledge-capture/__init__.py", "plugins/video-knowledge-capture/__init__.py"],
  ["integrations/hermes/plugin/video-knowledge-capture/client.py", "plugins/video-knowledge-capture/client.py"],
  ["skills/video-knowledge-capture/SKILL.md", "skills/video-knowledge-capture/SKILL.md"],
  ["skills/video-knowledge-capture/agents/openai.yaml", "skills/video-knowledge-capture/agents/openai.yaml"],
  ["skills/video-knowledge-capture/references/host-setup.md", "skills/video-knowledge-capture/references/host-setup.md"],
];

function parseArguments(argv) {
  const options = { hermesHome: process.env.HERMES_HOME || path.join(os.homedir(), ".hermes") };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--hermes-home" || !argv[index + 1]) {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    }
    options.hermesHome = argv[index + 1];
    index += 1;
  }
  return options;
}

export async function installHermesIntegration({ hermesHome }) {
  const resolvedHome = path.resolve(hermesHome);
  if (resolvedHome === path.parse(resolvedHome).root) {
    throw new Error("Hermes home cannot be a filesystem root.");
  }
  const managedRoots = [
    path.join(resolvedHome, "plugins", "video-knowledge-capture"),
    path.join(resolvedHome, "skills", "video-knowledge-capture"),
  ];
  const files = declaredFiles.map(([sourceRelative, targetRelative]) => ({
    source: path.join(projectRoot, ...sourceRelative.split("/")),
    target: path.join(resolvedHome, ...targetRelative.split("/")),
  }));
  const result = await exactSyncFiles({
    files,
    installationRoot: resolvedHome,
    managedRoots,
  });

  return {
    hermesHome: resolvedHome,
    pluginDir: path.join(resolvedHome, "plugins", "video-knowledge-capture"),
    skillDir: path.join(resolvedHome, "skills", "video-knowledge-capture"),
    copiedCount: result.copied.length,
    prunedCount: result.pruned.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installHermesIntegration(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
