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

## OpenClaw

From the repository root on Windows:

```powershell
npm.cmd run setup:skill:openclaw
```

This installs the managed Skill under `%USERPROFILE%\.openclaw\skills`, one of OpenClaw's documented managed Skill roots. The OpenClaw host must run on the same Windows computer, be allowed to execute the bundled Node.js client, and be able to reach the loopback-only P0004 service. Installing the Skill does not install or start the local engine.

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

## First-install setup and diagnosis

For one explicit host, configure an existing Inbox, install the pinned core runtime, and install the host integration in one command:

```powershell
npm.cmd run setup:community -- --host codex --inbox "D:\KnowledgeBase\Inbox"
```

Replace `codex` with `claude`, `hermes`, or `openclaw`. Use `all` only when every listed host is intentionally installed on the same computer. Then start the local service and run the read-only doctor:

```powershell
start-video-capture.cmd
npm.cmd run doctor -- --host codex
```

The setup is idempotent. The doctor reports missing prerequisites and next actions without displaying credentials or modifying configuration.

## Bundled client

When the host does not expose native P0004 tools, run `scripts/p0004-client.mjs` from the installed Skill directory. Pass the capture or status JSON through standard input using the host's non-expanding structured-input mechanism. Do not place a URL containing share tokens directly in a shell command line.
