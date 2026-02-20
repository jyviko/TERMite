/**
 * TERMITE Report — tabular organism summary with mutations and stats.
 *
 * Usage:
 *     yarn report                          # latest run
 *     yarn report --run run-2026-02-20...  # specific run
 *     yarn report --workspace ./arena-workspace
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { OrganismState, PromptMutation } from "../types/index.js";

// ── CLI args ─────────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    workspace: { type: "string", default: "./arena-workspace" },
    run: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const workspaceRoot = values.workspace ?? "./arena-workspace";

// ── ANSI ─────────────────────────────────────────────────────────────
const RST = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAG = "\x1b[35m";

// ── Resolve run directory ────────────────────────────────────────────
function findRunDir(): string | null {
  if (values.run) {
    const explicit = values.run.startsWith("/")
      ? values.run
      : join(workspaceRoot, values.run);
    return existsSync(explicit) ? explicit : null;
  }

  if (!existsSync(workspaceRoot)) return null;

  const runs = readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("run-"))
    .map((e) => e.name)
    .sort();

  if (runs.length === 0) return null;
  return join(workspaceRoot, runs[runs.length - 1]!);
}

// ── Load organisms ───────────────────────────────────────────────────
function loadOrganisms(runDir: string): OrganismState[] {
  const organisms: OrganismState[] = [];

  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "shared") continue;
    const statePath = join(runDir, entry.name, "workspace", "state.json");
    try {
      organisms.push(JSON.parse(readFileSync(statePath, "utf-8")));
    } catch {
      // State file not written yet — skip
    }
  }

  return organisms.sort((a, b) => a.id.localeCompare(b.id));
}

// ── Formatting helpers ───────────────────────────────────────────────
function fmt(n: number): string {
  return (n ?? 0).toLocaleString();
}

function fmtSigned(n: number): string {
  const v = n ?? 0;
  return (v > 0 ? "+" : "") + v.toLocaleString();
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function padR(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s;
}

function pctStr(current: number, max: number): string {
  if (max <= 0) return "  0%";
  return `${Math.floor((current / max) * 100).toString().padStart(3)}%`;
}

function colorize(n: number, threshold = 0): string {
  return n > threshold ? GREEN : n === threshold ? YELLOW : RED;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

// ── Table rendering ──────────────────────────────────────────────────
interface Column {
  header: string;
  width: number;
  align: "left" | "right";
  value: (org: OrganismState) => string;
  color?: (org: OrganismState) => string;
}

const columns: Column[] = [
  {
    header: "ID",
    width: 14,
    align: "left",
    value: (o) => o.id,
    color: () => BOLD,
  },
  {
    header: "Status",
    width: 18,
    align: "left",
    value: (o) => (o.alive ? "ALIVE" : `DEAD (${o.causeOfDeath ?? "?"})`),
    color: (o) => (o.alive ? GREEN : RED),
  },
  {
    header: "Gen",
    width: 4,
    align: "right",
    value: (o) => String(o.generation),
  },
  {
    header: "Cyc",
    width: 4,
    align: "right",
    value: (o) => String(o.cycleCount),
  },
  {
    header: "Genome",
    width: 7,
    align: "right",
    value: (o) => `v${o.genome.version}`,
    color: (o) => (o.genome.version > 0 ? MAG : DIM),
  },
  {
    header: "Energy",
    width: 8,
    align: "right",
    value: (o) => pctStr(o.energy.reserves, o.energy.capacity),
    color: (o) => {
      const pct = o.energy.capacity > 0 ? o.energy.reserves / o.energy.capacity : 0;
      return pct > 0.4 ? GREEN : pct > 0.15 ? YELLOW : RED;
    },
  },
  {
    header: "Reserves",
    width: 9,
    align: "right",
    value: (o) => fmt(o.energy.reserves),
  },
  {
    header: "Spent(teq)",
    width: 11,
    align: "right",
    value: (o) => fmt(o.energy.spent),
    color: () => RED,
  },
  {
    header: "Earned",
    width: 9,
    align: "right",
    value: (o) => fmt(o.energy.earned),
    color: () => GREEN,
  },
  {
    header: "Net(teq)",
    width: 10,
    align: "right",
    value: (o) => fmtSigned(o.energy.earned - o.energy.spent),
    color: (o) => colorize(o.energy.earned - o.energy.spent),
  },
  {
    header: "BMR",
    width: 5,
    align: "right",
    value: (o) => String(o.energy.bmr),
  },
  {
    header: "Mems",
    width: 5,
    align: "right",
    value: (o) => String(o.memories.length),
  },
  {
    header: "Drives(O/M/G/C)",
    width: 17,
    align: "left",
    value: (o) => {
      const d = o.drives;
      return [
        d.orient.level.toFixed(1),
        d.metabolize.level.toFixed(1),
        d.grow.level.toFixed(1),
        d.coordinate.level.toFixed(1),
      ].join("/");
    },
    color: () => CYAN,
  },
];

function renderSeparator(): string {
  return DIM + columns.map((c) => "─".repeat(c.width)).join("─┼─") + RST;
}

function renderHeader(): string {
  const cells = columns.map((c) =>
    c.align === "right" ? padR(c.header, c.width) : pad(c.header, c.width)
  );
  return BOLD + CYAN + cells.join(" │ ") + RST;
}

function renderRow(org: OrganismState): string {
  const cells = columns.map((c) => {
    const raw = c.value(org);
    const aligned = c.align === "right" ? padR(raw, c.width) : pad(raw, c.width);
    const col = c.color ? c.color(org) : "";
    return col ? `${col}${aligned}${RST}` : aligned;
  });
  return cells.join(" │ ");
}

// ── Last cycle detail ────────────────────────────────────────────────
function renderLastCycle(org: OrganismState): string[] {
  const lines: string[] = [];
  const history = org.energy.cycleHistory;
  if (history.length === 0) {
    lines.push(`  ${DIM}no cycle data${RST}`);
    return lines;
  }

  const last = history[history.length - 1]!;
  const outcomeColor =
    last.outcome === "success" ? GREEN :
    last.outcome === "partial" ? YELLOW :
    last.outcome === "failure" ? RED : DIM;

  lines.push([
    `  Last cycle #${last.cycle}: `,
    `cost=${RED}${fmt(last.cost)}${RST} teq `,
    `income=${GREEN}${fmt(last.income)}${RST} `,
    `net=${colorize(last.net)}${fmtSigned(last.net)}${RST} `,
    `outcome=${outcomeColor}${last.outcome ?? "?"}${RST} `,
    `relevance=${last.goalRelevance.toFixed(2)}`,
    last.incomeSources ? ` ${DIM}(${last.incomeSources})${RST}` : "",
  ].join(""));

  // Token breakdown (only present in new-format data)
  if (last.outputTokens !== undefined) {
    const uncached = (last.inputTokens ?? 0) - (last.cacheCreationTokens ?? 0) - (last.cacheReadTokens ?? 0);
    lines.push(
      `  ${DIM}tokens: out=${last.outputTokens} in=${uncached} cache_w=${last.cacheCreationTokens ?? 0} cache_r=${last.cacheReadTokens ?? 0}${RST}`
    );
  }

  return lines;
}

// ── Mutations section ────────────────────────────────────────────────
function renderMutations(org: OrganismState): string[] {
  const lines: string[] = [];
  const history = org.genome.promptHistory;

  if (history.length === 0) {
    lines.push(`  ${DIM}no mutations${RST}`);
    return lines;
  }

  // Show the latest mutation
  const latest = history[history.length - 1]!;
  const age = formatAge(latest.timestamp);

  lines.push(
    `  ${MAG}Latest mutation${RST} ` +
    `${DIM}(${latest.phase} v${latest.version} → v${latest.version + 1}, ${age})${RST}`
  );

  // Show a diff-style summary: truncated old → new
  const termWidth = process.stdout.columns ?? 120;
  const maxPromptLen = Math.max(40, termWidth - 12);

  lines.push(`  ${RED}- ${truncate(latest.oldPrompt.replace(/\n/g, " "), maxPromptLen)}${RST}`);
  lines.push(`  ${GREEN}+ ${truncate(latest.newPrompt.replace(/\n/g, " "), maxPromptLen)}${RST}`);

  if (history.length > 1) {
    lines.push(`  ${DIM}(${history.length} total mutations)${RST}`);
  }

  return lines;
}

function formatAge(ts: number): string {
  const delta = Date.now() - ts;
  const secs = Math.floor(delta / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Aggregate stats ──────────────────────────────────────────────────
function renderAggregates(organisms: OrganismState[]): string[] {
  const lines: string[] = [];
  const n = organisms.length;
  const alive = organisms.filter((o) => o.alive).length;
  const totalSpent = organisms.reduce((s, o) => s + o.energy.spent, 0);
  const totalEarned = organisms.reduce((s, o) => s + o.energy.earned, 0);
  const totalCycles = organisms.reduce((s, o) => s + o.cycleCount, 0);
  const totalMutations = organisms.reduce((s, o) => s + o.genome.promptHistory.length, 0);
  const totalMemories = organisms.reduce((s, o) => s + o.memories.length, 0);
  const avgGenomeVersion = organisms.reduce((s, o) => s + o.genome.version, 0) / (n || 1);

  lines.push(`${BOLD}${CYAN}── Aggregates ──────────────────────────────────────────${RST}`);
  lines.push(
    `  Organisms: ${BOLD}${n}${RST}  ` +
    `Alive: ${alive > 0 ? GREEN : RED}${alive}${RST}  ` +
    `Dead: ${RED}${n - alive}${RST}`
  );
  lines.push(
    `  Total cycles: ${fmt(totalCycles)}  ` +
    `Total mutations: ${MAG}${totalMutations}${RST}  ` +
    `Avg genome: v${avgGenomeVersion.toFixed(1)}  ` +
    `Total memories: ${totalMemories}`
  );
  lines.push(
    `  Total spent: ${RED}${fmt(totalSpent)}${RST}  ` +
    `Total earned: ${GREEN}${fmt(totalEarned)}${RST}  ` +
    `Net: ${colorize(totalEarned - totalSpent)}${fmtSigned(totalEarned - totalSpent)}${RST}`
  );

  return lines;
}

// ── Main ─────────────────────────────────────────────────────────────
function main(): void {
  const runDir = findRunDir();

  if (!runDir) {
    console.error(`${RED}No run directory found in ${workspaceRoot}${RST}`);
    process.exit(1);
  }

  const organisms = loadOrganisms(runDir);

  if (organisms.length === 0) {
    console.error(`${YELLOW}No organisms found in ${runDir}${RST}`);
    process.exit(1);
  }

  // JSON output mode
  if (values.json) {
    const report = organisms.map((o) => ({
      id: o.id,
      alive: o.alive,
      causeOfDeath: o.causeOfDeath,
      generation: o.generation,
      cycleCount: o.cycleCount,
      genomeVersion: o.genome.version,
      energy: {
        reserves: o.energy.reserves,
        capacity: o.energy.capacity,
        spent: o.energy.spent,
        earned: o.energy.earned,
        lifetime: o.energy.earned - o.energy.spent,
        bmr: o.energy.bmr,
      },
      drives: {
        orient: o.drives.orient.level,
        metabolize: o.drives.metabolize.level,
        grow: o.drives.grow.level,
        coordinate: o.drives.coordinate.level,
      },
      memories: o.memories.length,
      mutations: o.genome.promptHistory.length,
      latestMutation: o.genome.promptHistory.length > 0
        ? o.genome.promptHistory[o.genome.promptHistory.length - 1]
        : null,
      lastCycle: o.energy.cycleHistory.length > 0
        ? o.energy.cycleHistory[o.energy.cycleHistory.length - 1]
        : null,
    }));
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Header
  const runName = runDir.split("/").pop() ?? runDir;
  console.log();
  console.log(`${BOLD}${CYAN} TERMITE Report${RST}  ${DIM}${runName}${RST}`);
  console.log();

  // Aggregates
  for (const line of renderAggregates(organisms)) {
    console.log(line);
  }
  console.log();

  // Organism table
  console.log(`${BOLD}${CYAN}── Organisms ───────────────────────────────────────────${RST}`);
  console.log(renderHeader());
  console.log(renderSeparator());

  for (const org of organisms) {
    console.log(renderRow(org));
  }

  console.log();

  // Per-organism detail: last cycle + mutations
  console.log(`${BOLD}${CYAN}── Last Cycle & Mutations ──────────────────────────────${RST}`);

  for (const org of organisms) {
    console.log();
    console.log(`${BOLD}${org.id}${RST}  ${org.alive ? `${GREEN}ALIVE${RST}` : `${RED}DEAD${RST}`}`);
    for (const line of renderLastCycle(org)) {
      console.log(line);
    }
    for (const line of renderMutations(org)) {
      console.log(line);
    }
  }

  console.log();
}

main();
