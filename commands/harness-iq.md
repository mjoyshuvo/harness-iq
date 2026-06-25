---
description: Audit this project's Claude Code harness — percentage score + ladder-mapped improvement guideline.
argument-hint: "[path] [--ci] [--threshold N]"
allowed-tools: ["Bash(node *)", "Read", "Glob"]
model: inherit
---

# HarnessIQ — harness audit

The engine renders the full report itself (scorecard, ladder, promotion map, recommendations)
**and** writes the HTML report — in one run. Your job is to relay it and add concrete fixes,
**not** to re-draw anything.

## Steps

1. **Run the engine once.** This prints the formatted report to stdout *and* writes/overwrites
   the HTML report, *and* prints a `file://` link on stderr:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/harness-score.mjs" <path-or-cwd> --html <path-or-cwd>/harness-report.html
   ```
   Use the path from `$ARGUMENTS`, else the current working directory. Forward `--ci` /
   `--threshold` if the user passed them.

2. **Relay the engine's stdout to the user EXACTLY, inside a fenced code block.** Copy it verbatim
   between ```` ``` ```` fences — every line, every bar, every box character — so nothing reflows.
   Do **NOT** redraw, realign, summarize, reorder, or re-number the scorecard, bars, ladder,
   promotion map, or recommendations. The engine owns the canonical format; re-rendering by hand
   corrupts it (garbled bars, merged numbers). Present exactly what it printed.

3. **Add concrete fixes** for the top 1–2 promotions: pull the matching snippet from the
   `harness-audit` skill's recipe library (keyed by `snippetKey`) and name the exact hook event,
   rule frontmatter, skill stub, or agent file to create.

4. **Show the HTML link.** Tell the user the report was created and surface the `file://…/harness-report.html`
   link the engine printed, so they can open or share it. (It's regenerated/overwritten every run —
   no need to ask permission.)

5. **Offer to apply** the top fix — never auto-apply. Treat a plaintext-secret penalty as the
   highest priority, and never print the secret value back.

## Notes
- The score and the rendered views are deterministic (same harness → same output). Only the
  fix-snippet advice in step 3 is yours to compose.
- For JSON/CI instead of the human report: `--json` (machine output) or `--ci --threshold N`
  (non-zero exit below the bar). These are for tooling, not the interactive command.
- Invoke the `harness-audit` skill for the rubric and the full snippet library when writing step 3.
