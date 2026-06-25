# HarnessIQ

> Score your Claude Code **harness** — and get a ladder-mapped guideline to improve it.

A coding agent is `Model + Harness`. The model you can't change; the harness you can. HarnessIQ
audits a project's harness (`.claude/` + its persistent memory), gives it a **percentage score**
across 8 enforcement-weighted dimensions, and returns a **promotion map**: which of your
instructions are still *suggested* prose and how to promote them to *enforced* hooks or *verified*
gates.

## Install

```
/plugin marketplace add mjoyshuvo/harness-iq
/plugin install harness-iq@harness-iq
```

Then run it in any project:

```
/harness-iq
```

### Try it locally first (before publishing)

```
/plugin marketplace add ~/Documents/Projects/harness-iq
/plugin install harness-iq@harness-iq
```

## What you get

1. **Scorecard** — overall % + grade, with a per-dimension breakdown.
2. **Ladder distribution** — how many behaviors sit at each stage.
3. **Promotion Map** — the improvement guideline: every behavior with its current stage →
   target stage → mechanism (hook / skill / rule / command / agent / memory) → the exact file
   and snippet to add.

```
  OVERALL  ███████████████████·  97%  (A)
  Hooks (enforcement)      █████████████·  90%  (w20)
  Permissions & Security   ██████████████ 100%  (w14)
  ...
  PROMOTION MAP
  • Auto-format & lint on edit   Suggested → Enforced   via hook
      .claude/settings.json + .claude/hooks/format.sh
```

## The maturity ladder

| Stage | Mechanism | Reliability |
|---|---|---|
| Suggested | prose in CLAUDE.md | model may forget |
| Triggered | a skill / scoped rule | fires when matched |
| Enforced | a hook in settings.json | every time |
| Verified | a verifier agent / review gate / CI | checks its own output |

Climbing the ladder is the whole game. The score is **enforcement-weighted** so a harness with
real guarantees beats one with lots of prose.

## Scoring dimensions (weights)

Hooks **20** · Permissions & Security **14** · Context **12** · Skills **12** · Subagents **12** ·
Plan & Verification **12** · Rules **10** · Commands **8**. A plaintext secret in settings is a hard
penalty that caps the whole score.

## CLI / CI

The engine runs standalone (zero dependencies, Node ≥ 18):

```bash
node scripts/harness-score.mjs [path] [--json] [--ci] [--threshold N]
```

- `--json` — machine-readable output for tooling.
- `--ci --threshold 70` — exit non-zero when the score is below the threshold (pipeline gate).

## Development

```bash
node --test        # run the test suite (fixtures built in a temp dir)
```

## License

MIT
