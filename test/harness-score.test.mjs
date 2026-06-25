import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scoreHarness } from "../scripts/harness-score.mjs";

// build a throwaway project tree under a temp dir
function mkProject(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessiq-"));
  const write = (rel, content, mode) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    if (mode) fs.chmodSync(p, mode);
  };
  spec(write);
  return root;
}

test("empty harness scores low and suggests promotions", () => {
  const root = mkProject((w) => w("CLAUDE.md", "# Project\nalways format the code.\n"));
  const r = scoreHarness(root);
  assert.ok(r.overall < 25, `expected <25, got ${r.overall}`);
  assert.ok(r.promotions.length > 0, "should propose promotions");
  const mechs = r.promotions.map((p) => p.mechanism);
  assert.ok(mechs.includes("hook"), "should suggest a hook");
  assert.ok(mechs.includes("memory"), "should suggest the memory loop");
});

test("plaintext secret triggers penalty and caps the score", () => {
  const root = mkProject((w) => {
    w("CLAUDE.md", "# Project\n");
    w(
      ".claude/settings.json",
      JSON.stringify({
        mcpServers: {
          jira: { env: { ATLASSIAN_API_TOKEN: "ATATT3xFfGF0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345" } },
        },
      })
    );
  });
  const r = scoreHarness(root);
  assert.ok(r.penalties.length >= 1, "secret should produce a penalty");
  assert.ok(r.overall <= 40, `secret should cap score <=40, got ${r.overall}`);
  assert.equal(r.promotions[0].mechanism, "security", "security fix should be top priority");
});

test("a rich harness scores high with no penalties", () => {
  const root = mkProject((w) => {
    w("CLAUDE.md", "# Project\nVerification before done. Tests pass before merge. Proof of work required.\n");
    w("CLAUDE.local.md", "# Local\n");
    w(
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "x" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "x" }] }],
          Stop: [{ hooks: [{ type: "command", command: "x" }] }],
        },
      })
    );
    w(".claude/settings.local.json", JSON.stringify({ permissions: { allow: ["Bash(pytest:*)", "Read"] } }));
    w(".claude/hooks/format.sh", "#!/usr/bin/env bash\necho ok\n", 0o755);
    for (const n of ["a", "b", "c", "d", "e", "f"])
      w(`.claude/skills/${n}/SKILL.md`, `---\nname: ${n}\ndescription: does ${n} when asked to ${n}\n---\nbody\n`);
    w(".claude/skills/a/scripts/run.mjs", "// helper\n");
    for (const n of ["reviewer", "verifier", "explorer"])
      w(`.claude/agents/${n}.md`, `---\nname: ${n}\ndescription: ${n}\nmodel: inherit\nallowed-tools: ["Read"]\n---\nbody\n`);
    for (const n of ["x", "y", "z"]) w(`.claude/rules/${n}.mdc`, `---\nglobs: src/*.ts\nalwaysApply: true\n---\nrule\n`);
    w(".claude/commands/review.md", "---\ndescription: review\n---\ndispatch the reviewer agent\n");
    w(".claude/commands/build.md", "---\ndescription: build\n---\nbuild\n");
    w(".claude/commands/ship.md", "---\ndescription: ship\n---\nship\n");
    for (const n of ["1", "2", "3"]) w(`_plan/plan-${n}.md`, "# plan\n");
  });
  const r = scoreHarness(root);
  assert.ok(r.overall >= 75, `expected >=75, got ${r.overall}`);
  assert.equal(r.penalties.length, 0, "no penalties expected");
  assert.equal(r.grade, r.overall >= 90 ? "A" : "B");
});

test("scoring is deterministic", () => {
  const root = mkProject((w) => w("CLAUDE.md", "# p\n"));
  assert.equal(scoreHarness(root).overall, scoreHarness(root).overall);
});

test("partial harness lands in the middle band", () => {
  const root = mkProject((w) => {
    w("CLAUDE.md", "# Project\n");
    w(".claude/skills/a/SKILL.md", "---\nname: a\ndescription: a\n---\n");
    w(".claude/agents/r.md", "---\nname: r\ndescription: r\nmodel: inherit\n---\n");
    w(".claude/rules/x.mdc", "---\nalwaysApply: true\n---\n");
  });
  const r = scoreHarness(root);
  assert.ok(r.overall > 15 && r.overall < 70, `expected mid band, got ${r.overall}`);
});
