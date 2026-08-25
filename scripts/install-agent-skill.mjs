import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exactSyncFiles } from "./lib/managed-file-sync.mjs";


const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillName = "video-knowledge-capture";
const declaredFiles = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/host-setup.md",
  "scripts/p0004-client.mjs",
];

function defaultSkillsDir(target, env = process.env, homeDir = os.homedir()) {
  if (target === "codex") {
    return path.join(env.CODEX_HOME || path.join(homeDir, ".codex"), "skills");
  }
  if (target === "claude") {
    return path.join(homeDir, ".claude", "skills");
  }
  throw new Error(`Unsupported target: ${target}`);
}

export function parseArguments(argv) {
  const options = { skillsDir: null, target: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target" && argv[index + 1]) {
      options.target = argv[index + 1].toLowerCase();
      index += 1;
      continue;
    }
    if (argument === "--skills-dir" && argv[index + 1]) {
      options.skillsDir = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (!options.target || !["codex", "claude", "custom"].includes(options.target)) {
    throw new Error("--target must be codex, claude, or custom.");
  }
  if (options.target === "custom" && !options.skillsDir) {
    throw new Error("--target custom requires --skills-dir.");
  }
  return options;
}

export async function installAgentSkill({
  target,
  skillsDir = null,
  env = process.env,
  homeDir = os.homedir(),
}) {
  const resolvedSkillsDir = path.resolve(skillsDir || defaultSkillsDir(target, env, homeDir));
  if (resolvedSkillsDir === path.parse(resolvedSkillsDir).root) {
    throw new Error("Skills directory cannot be a filesystem root.");
  }
  const sourceRoot = path.join(projectRoot, "skills", skillName);
  const skillDir = path.join(resolvedSkillsDir, skillName);
  const files = declaredFiles.map((relativePath) => ({
    source: path.join(sourceRoot, ...relativePath.split("/")),
    target: path.join(skillDir, ...relativePath.split("/")),
  }));
  const result = await exactSyncFiles({
    files,
    installationRoot: resolvedSkillsDir,
    managedRoots: [skillDir],
  });
  return {
    copiedCount: result.copied.length,
    prunedCount: result.pruned.length,
    skillDir,
    target,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const result = await installAgentSkill(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
