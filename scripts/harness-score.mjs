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

  return {
    project: root,
    overall,
    grade: grade(overall),
    dimensions,
    ladder: ladderCounts(promotions),
    promotions,
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

// ---------- CLI ----------
function bar(pct, width = 20) {
  const fill = Math.round((pct / 100) * width);
  return "█".repeat(fill) + "·".repeat(width - fill);
}

function renderTerminal(r) {
  const L = [];
  L.push("");
  L.push(`  HarnessIQ — ${r.project}`);
  L.push(`  ${"=".repeat(52)}`);
  L.push(`  OVERALL  ${bar(r.overall)}  ${r.overall}%  (${r.grade})`);
  L.push("");
  for (const d of r.dimensions) {
    L.push(`  ${d.label.padEnd(24)} ${bar(d.score, 14)} ${String(Math.round(d.score)).padStart(3)}%  (w${d.weight})`);
  }
  if (r.penalties.length) {
    L.push("");
    for (const p of r.penalties) L.push(`  ⚠ PENALTY: ${p.label} (capped at ${p.cap}%)`);
  }
  L.push("");
  L.push(`  LADDER: ` + Object.entries(r.ladder).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join("  ·  "));
  L.push("");
  L.push(`  PROMOTION MAP (improvement guideline)`);
  L.push(`  ${"-".repeat(52)}`);
  if (!r.promotions.length) L.push("  Nothing to promote — harness is in great shape.");
  for (const p of r.promotions) {
    L.push(`  • ${p.behavior}`);
    L.push(`      ${p.current} → ${p.target}   via ${p.mechanism}`);
    L.push(`      ${p.file}`);
    if (p.note) L.push(`      ${p.note}`);
  }
  L.push("");
  return L.join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const thIdx = args.indexOf("--threshold");
  const threshold = thIdx >= 0 ? Number(args[thIdx + 1]) : 70;
  const target = args.find((a) => !a.startsWith("--") && a !== String(threshold)) || process.cwd();

  const result = scoreHarness(target);

  if (flags.has("--json")) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else process.stdout.write(renderTerminal(result));

  if (flags.has("--ci") && result.overall < threshold) {
    process.stderr.write(`\nHarnessIQ: ${result.overall}% < threshold ${threshold}%\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
