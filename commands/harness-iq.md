---
description: Audit this project's Claude Code harness — percentage score + ladder-mapped improvement guideline.
argument-hint: "[path] [--json] [--ci] [--threshold N]"
allowed-tools: ["Bash(node *)", "Read", "Glob"]
model: inherit
---

# HarnessIQ — harness audit

Run the deterministic scoring engine and turn its JSON into an actionable report.

## Steps

1. **Run the engine** (always pass `--json` so you get structured data):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/harness-score.mjs" <path-or-cwd> --json
   ```
   Use the path the user gave in `$ARGUMENTS`, otherwise the current working directory.
   If the user passed `--ci`/`--threshold`, forward them too.

2. **Parse the JSON** (`overall`, `grade`, `dimensions[]`, `ladder`, `promotions[]`,
   `recommendations[]`, `penalties[]`).

3. **Render four views** to the user:

   ### ① Scorecard
   The `overall` % + `grade`, then each dimension as a short bar with its score and weight.
   Call out any `penalties` prominently (a plaintext secret caps the whole score).

   ### ② Ladder distribution
   From `ladder`, show how many behaviors sit at each stage
   (Absent · Suggested · Triggered · Enforced · Verified). This tells the user *where* the
   harness is weak, not just the number.

   ### ③ Promotion Map (the improvement guideline)
   Render `promotions` as a table, in the given order (already sorted by leverage):

   | Behavior | Now → Target | Mechanism | What to add |
   |---|---|---|---|

   For each promotion, give the **concrete fix**: cite `file`, and include a minimal,
   copy-pasteable snippet drawn from the `harness-audit` skill's recipe library
   (keyed by `snippetKey`). Be specific — name the exact hook event, rule frontmatter,
   skill stub, or agent file to create.

   ### ④ Recommendations by category
   From `recommendations[]` (grouped by category, highest-weight first). For each `improve`
   category, list its `items[]` and name the **mechanism to create** for each —
   `hook` / `skill` / `subagent` / `rule` / `command` / `memory` / `settings`. Render
   `healthy` categories as a single ✓ line. This guarantees even a high-scoring harness gets
   its "next-best" moves per category, not a blank result.

4. **Offer to apply** the top one or two fixes. Do NOT auto-apply — wait for the user to choose.
   Treat the security penalty (plaintext secret) as the highest priority if present, and never
   print the secret value back.

5. **Always generate the HTML report** (no need to ask). After the views, run the engine again
   with `--html`, writing/overwriting a report in the audited project:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/harness-score.mjs" <path> --html <path>/harness-report.html --quiet
   ```
   Then tell the user the report was created and show the clickable link the engine prints
   (`file://<absolute-path>/harness-report.html`). Replace any existing report. Do not ask
   permission — just create it and report the location.

## Notes
- The score is deterministic (same harness → same %). The *advice* is yours to make concrete.
- Invoke the `harness-audit` skill for the rubric, the maturity-ladder rationale, and the
  full snippet library when composing the Promotion Map.
