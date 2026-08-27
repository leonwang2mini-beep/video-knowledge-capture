import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";


const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "CLA.md",
  "COMMERCIAL_LICENSE.md",
  "CONTRIBUTING.md",
  "docs/BETA_TESTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  ".github/ISSUE_TEMPLATE/beta_feedback.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  "skills/video-knowledge-capture/SKILL.md",
  "skills/video-knowledge-capture/agents/openai.yaml",
  "skills/video-knowledge-capture/references/host-setup.md",
  "skills/video-knowledge-capture/scripts/p0004-client.mjs",
];
const textExtensions = new Set([
  "", ".cmd", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".py", ".yaml", ".yml",
]);
const forbiddenPatterns = [
  { label: "Windows user profile path", pattern: /[A-Z]:\\Users\\[^\\\s]+\\AppData/gi },
  { label: "private workspace path", pattern: /[A-Z]:\\Myprojects\\/gi },
  { label: "machine-specific application path", pattern: /[A-Z]:\\Apps\\/gi },
  { label: "known local account name", pattern: new RegExp(["PJ", "OIO"].join(""), "gi") },
  { label: "process identifier evidence", pattern: /\bPID\s*[:=]?\s*\d{2,}\b/g },
  { label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    label: "credential assignment",
    pattern: /\b(?:api[_-]?key|password|secret|token)\s*=\s*["'](?!(?:redacted|fake|fixture|example|must-not|top-secret)\b)[^"'\r\n]{8,}["']/gi,
  },
];
const allowedShareFixture = /fixture|example|test|demo|degraded|one-box|manual|authorized|acceptance/i;
const allowedDouyinIds = new Set(["123", "1234567890", "7000000000000000001"]);

async function walk(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(childPath, childRelative));
    } else {
      files.push({ absolutePath: childPath, relativePath: childRelative });
    }
  }
  return files;
}

function recordMatches(findings, relativePath, label, text, pattern) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    findings.push({ file: relativePath, label, sample: match[0].slice(0, 120) });
  }
}

async function audit() {
  const findings = [];
  const files = await walk(projectRoot);
  const fileSet = new Set(files.map(({ relativePath }) => relativePath));

  for (const required of requiredFiles) {
    if (!fileSet.has(required)) findings.push({ file: required, label: "required public-release file is missing" });
  }

  if (files.some(({ relativePath }) => /(?:^|\/)__pycache__\//.test(relativePath) || relativePath.endsWith(".pyc"))) {
    findings.push({ file: "__pycache__", label: "generated Python cache is present in the release tree" });
  }
  if (files.some(({ relativePath }) => /(?:^|\/)\.env(?:\.|$)/.test(relativePath))) {
    findings.push({ file: ".env", label: "environment file is present in the release tree" });
  }
  if (fileSet.has("integrations/hermes/skills/video-knowledge-capture/SKILL.md")) {
    findings.push({
      file: "integrations/hermes/skills/video-knowledge-capture/SKILL.md",
      label: "legacy duplicate Skill source is present",
    });
  }

  for (const file of files) {
    const metadata = await stat(file.absolutePath);
    if (metadata.size > 2 * 1024 * 1024 || !textExtensions.has(path.extname(file.relativePath).toLowerCase())) continue;
    const text = await readFile(file.absolutePath, "utf8");
    for (const { label, pattern } of forbiddenPatterns) {
      recordMatches(findings, file.relativePath, label, text, pattern);
    }

    for (const match of text.matchAll(/https:\/\/weixin\.qq\.com\/sph\/([A-Za-z0-9_-]+)/g)) {
      if (!allowedShareFixture.test(match[1])) {
        findings.push({ file: file.relativePath, label: "real-looking WeChat share identifier", sample: match[0] });
      }
    }
    for (const match of text.matchAll(/https:\/\/www\.douyin\.com\/video\/(\d{3,30})/g)) {
      if (!allowedDouyinIds.has(match[1])) {
        findings.push({ file: file.relativePath, label: "unapproved real-looking Douyin identifier", sample: match[0] });
      }
    }
  }

  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  if (packageJson.license !== "SEE LICENSE IN LICENSE") {
    findings.push({ file: "package.json", label: "package license field is not aligned with LICENSE" });
  }
  if (packageJson.scripts?.["doctor:shareable"] !== "node scripts/doctor.mjs --shareable") {
    findings.push({ file: "package.json", label: "shareable doctor command is missing or changed" });
  }
  const license = await readFile(path.join(projectRoot, "LICENSE"), "utf8");
  if (!license.startsWith("# PolyForm Noncommercial License 1.0.0")) {
    findings.push({ file: "LICENSE", label: "standard PolyForm Noncommercial heading is missing" });
  }
  if (!/^Required Notice: Copyright 2026 Leon\.$/m.test(license)) {
    findings.push({ file: "LICENSE", label: "project Required Notice is missing" });
  }
  const readme = await readFile(path.join(projectRoot, "README.md"), "utf8");
  if (!/Source-Available/.test(readme) || !/不是 OSI 定义的开源软件/.test(readme)) {
    findings.push({ file: "README.md", label: "source-available positioning is incomplete" });
  }
  const betaGuide = await readFile(path.join(projectRoot, "docs", "BETA_TESTING.md"), "utf8");
  if (!/doctor:shareable/.test(betaGuide) || !/不计 E4/.test(betaGuide) || !/临时 Inbox/.test(betaGuide)) {
    findings.push({ file: "docs/BETA_TESTING.md", label: "external Beta evidence or privacy boundary is incomplete" });
  }

  if (findings.length > 0) {
    process.stdout.write(`${JSON.stringify({ findings, status: "failed" }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ filesScanned: files.length, status: "passed" }, null, 2)}\n`);
}

await audit();
