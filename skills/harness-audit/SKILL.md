---
name: harness-audit
description: Rubric, maturity-ladder philosophy, and fix recipes for auditing a Claude Code harness. Use when running /harness-iq or when interpreting harness-score.mjs output and proposing concrete improvements.
---

# Harness Audit — rubric, ladder & recipes

This skill backs the `/harness-iq` command. It explains *how* the score is built and supplies
the **fix recipes** that turn a promotion into a copy-pasteable change.

## Always emit the HTML report

Whenever you audit a harness (via `/harness-iq` or this skill), **always generate the HTML report
automatically — do not ask permission.** Run the engine with `--html`, overwriting any existing file:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness-score.mjs" <project> --html <project>/harness-report.html
```

This one run prints the full report (relay it as-is, don't redraw) **and** writes the HTML.
Then tell the user it was created and show the clickable link the engine prints
(`file://<absolute-path>/harness-report.html`).

## The maturity ladder (the core idea)

Every desired behavior sits at one stage. Reliability rises as you climb. The whole point of an
audit is to move high-value behaviors **up**.

| Stage | Mechanism | Reliability |
|---|---|---|
| **Absent** | nothing | — |
| **Suggested** | prose in CLAUDE.md | model may forget |
| **Triggered** | a skill or scoped rule | fires when matched |
| **Enforced** | a hook in settings.json | every time, deterministic |
| **Verified** | a loop that checks output (verifier agent / review gate / CI) | catches its own mistakes |

A directive like "always format the code" written only in CLAUDE.md is **Suggested**. The same
rule as a `PostToolUse` hook is **Enforced**. Prefer promoting deterministic behaviors to hooks,
and quality gates to a verifier.

## Scoring rubric (8 weighted dimensions, sum = 100)

Weights are **enforcement-biased**: the dimensions that represent guarantees (Hooks, Security,
Plan/Verification) carry more weight than presence-only dimensions.

| Dimension | Wt | What earns points |
|---|---|---|
| Hooks (enforcement) | 20 | hooks block; PostToolUse / SessionStart / Stop / Pre coverage; executable scripts |
| Permissions & Security | 14 | settings present; **no plaintext secrets** (hard cap if violated); scoped allow-list |
| Context | 12 | CLAUDE.md; CLAUDE.local/CONTEXT; memory dir; MEMORY.md with ≥3 entries |
| Skills | 12 | count; complete frontmatter; bundled scripts |
| Subagents | 12 | count; model set; allowed-tools scoped |
| Plan & Verification | 12 | _plan/ files; verification language; verifier agent; end-of-task gate |
| Rules | 10 | count; alwaysApply; glob-scoped |
| Commands | 8 | count; orchestrates a subagent/skill |

Grades: A ≥90 · B ≥75 · C ≥60 · D ≥45 · F below.

## Fix recipes (keyed by `snippetKey`)

### `post-tooluse-format` — promote "format/lint" to Enforced
`.claude/settings.json`:
```json
{ "hooks": { "PostToolUse": [ { "matcher": "Edit|Write|MultiEdit",
  "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/format.sh" } ] } ] } }
```
`.claude/hooks/format.sh` reads the edited file path from stdin JSON and runs your formatter/linter
on just that file (exit 2 to feed lint failures back to the agent). `chmod +x` it.

### `session-start-memory` — surface memory automatically
```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command",
  "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session_start.sh" } ] } ] } }
```
The script `cat`s your MEMORY.md so prior lessons load every session.

### `memory-loop` — start the persistent-memory loop
Create `~/.claude/projects/<encoded>/memory/MEMORY.md` (one line per durable fact) and one file per
lesson (frontmatter `type: feedback|project`, body with **Why** + **How to apply**). Pair with the
`session-start-memory` hook so it's read on startup.

### `verifier-agent` — promote "verify before done" to Verified
`.claude/agents/verifier.md`:
```markdown
---
name: verifier
description: Validates completed work actually runs and meets the request. Use after a task is marked done.
model: inherit
allowed-tools: ["Read", "Grep", "Glob", "Bash(git diff*)"]
---
You independently confirm the change exists, runs, and satisfies the original intent. Report PASS/FAIL with evidence.
```
Optionally add a `Stop` hook that reminds (or a `/dispatch-reviewer`-style command that gates).

### `add-skill` — package a recurring procedure (Triggered)
`.claude/skills/<name>/SKILL.md` with `name` + a trigger-rich `description`. Put deterministic steps
in a `scripts/` helper so the agent runs it instead of re-deriving code.

### `add-rule` — encode a convention (Triggered)
`.claude/rules/<name>.mdc` with frontmatter `globs:` (scope it) and `alwaysApply: true` for the
non-negotiable ones.

### `add-command` — make a workflow one keystroke
`.claude/commands/<name>.md` with `description` frontmatter; orchestrate a subagent/skill in the body.

### `move-secret` — remove a plaintext credential (highest priority)
Delete the literal token from `settings.json`; reference an env var / secret store instead, and
**rotate** the exposed credential. Never echo the secret value back to the user.
