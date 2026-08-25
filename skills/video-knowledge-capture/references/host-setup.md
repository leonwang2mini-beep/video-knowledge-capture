# Host setup

This repository ships one canonical Agent Skill. The Skill is the interaction layer; the Node.js P0004 service remains the local execution engine and must be running before an agent can capture a link.

## Codex

From the repository root on Windows:

```powershell
npm.cmd run setup:skill:codex
```

This installs the managed Skill under `%CODEX_HOME%\skills` when `CODEX_HOME` is set, otherwise under `%USERPROFILE%\.codex\skills`.

## Claude Code

From the repository root on Windows:

```powershell
npm.cmd run setup:skill:claude
```

This installs the managed Skill under `%USERPROFILE%\.claude\skills`. Claude Code can also load a project copy from `.claude\skills`, but the installer uses the personal location so the Skill is available across projects.

## Hermes

Hermes needs both the canonical Skill and its structured tool plugin:

```powershell
npm.cmd run setup:hermes
hermes plugins enable video-knowledge-capture --no-allow-tool-override
```

Tool authorization for a message channel is a separate, user-controlled Hermes action. Do not enable a channel or restart a gateway without the user's authorization.

## Custom Agent Skills host

Install into any explicit Agent Skills directory:

```powershell
node scripts/install-agent-skill.mjs --target custom --skills-dir "D:\AgentSkills"
```

The installer exact-syncs only the managed `video-knowledge-capture` directory, rejects symbolic-link destinations, and does not modify unrelated skills.

## Bundled client

When the host does not expose native P0004 tools, run `scripts/p0004-client.mjs` from the installed Skill directory. Pass the capture or status JSON through standard input using the host's non-expanding structured-input mechanism. Do not place a URL containing share tokens directly in a shell command line.
