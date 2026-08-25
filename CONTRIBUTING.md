# Contributing

Thanks for helping improve Video Knowledge Capture. This is a source-available community project, not an OSI-defined open-source project. Community use is governed by `LICENSE`; commercial use requires a separate written agreement.

## Before contributing

- Open an issue or discussion before a large platform adapter, architectural change, new runtime dependency, or change to the security boundary.
- Read `README.md`, `LICENSE`, `CLA.md`, and `THIRD_PARTY_NOTICES.md`.
- Use only de-identified fixtures. Never submit real cookies, tokens, account data, private media, personal knowledge-base paths, live share identifiers, `.env` files, certificates, or other credentials.
- Do not add login bypasses, DRM circumvention, bulk scraping, browser-profile imports, or direct writes that bypass P0004's dedupe and failure ledger.

## Development setup

Requirements:

- Windows 10 or newer;
- Node.js 20 or newer;
- PowerShell; use `npm.cmd` when PowerShell execution policy blocks `npm.ps1`.

Run the offline test suite:

```powershell
npm.cmd test
```

Validate the canonical Skill:

```powershell
$env:PYTHONUTF8 = "1"
python "$env:CODEX_HOME\skills\.system\skill-creator\scripts\quick_validate.py" ".\skills\video-knowledge-capture"
```

The repository tests use temporary Inbox and configuration directories. Live platform verification is optional, uses only user-authorized public links, and must never target another person's private content or a real knowledge base.

## Pull requests

A pull request should:

- explain the user-visible outcome and maintenance trade-off;
- include focused tests for changed behavior;
- preserve stable error codes and the single P0004 write path;
- update public documentation without adding machine-specific evidence;
- pass `npm.cmd test` and the Skill validator;
- affirm: "I have read and agree to CLA.md."

The Maintainer may ask for a smaller change, additional de-identification, license provenance, or security evidence before accepting a contribution.
