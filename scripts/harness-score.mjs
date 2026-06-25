#!/usr/bin/env node
/**
 * HarnessIQ scoring engine — zero dependency.
 *
 * Inspects a project's Claude Code harness and returns a reproducible percentage
 * score across 8 enforcement-weighted dimensions, plus a ladder-mapped "promotion"
 * list (which behaviors are stuck at Suggested and how to promote them).
 *
 * Usage:
 *   node harness-score.mjs [projectDir] [--json] [--ci] [--threshold N]
 *
 * Exported for tests: scoreHarness(projectDir) -> result object.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------- tiny fs helpers ----------
const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isExecutable = (p) => {
  try {
    return (fs.statSync(p).mode & 0o111) !== 0;
  } catch {
    return false;
  }
};
const listFiles = (dir, ext) => {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => !ext || f.endsWith(ext))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
};
const subdirs = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
};

// crude top-level frontmatter reader (only needs presence of keys)
const frontmatter = (md) => {
  if (!md) return {};
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim();
  }
  return out;
};

const clamp = (n) => Math.max(0, Math.min(100, n));

// ---------- secret detection ----------
const SECRET_PATTERNS = [
  /ATATT[0-9A-Za-z_-]{10,}/, // Atlassian
  /sk-[A-Za-z0-9]{20,}/, // OpenAI
  /ghp_[A-Za-z0-9]{20,}/, // GitHub PAT
  /AKIA[0-9A-Z]{16}/, // AWS access key
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
];
const SECRET_KV =
  /"(?:api[_-]?key|secret|password|passwd|token|access[_-]?key|client[_-]?secret)"\s*:\s*"([^"]{8,})"/gi;

function scanSecrets(text) {
  if (!text) return [];
  const hits = [];
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) hits.push("hardcoded credential matching a known token format");
  }
  let m;
  while ((m = SECRET_KV.exec(text))) {
    const val = m[1];
    // ignore env-var indirection / obvious placeholders
    if (/\$\{|^env:|^\*+$|REPLACE|YOUR_|xxx/i.test(val)) continue;
    hits.push("secret-like key/value in settings JSON");
  }
  return [...new Set(hits)];
}

// ---------- memory dir resolution ----------
function memoryDir(projectDir) {
  const encoded = path.resolve(projectDir).replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", encoded, "memory");
}

// ---------- the scorer ----------
export function scoreHarness(projectDir) {
  const root = path.resolve(projectDir);
  const claude = path.join(root, ".claude");

  const settingsRaw = read(path.join(claude, "settings.json"));
  const localRaw = read(path.join(claude, "settings.local.json"));
  const settings = safeJson(settingsRaw);
  const local = safeJson(localRaw);

  const dimensions = [
    scoreHooks(claude, settings),
    scoreSecurity(claude, settings, local, settingsRaw, localRaw),
    scoreContext(root, claude),
    scoreSkills(claude),
    scoreSubagents(claude),
    scorePlanVerification(root, claude, settings),
    scoreRules(claude),
    scoreCommands(claude),
  ];

  let overall = dimensions.reduce((s, d) => s + (d.score / 100) * d.weight, 0);

  // penalties
  const penalties = [];
  const secretHits = scanSecrets(settingsRaw).concat(scanSecrets(localRaw));
  if (secretHits.length) {
    penalties.push({ label: `Plaintext secret in settings (${secretHits[0]})`, cap: 40 });
    overall = Math.min(overall, 40);
  }

  overall = Math.round(clamp(overall));
  const promotions = buildPromotions(root, claude, dimensions, settings, secretHits.length > 0);
  const specifics = mineProjectSpecifics(root);

  return {
    project: root,
    overall,
    grade: grade(overall),
    dimensions,
    ladder: ladderCounts(promotions),
    promotions,
    recommendations: buildRecommendations(dimensions, specifics),
    projectSignals: specifics,
    penalties,
    summary: summarize(overall, dimensions, promotions),
  };
}

function safeJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function grade(n) {
  if (n >= 90) return "A";
  if (n >= 75) return "B";
  if (n >= 60) return "C";
  if (n >= 45) return "D";
  return "F";
}

// ---------- dimension scorers ----------
function mk(key, label, weight) {
  return { key, label, weight, score: 0, signals: [], gaps: [] };
}
function sig(d, label, ok) {
  d.signals.push({ label, ok });
  return ok;
}

function scoreHooks(claude, settings) {
  const d = mk("hooks", "Hooks (enforcement)", 20);
  const hooks = settings?.hooks || {};
  let pts = 0;
  if (sig(d, "hooks block present in settings.json", Object.keys(hooks).length > 0)) pts += 20;
  if (sig(d, "PostToolUse hook (format/lint on edit)", !!hooks.PostToolUse)) pts += 25;
  else d.gaps.push("No PostToolUse hook — edits aren't auto-formatted/linted");
  if (sig(d, "SessionStart hook (surface context/memory)", !!hooks.SessionStart)) pts += 15;
  if (sig(d, "Stop hook (end-of-task gate/reminder)", !!hooks.Stop)) pts += 15;
  if (sig(d, "Pre/UserPromptSubmit hook", !!(hooks.PreToolUse || hooks.UserPromptSubmit))) pts += 10;
  const scripts = listFiles(path.join(claude, "hooks"));
  const execScripts = scripts.filter(isExecutable);
  if (sig(d, "executable hook script(s) present", execScripts.length > 0)) pts += 15;
  else if (scripts.length) d.gaps.push("Hook scripts exist but are not executable (chmod +x)");
  d.score = clamp(pts);
  return d;
}

function scoreSecurity(claude, settings, local, settingsRaw, localRaw) {
  const d = mk("security", "Permissions & Security", 14);
  let pts = 0;
  if (sig(d, "settings.json present", !!settings)) pts += 20;
  if (sig(d, "settings.local.json present", !!local)) pts += 10;
  const secrets = scanSecrets(settingsRaw).concat(scanSecrets(localRaw));
  if (sig(d, "no plaintext secrets in settings", secrets.length === 0)) pts += 50;
  else d.gaps.push("Plaintext secret detected in settings — move to env/secret store");
  const allow = local?.permissions?.allow || settings?.permissions?.allow || [];
  const broad = allow.some((a) => a === "*" || a === "Bash(*)" || /^Bash\(\*\)/.test(a));
  if (sig(d, "permission allow-list is scoped (no blanket *)", allow.length > 0 && !broad)) pts += 20;
  else if (broad) d.gaps.push("Permission allow-list contains a blanket wildcard");
  d.score = clamp(pts);
  return d;
}

function scoreContext(root, claude) {
  const d = mk("context", "Context", 12);
  let pts = 0;
  if (sig(d, "CLAUDE.md present", exists(path.join(root, "CLAUDE.md")))) pts += 30;
  else d.gaps.push("No CLAUDE.md — the agent has no standing project context");
  const localCtx =
    exists(path.join(root, "CLAUDE.local.md")) || exists(path.join(root, "CONTEXT.md"));
  if (sig(d, "CLAUDE.local.md / CONTEXT.md present", localCtx)) pts += 15;
  const mem = memoryDir(root);
  if (sig(d, "auto-memory directory exists", isDir(mem))) pts += 20;
  const memIndex = read(path.join(mem, "MEMORY.md"));
  const entries = memIndex ? (memIndex.match(/^- \[/gm) || []).length : 0;
  if (sig(d, `MEMORY.md with ≥3 entries (found ${entries})`, entries >= 3)) pts += 35;
  else if (entries > 0) {
    pts += 18;
    d.gaps.push("Memory exists but is thin — capture more durable lessons");
  } else d.gaps.push("No persistent memory — corrections don't survive sessions");
  d.score = clamp(pts);
  return d;
}

function scoreSkills(claude) {
  const d = mk("skills", "Skills", 12);
  const dirs = subdirs(path.join(claude, "skills"));
  const skills = dirs.filter((s) => exists(path.join(s, "SKILL.md")));
  const n = skills.length;
  let pts = n === 0 ? 0 : n <= 2 ? 40 : n <= 5 ? 70 : 85;
  sig(d, `skills present (found ${n})`, n > 0);
  if (n === 0) d.gaps.push("No skills — recurring procedures are re-derived each time");
  const complete = skills.every((s) => {
    const fm = frontmatter(read(path.join(s, "SKILL.md")));
    return fm.name && fm.description;
  });
  if (n > 0 && sig(d, "all skills have name+description frontmatter", complete)) pts += 10;
  const hasScripts = skills.some((s) => isDir(path.join(s, "scripts")));
  if (sig(d, "a skill bundles helper scripts (determinism)", hasScripts)) pts += 5;
  d.score = clamp(pts);
  return d;
}

function scoreSubagents(claude) {
  const d = mk("subagents", "Subagents", 12);
  const files = listFiles(path.join(claude, "agents"), ".md");
  const n = files.length;
  let pts = n === 0 ? 0 : n <= 2 ? 45 : 70;
  sig(d, `subagents present (found ${n})`, n > 0);
  if (n === 0) d.gaps.push("No subagents — no scoped specialists for review/verify/explore");
  if (n > 0) {
    const fms = files.map((f) => frontmatter(read(f)));
    const modelFrac = fms.filter((f) => f.model).length / n;
    const toolsFrac = fms.filter((f) => f["allowed-tools"]).length / n;
    if (sig(d, "agents specify a model (cost-aware)", modelFrac >= 0.5)) pts += 15 * modelFrac;
    if (sig(d, "agents scope allowed-tools (least privilege)", toolsFrac >= 0.5))
      pts += 15 * toolsFrac;
  }
  d.score = clamp(pts);
  return d;
}

function scorePlanVerification(root, claude, settings) {
  const d = mk("planverify", "Plan & Verification", 12);
  let pts = 0;
  const planFiles = listFiles(path.join(root, "_plan"), ".md");
  if (sig(d, `_plan/ with ≥3 plans (found ${planFiles.length})`, planFiles.length >= 3))
    pts += 30;
  else if (planFiles.length) pts += 15;
  else d.gaps.push("No _plan/ — non-trivial work isn't designed before coding");
  const ctx =
    (read(path.join(root, "CLAUDE.md")) || "") + (read(path.join(root, "CLAUDE.local.md")) || "");
  if (sig(d, "verification language in guides", /verif|proof of work|success criteria|tests? (pass|before)/i.test(ctx)))
    pts += 20;
  const agents = listFiles(path.join(claude, "agents"), ".md");
  const hasVerifier = agents.some((a) => /verif|review/i.test(a + (read(a) || "")));
  if (sig(d, "verifier/reviewer subagent exists", hasVerifier)) pts += 25;
  else d.gaps.push("No verifier/reviewer agent — 'done' isn't independently checked");
  const stopGate = !!settings?.hooks?.Stop;
  const reviewCmd = listFiles(path.join(claude, "commands"), ".md").some((c) =>
    /review|verif|dispatch/i.test(read(c) || "")
  );
  if (sig(d, "end-of-task gate (Stop hook or review command)", stopGate || reviewCmd)) pts += 25;
  d.score = clamp(pts);
  return d;
}

function scoreRules(claude) {
  const d = mk("rules", "Rules", 10);
  const files = listFiles(path.join(claude, "rules"), ".mdc").concat(
    listFiles(path.join(claude, "rules"), ".md")
  );
  const n = files.length;
  let pts = n === 0 ? 0 : n <= 2 ? 40 : 65;
  sig(d, `rules present (found ${n})`, n > 0);
  if (n === 0) d.gaps.push("No rule files — conventions live only in long-form prose");
  if (n > 0) {
    const fms = files.map((f) => frontmatter(read(f)));
    if (sig(d, "a rule is alwaysApply (strong enforcement)", fms.some((f) => /true/i.test(f.alwaysapply || ""))))
      pts += 20;
    if (sig(d, "a rule is glob-scoped", fms.some((f) => f.globs))) pts += 15;
  }
  d.score = clamp(pts);
  return d;
}

function scoreCommands(claude) {
  const d = mk("commands", "Commands", 8);
  const files = listFiles(path.join(claude, "commands"), ".md");
  const n = files.length;
  let pts = n === 0 ? 0 : n <= 2 ? 55 : 80;
  sig(d, `commands present (found ${n})`, n > 0);
  if (n === 0) d.gaps.push("No slash commands — repeatable workflows aren't one keystroke away");
  const orchestrates = files.some((c) => /agent|dispatch|skill/i.test(read(c) || ""));
  if (n > 0 && sig(d, "a command orchestrates a subagent/skill", orchestrates)) pts += 20;
  d.score = clamp(pts);
  return d;
}

// ---------- ladder / promotions ----------
function buildPromotions(root, claude, dimensions, settings, hasSecret) {
  const byKey = Object.fromEntries(dimensions.map((d) => [d.key, d]));
  const hooks = settings?.hooks || {};
  const ctx =
    (read(path.join(root, "CLAUDE.md")) || "") + (read(path.join(root, "CLAUDE.local.md")) || "");
  const has = (re) => re.test(ctx);
  const P = [];
  const push = (p) => P.push(p);

  if (hasSecret)
    push({
      behavior: "Plaintext secret in settings",
      current: "Critical",
      target: "Removed",
      mechanism: "security",
      leverage: 100,
      file: ".claude/settings.json",
      snippetKey: "move-secret",
      note: "Move the credential to an env var / secret store and rotate it.",
    });

  if (!hooks.PostToolUse)
    push({
      behavior: "Auto-format & lint on edit",
      current: has(/format|lint|black|prettier|ruff|flake8/i) ? "Suggested" : "Absent",
      target: "Enforced",
      mechanism: "hook",
      leverage: byKey.hooks.weight,
      file: ".claude/settings.json + .claude/hooks/format.sh",
      snippetKey: "post-tooluse-format",
    });

  const memOk = byKey.context.signals.find((s) => /MEMORY/.test(s.label))?.ok;
  if (!memOk)
    push({
      behavior: "Capture corrections so they persist",
      current: "Absent",
      target: "Verified",
      mechanism: "memory",
      leverage: byKey.context.weight,
      file: "~/.claude/projects/<encoded>/memory/MEMORY.md",
      snippetKey: "memory-loop",
    });
  else if (!hooks.SessionStart)
    push({
      behavior: "Surface memory at session start",
      current: "Suggested",
      target: "Enforced",
      mechanism: "hook",
      leverage: byKey.hooks.weight,
      file: ".claude/settings.json + .claude/hooks/session_start.sh",
      snippetKey: "session-start-memory",
    });

  const hasVerifier = byKey.planverify.signals.find((s) => /verifier/.test(s.label))?.ok;
  if (!hasVerifier)
    push({
      behavior: "Verify work before calling it done",
      current: has(/verif|tests? (pass|before)|proof of work/i) ? "Suggested" : "Absent",
      target: "Verified",
      mechanism: "agent",
      leverage: byKey.planverify.weight,
      file: ".claude/agents/verifier.md",
      snippetKey: "verifier-agent",
    });

  if (byKey.skills.score < 70)
    push({
      behavior: "Package recurring procedures",
      current: byKey.skills.score === 0 ? "Absent" : "Triggered",
      target: "Triggered",
      mechanism: "skill",
      leverage: byKey.skills.weight,
      file: ".claude/skills/<name>/SKILL.md",
      snippetKey: "add-skill",
    });

  if (byKey.rules.score < 65)
    push({
      behavior: "Encode conventions as scoped rules",
      current: byKey.rules.score === 0 ? "Absent" : "Suggested",
      target: "Triggered",
      mechanism: "rule",
      leverage: byKey.rules.weight,
      file: ".claude/rules/<name>.mdc",
      snippetKey: "add-rule",
    });

  if (byKey.commands.score < 55)
    push({
      behavior: "Make a repeatable workflow one keystroke",
      current: "Absent",
      target: "Triggered",
      mechanism: "command",
      leverage: byKey.commands.weight,
      file: ".claude/commands/<name>.md",
      snippetKey: "add-command",
    });

  return P.sort((a, b) => b.leverage - a.leverage);
}

function ladderCounts(promotions) {
  // distribution of where promotions currently sit
  const counts = { Absent: 0, Suggested: 0, Triggered: 0, Enforced: 0, Verified: 0, Critical: 0 };
  for (const p of promotions) counts[p.current] = (counts[p.current] || 0) + 1;
  return counts;
}

function summarize(overall, dimensions, promotions) {
  const weakest = [...dimensions].sort((a, b) => a.score - b.score).slice(0, 2).map((d) => d.label);
  return `${overall}% (${grade(overall)}). Weakest: ${weakest.join(", ")}. ${promotions.length} promotion(s) suggested.`;
}

// ---------- recommendations (grouped by category, with the component to create) ----------
// Each entry: [signal-label substring, mechanism to create, concrete action].
// A failing signal (ok:false) becomes a recommendation — so suggestions appear even on
// high-scoring harnesses (the "next-best" moves), not just on empty ones.
const RECS = {
  hooks: [
    ["hooks block present", "hook", "Create a hooks block in .claude/settings.json"],
    ["PostToolUse", "hook", "Add a PostToolUse hook to auto-format & lint edited files"],
    ["SessionStart", "hook", "Add a SessionStart hook to surface memory/context at startup"],
    ["Stop hook", "hook", "Add a Stop hook as an end-of-task gate/reminder"],
    ["Pre/UserPromptSubmit", "hook", "Add a UserPromptSubmit/PreToolUse hook to validate or inject before actions"],
    ["executable hook script", "hook", "Add an executable script under .claude/hooks/ (chmod +x)"],
  ],
  security: [
    ["settings.json present", "settings", "Add .claude/settings.json"],
    ["settings.local.json present", "settings", "Add .claude/settings.local.json for machine-specific permissions"],
    ["no plaintext secrets", "settings", "Move the plaintext secret to an env var/secret store and rotate it"],
    ["permission allow-list is scoped", "settings", "Replace any blanket wildcard with a scoped permission allow-list"],
  ],
  context: [
    ["CLAUDE.md present", "context", "Add a CLAUDE.md with standing project context"],
    ["CLAUDE.local.md", "context", "Add CLAUDE.local.md / CONTEXT.md for local context"],
    ["auto-memory directory", "memory", "Create the auto-memory directory with a MEMORY.md index"],
    ["MEMORY.md with", "memory", "Capture more durable lessons in memory (aim for ≥3 entries)"],
  ],
  skills: [
    ["skills present", "skill", "Create your first skill for a recurring procedure"],
    ["name+description frontmatter", "skill", "Fill in name+description frontmatter on every SKILL.md"],
    ["bundles helper scripts", "skill", "Add a scripts/ helper to a skill for its deterministic steps"],
  ],
  subagents: [
    ["subagents present", "subagent", "Add a scoped subagent (reviewer / verifier / explorer)"],
    ["specify a model", "subagent", "Set a model on each agent for cost control"],
    ["scope allowed-tools", "subagent", "Scope allowed-tools on each agent (least privilege)"],
  ],
  planverify: [
    ["_plan/", "process", "Write plan files under _plan/ before non-trivial work"],
    ["verification language", "context", "State verification expectations in CLAUDE.md (tests/proof before done)"],
    ["verifier/reviewer subagent", "subagent", "Add a verifier/reviewer subagent"],
    ["end-of-task gate", "hook", "Add a Stop hook or a review command as an end-of-task gate"],
  ],
  rules: [
    ["rules present", "rule", "Add rule files for conventions under .claude/rules/"],
    ["alwaysApply", "rule", "Mark a key rule alwaysApply for stronger enforcement"],
    ["glob-scoped", "rule", "Scope a rule to file globs so it triggers in context"],
  ],
  commands: [
    ["commands present", "command", "Add a slash command for a repeatable workflow"],
    ["orchestrates", "command", "Have a command orchestrate a subagent/skill"],
  ],
};

// ---------- project-specific mining ----------
// Reads the project's OWN guides/rules and names concrete things to promote — the actual
// directives to enforce and the actual tools/scripts to wire into hooks. This is what makes
// recommendations specific to THIS repo rather than generic boilerplate.
const TOOL_RE =
  /\b([\w./-]+\.(?:py|sh|js|mjs|ts))\b|\b(dprint|pytest|black|ruff|flake8|eslint|prettier|mypy|isort|tox|terraform|kubeval|yamllint)\b/g;
const VALIDATOR_RE = /(check|validate|verify|lint|format|test|guard|dprint|pytest|black|ruff|flake8|eslint|prettier|mypy|isort|yamllint|kubeval)/i;
const IMP_RE = /(?:^|\s)((?:always|never|must|don'?t|do not|ensure|validate|require|run)\b[^.\n]{0,130})/i;
const RUNVERB_RE = /\b(run|validate|verify|check|execute|enforce)\b/i;
const CONVENTION_RE = /\b(never|always|must|don'?t|do not)\b/i;

function mineProjectSpecifics(root) {
  const sources = [
    ["CLAUDE.md", read(path.join(root, "CLAUDE.md"))],
    ["CLAUDE.local.md", read(path.join(root, "CLAUDE.local.md"))],
  ];
  for (const f of listFiles(path.join(root, ".claude", "rules"), ".mdc").concat(
    listFiles(path.join(root, ".claude", "rules"), ".md")
  ))
    sources.push([path.relative(root, f), read(f)]);

  const directives = [];
  const tools = new Set();
  for (const [src, txt] of sources) {
    if (!txt) continue;
    for (const raw of txt.split("\n")) {
      const line = raw.replace(/[*`#>]/g, "").trim();
      const m = line.match(IMP_RE);
      if (m) {
        const text = m[1].replace(/\s+/g, " ").trim().slice(0, 110);
        const inLine = [...line.matchAll(TOOL_RE)].map((x) => x[1] || x[2]).filter(Boolean);
        if (text.length > 8) directives.push({ text, src, tools: inLine });
      }
      for (const t of [...line.matchAll(TOOL_RE)].map((x) => x[1] || x[2]).filter(Boolean))
        tools.add(t);
    }
  }
  const seen = new Set();
  const uniq = directives.filter((d) => {
    const k = d.text.toLowerCase();
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return { directives: uniq.slice(0, 12), tools: [...tools].slice(0, 12) };
}

// Turn mined specifics into recommendation items, bucketed by mechanism category.
function specificItems(spec) {
  const out = { hooks: [], security: [], skills: [], rules: [] };
  for (const t of spec.tools) {
    if (VALIDATOR_RE.test(t))
      out.hooks.push({
        mechanism: "hook",
        action: `Wire \`${t}\` into a hook so it runs automatically (PostToolUse for formatters; Stop/PreToolUse for guards)`,
        evidence: "referenced in your guides",
      });
  }
  for (const d of spec.directives) {
    if (d.tools.length || RUNVERB_RE.test(d.text)) {
      const tool = d.tools[0];
      out.hooks.push({
        mechanism: "hook",
        action: `Enforce “${d.text}”${tool ? ` — wire \`${tool}\`` : ""} as a hook`,
        evidence: d.src,
      });
    } else if (CONVENTION_RE.test(d.text)) {
      out.rules.push({
        mechanism: "rule",
        action: `Encode “${d.text}” as an alwaysApply rule`,
        evidence: d.src,
      });
    }
  }
  const dedupeCap = (arr) => {
    const s = new Set();
    return arr.filter((i) => (s.has(i.action) ? false : (s.add(i.action), true))).slice(0, 4);
  };
  for (const k of Object.keys(out)) out[k] = dedupeCap(out[k]);
  return out;
}

function buildRecommendations(dimensions, spec) {
  const specByKey = specificItems(spec || { directives: [], tools: [] });
  return dimensions
    .map((d) => {
      // project-specific items first (named for THIS repo), then generic next-best moves
      const items = [...(specByKey[d.key] || [])];
      for (const [match, mechanism, action] of RECS[d.key] || []) {
        const s = d.signals.find((x) => x.label.includes(match));
        if (s && !s.ok) items.push({ mechanism, action });
      }
      return {
        category: d.label,
        key: d.key,
        weight: d.weight,
        score: Math.round(d.score),
        status: items.length ? "improve" : "healthy",
        items,
      };
    })
    .sort((a, b) =>
      a.status === b.status ? b.weight - a.weight : a.status === "improve" ? -1 : 1
    );
}

// ---------- CLI ----------
function bar(pct, width = 20) {
  const fill = Math.round((pct / 100) * width);
  return "█".repeat(fill) + "·".repeat(width - fill);
}

// Canonical, deterministic report layout. Same harness → byte-identical output.
// Fixed widths and fixed section order so the format never varies between runs.
const RULE = "═".repeat(58);
const SUB = "─".repeat(58);
const LABEL_W = 22;

export function renderTerminal(r) {
  const L = [];
  const line = (s = "") => L.push(s);

  line(RULE);
  line("  HarnessIQ — Harness Audit");
  line(`  ${r.project}`);
  line(RULE);
  line("");

  // ① Scorecard
  line(`① SCORECARD          Overall ${r.overall}%  ·  Grade ${r.grade}`);
  line("");
  line(`  ${"Overall".padEnd(LABEL_W)} ${bar(r.overall)}  ${String(r.overall).padStart(3)}%`);
  line(`  ${SUB}`);
  for (const d of r.dimensions) {
    const score = String(Math.round(d.score)).padStart(3);
    line(`  ${d.label.padEnd(LABEL_W)} ${bar(d.score)}  ${score}/100  (w${d.weight})`);
  }
  if (r.penalties.length) {
    line("");
    for (const p of r.penalties) line(`  ⚠ PENALTY: ${p.label} — capped at ${p.cap}%`);
  }
  line("");

  // ② Ladder distribution
  line("② LADDER DISTRIBUTION");
  line("");
  const ladder = Object.entries(r.ladder).filter(([, v]) => v);
  line("  " + (ladder.length ? ladder.map(([k, v]) => `${k} ${v}`).join("  ·  ") : "—"));
  line("");

  // ③ Promotion map
  line("③ PROMOTION MAP  (sorted by leverage)");
  line("");
  if (!r.promotions.length) line("  ✓ Nothing to promote — harness is in great shape.");
  for (const p of r.promotions) {
    line(`  • ${p.behavior}`);
    line(`      ${p.current} → ${p.target}   ·   via ${p.mechanism}`);
    line(`      ${p.file}`);
    if (p.note) line(`      ${p.note}`);
  }
  line("");

  // ④ Recommendations by category
  line("④ RECOMMENDATIONS BY CATEGORY  (create these, by component type)");
  line("");
  for (const c of r.recommendations) {
    if (c.status === "healthy") {
      line(`  ✓ ${c.category.padEnd(LABEL_W)} healthy (${c.score}%)`);
      continue;
    }
    line(`  ▲ ${c.category} (${c.score}%)`);
    for (const it of c.items)
      line(`      • [${it.mechanism}] ${it.action}${it.evidence ? `  (from: ${it.evidence})` : ""}`);
  }
  line("");
  line(RULE);
  return L.join("\n");
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const gradeColor = (g) =>
  ({ A: "#0e7c6b", B: "#1f9d8f", C: "#c79a3a", D: "#cf7d3c", F: "#c4503e" }[g] || "#7a8a86");

export function renderHtml(r, generatedAt) {
  const gc = gradeColor(r.grade);
  const dimColor = (s) =>
    s >= 90 ? "#0e5a4f" : s >= 75 ? "#1f9d8f" : s >= 50 ? "#54bdac" : s >= 25 ? "#93d6c9" : "#cbe6df";
  const dims = r.dimensions
    .map((d) => {
      const s = Math.round(d.score);
      return `<div class="dim"><div class="dl">${esc(d.label)}<span class="w">w${d.weight}</span></div>
      <div class="track"><div class="fill" style="width:${s}%;background:${dimColor(s)}"></div></div>
      <div class="ds">${s}<span>/100</span></div></div>`;
    })
    .join("");
  const ladder =
    Object.entries(r.ladder)
      .filter(([, v]) => v)
      .map(([k, v]) => `<span class="pill">${esc(k)} · ${v}</span>`)
      .join("") || `<span class="pill">—</span>`;
  const proms = r.promotions.length
    ? r.promotions
        .map(
          (p) => `<div class="prom"><div class="pb">${esc(p.behavior)}</div>
        <div class="pm"><span class="mech">${esc(p.mechanism)}</span> ${esc(p.current)} → ${esc(p.target)} · <code>${esc(p.file)}</code></div>
        ${p.note ? `<div class="ev">${esc(p.note)}</div>` : ""}</div>`
        )
        .join("")
    : `<div class="rmut">✓ Nothing to promote — harness is in great shape.</div>`;
  const pen = r.penalties
    .map((p) => `<div class="pen">⚠ ${esc(p.label)} — score capped at ${p.cap}%</div>`)
    .join("");
  const recs = (r.recommendations || [])
    .map((c) =>
      c.status === "healthy"
        ? `<div class="rec ok"><span class="rcat">✓ ${esc(c.category)}</span><span class="rmut">healthy · ${c.score}%</span></div>`
        : `<div class="rec"><div class="rhead"><span class="rcat">${esc(c.category)}</span><span class="rmut">${c.score}%</span></div>
        <ul class="rlist">${c.items
          .map(
            (it) =>
              `<li><span class="mech">${esc(it.mechanism)}</span> ${esc(it.action)}${it.evidence ? ` <span class="ev">(from: ${esc(it.evidence)})</span>` : ""}</li>`
          )
          .join("")}</ul></div>`
    )
    .join("");
  const improveCount = (r.recommendations || []).filter((c) => c.status === "improve").length;
  const actionCount = (r.recommendations || []).reduce((n, c) => n + c.items.length, 0);
  const LEN = Math.PI * 50;
  const val = (r.overall / 100) * LEN;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HarnessIQ — ${esc(r.overall)}% (${esc(r.grade)})</title>
<style>
:root{--bg:#f4f3ee;--card:#fff;--ink:#26302e;--mut:#8a938f;--line:#e7e4dc;--gc:${gc}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);padding:28px;
font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:920px;margin:0 auto}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:18px}
h1{font-size:19px;margin:0;font-weight:700;letter-spacing:-.01em}
.proj{color:var(--mut);font-size:12px;margin-top:2px;word-break:break-all}
.gen{color:var(--mut);font-size:11px;white-space:nowrap}
.lbl{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
.cards{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:14px;margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
.card .big{font-size:30px;font-weight:700;line-height:1.1;margin-top:6px}
.gaugewrap{display:flex;align-items:center;gap:14px;margin-top:6px}
.gtxt b{font-size:30px}.gtxt .grade{color:var(--gc);font-weight:700;font-size:14px}
.rmut{color:var(--mut);font-size:12px;margin-top:4px}
.pen{background:#fbeee9;border:1px solid #f0cdbf;color:#b4502f;border-radius:12px;padding:10px 14px;margin-bottom:14px;font-size:13px}
.sec{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:14px}
.sec h2{font-size:15px;margin:0 0 14px;font-weight:700}
.dim{display:grid;grid-template-columns:200px 1fr 66px;gap:12px;align-items:center;margin:9px 0}
.dl{font-size:13px}.dl .w{color:var(--mut);font-size:11px;margin-left:6px}
.track{height:16px;background:#eef0ec;border-radius:6px;overflow:hidden}
.fill{height:100%;border-radius:6px}
.ds{text-align:right;font-weight:600;font-size:13px}.ds span{color:var(--mut);font-weight:400;font-size:11px}
.pill{display:inline-block;background:#eef3f1;border:1px solid var(--line);border-radius:99px;padding:4px 11px;margin:0 6px 6px 0;font-size:12px;color:#4a5a56}
.prom{padding:11px 0;border-top:1px solid var(--line)}.prom:first-child{border-top:none}
.pb{font-weight:600;font-size:13.5px}.pm{font-size:12.5px;color:#4a5a56;margin-top:3px}
.rec{padding:12px 0;border-top:1px solid var(--line)}.rec:first-child{border-top:none}
.rec.ok{display:flex;justify-content:space-between;align-items:center}
.rcat{font-weight:600;font-size:14px}.rhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.rlist{margin:0;padding:0;list-style:none}.rlist li{font-size:13px;margin:6px 0}
.mech{display:inline-block;background:var(--gc);color:#fff;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:600;margin-right:4px}
code{background:#eef0ec;border-radius:5px;padding:1px 6px;font-size:12px}
.ev{color:var(--mut);font-size:11px}
.foot{color:var(--mut);font-size:11px;margin-top:8px;text-align:center}
@media(max-width:640px){.cards{grid-template-columns:1fr}.dim{grid-template-columns:120px 1fr 56px}}
</style></head>
<body><div class="wrap">
<div class="head">
  <div><h1>HarnessIQ — Harness Audit</h1><div class="proj">${esc(r.project)}</div></div>
  <div class="gen">${generatedAt ? esc(generatedAt) : ""}</div>
</div>
${pen}
<div class="cards">
  <div class="card"><div class="lbl">Overall score</div>
    <div class="gaugewrap">
      <svg width="118" height="72" viewBox="0 0 120 72" aria-hidden="true">
        <path d="M10,64 A50,50 0 0 1 110,64" fill="none" stroke="#eef0ec" stroke-width="10" stroke-linecap="round"/>
        <path d="M10,64 A50,50 0 0 1 110,64" fill="none" stroke="${gc}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${val.toFixed(1)} ${LEN.toFixed(1)}"/>
      </svg>
      <div class="gtxt"><b>${r.overall}%</b><div class="grade">Grade ${esc(r.grade)}</div></div>
    </div>
  </div>
  <div class="card"><div class="lbl">To promote</div><div class="big">${r.promotions.length}</div><div class="rmut">behaviors below target</div></div>
  <div class="card"><div class="lbl">Recommendations</div><div class="big">${actionCount}</div><div class="rmut">${improveCount} categor${improveCount === 1 ? "y" : "ies"} to improve</div></div>
</div>
<div class="sec"><h2>Dimensions</h2>${dims}</div>
<div class="sec"><h2>Recommendations by category</h2>${recs}</div>
<div class="sec"><h2>Promotion map</h2>${proms}</div>
<div class="sec"><h2>Ladder distribution</h2>${ladder}</div>
<div class="foot">Generated by HarnessIQ${generatedAt ? " · " + esc(generatedAt) : ""}</div>
</div></body></html>`;
}

function main(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const valueOf = (flag, dflt) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const next = args[i + 1];
    return next && !next.startsWith("--") ? next : dflt;
  };
  const threshold = Number(valueOf("--threshold", 70));

  // positional target = first non-flag arg that isn't a flag's value
  const consumed = new Set();
  for (const f of ["--threshold", "--html"]) {
    const i = args.indexOf(f);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) consumed.add(i + 1);
  }
  const target = path.resolve(
    args.find((a, i) => !a.startsWith("--") && !consumed.has(i)) || process.cwd()
  );

  // --html with no explicit path → always the audited project's ROOT, not cwd.
  const htmlPath = flags.has("--html")
    ? valueOf("--html", path.join(target, "harness-report.html"))
    : null;

  const result = scoreHarness(target);

  let out = null;
  if (htmlPath) {
    out = path.resolve(htmlPath);
    fs.writeFileSync(out, renderHtml(result, new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"));
  }

  if (flags.has("--json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (out) process.stderr.write(`HTML report: file://${out}\n`);
  } else {
    if (!htmlPath || !flags.has("--quiet")) process.stdout.write(renderTerminal(result));
    // The HTML link is intentionally LAST so it's the final thing the user sees.
    if (out) process.stdout.write(`\n  📄 HTML report (open in a browser):\n     file://${out}\n`);
  }

  if (flags.has("--ci") && result.overall < threshold) {
    process.stderr.write(`\nHarnessIQ: ${result.overall}% < threshold ${threshold}%\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
