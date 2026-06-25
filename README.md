<div align="center">

# HarnessIQ

**Score your Claude Code _harness_ — and get a ladder-mapped guideline to improve it.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-plugin-7c6cff.svg)](https://docs.claude.com/en/docs/claude-code)
[![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-339933.svg)](https://nodejs.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

</div>

---

A coding agent is `Model + Harness`. You can't change the model — but the **harness** (the
context, tools, hooks, and guardrails around it) is entirely yours. HarnessIQ audits a project's
harness, gives it a **percentage score** across 8 enforcement-weighted dimensions, and returns a
**promotion map**: which of your instructions are still *suggested* prose and how to promote them
to *enforced* hooks or *verified* gates.

## Contents

- [Features](#features)
- [Install](#install)
- [Updating](#updating)
- [Usage](#usage)
- [CLI reference](#cli-reference)
- [How scoring works](#how-scoring-works)
- [Use in CI](#use-in-ci)
- [Development](#development)
- [Uninstall](#uninstall)
- [License](#license)

## Features

- 📊 **Reproducible score** — a deterministic engine, not an LLM guess. Same harness → same %.
- 🪜 **Ladder-mapped guidance** — every gap tagged `Suggested → Triggered → Enforced → Verified`
  with the exact mechanism (hook / skill / rule / command / agent / memory) and file to add.
- 🔒 **Security-aware** — a plaintext secret in settings is a hard penalty that caps the score.
- 🧾 **Shareable HTML report** — `--html` writes a self-contained report (permission-gated in the command).
- 🤖 **CI-ready** — `--ci --threshold N` exits non-zero below a bar; `--json` for tooling.
- 📦 **Zero dependencies** — pure Node, runs anywhere the plugin installs.

## Install

In the interactive `claude` terminal:

```text
/plugin marketplace add mjoyshuvo/harness-iq
/plugin install harness-iq@harness-iq
```

Choose a scope when prompted (**user** = all your projects, **project** = this repo for all
collaborators, **local** = this repo, just you). The standard plugin-trust warning is expected.

> **Try it from a local checkout first**
> ```text
> /plugin marketplace add ~/Documents/Projects/harness-iq
> /plugin install harness-iq@harness-iq
> ```

## Updating

When a new version is published, refresh the marketplace then reinstall:

```text
/plugin marketplace update harness-iq
/plugin install harness-iq@harness-iq
```

`marketplace update` pulls the latest commit from the source repo; reinstalling picks up the new
version. (Browse everything interactively by running `/plugin` with no arguments.)

## Usage

Run inside any project you want to audit:

```text
/harness-iq
```

You get three views:

1. **Scorecard** — overall % + grade, with a per-dimension breakdown.
2. **Ladder distribution** — how many behaviors sit at each stage.
3. **Promotion Map** — the improvement guideline: each behavior with `current → target` stage,
   mechanism, and the exact file + snippet to add.

```text
  OVERALL  ███████████████████·  97%  (A)
  Hooks (enforcement)      █████████████·  90%  (w20)
  Permissions & Security   ██████████████ 100%  (w14)
  ...
  PROMOTION MAP
  • Auto-format & lint on edit   Suggested → Enforced   via hook
      .claude/settings.json + .claude/hooks/format.sh
```

Ask for a **shareable HTML report** and the command will (with your permission) write a
self-contained file you can open or screenshot.

## CLI reference

The engine also runs standalone (Node ≥ 18, no install):

```bash
node scripts/harness-score.mjs [path] [--json] [--ci] [--threshold N] [--html [file]]
```

| Flag | Effect |
|---|---|
| _(none)_ | Print the terminal scorecard for `path` (default: cwd). |
| `--json` | Emit the full result as JSON for tooling. |
| `--html [file]` | Write a self-contained HTML report (default `harness-report.html`). |
| `--ci` | With `--threshold N`, exit non-zero when the score is below `N`. |
| `--threshold N` | Set the CI pass bar (default `70`). |

## How scoring works

Every behavior sits on a **maturity ladder** — reliability rises as you climb, and the audit's job
is to move high-value behaviors up:

| Stage | Mechanism | Reliability |
|---|---|---|
| Suggested | prose in CLAUDE.md | model may forget |
| Triggered | a skill / scoped rule | fires when matched |
| Enforced | a hook in settings.json | every time |
| Verified | a verifier agent / review gate / CI | checks its own output |

The score is **enforcement-weighted** across 8 dimensions, so a harness with real guarantees beats
one with lots of prose:

| Dimension | Weight |
|---|---:|
| Hooks (enforcement) | 20 |
| Permissions & Security | 14 |
| Context | 12 |
| Skills | 12 |
| Subagents | 12 |
| Plan & Verification | 12 |
| Rules | 10 |
| Commands | 8 |

Grades: **A** ≥ 90 · **B** ≥ 75 · **C** ≥ 60 · **D** ≥ 45 · **F** below. A plaintext secret in
settings caps the whole score regardless of the rest.

## Use in CI

Fail a pipeline if the harness regresses below a bar:

```yaml
# .github/workflows/harness.yml
name: HarnessIQ
on: [push, pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node path/to/harness-score.mjs . --ci --threshold 70
```

## Development

```bash
node --test        # run the suite (fixtures are built in a temp dir, no setup)
```

Contributions welcome — open an issue or PR.

## Uninstall

```text
/plugin uninstall harness-iq@harness-iq
/plugin marketplace remove harness-iq
```

## License

[MIT](LICENSE) © mjoyshuvo
