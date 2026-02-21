/**
 * TERMITE Report — tabular organism summary with mutations and stats.
 *
 * Usage:
 *     yarn report                          # latest run, all organisms
 *     yarn report --org org-abc12345       # detail view for one organism
 *     yarn report --org abc1              # partial ID match
 *     yarn report --org abc1 --json       # raw JSON for one organism
 *     yarn report --run run-2026-02-20...  # specific run
 *     yarn report --workspace ./arena-workspace
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { OrganismState } from "../types/index.js";

// ── CLI args ─────────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    workspace: { type: "string", default: "./arena-workspace" },
    run: { type: "string" },
    org: { type: "string" },
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
    const statePath = join(runDir, entry.name, "state.json");
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

// ── Model label ──────────────────────────────────────────────────────
function modelLabel(model?: string): string {
  if (!model) return "?";
  if (model.includes("haiku")) return "Hai";
  if (model.includes("sonnet")) return "Son";
  if (model.includes("opus")) return "Opu";
  return model.slice(0, 3);
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

  const ml = modelLabel(last.model);
  const modelColor = ml === "Son" ? MAG : ml === "Hai" ? CYAN : DIM;

  lines.push([
    `  Last cycle #${last.cycle} ${modelColor}[${ml}]${RST}: `,
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

// ── Detail view for single organism ──────────────────────────────────

function renderDetailSection(title: string): string {
  return `\n${BOLD}${CYAN}── ${title} ${"─".repeat(Math.max(0, 56 - title.length))}${RST}`;
}

function renderDetailIdentity(org: OrganismState): string[] {
  const lines: string[] = [];
  lines.push(renderDetailSection("Identity"));

  const status = org.alive ? `${GREEN}ALIVE${RST}` : `${RED}DEAD${RST}`;
  const born = new Date(org.bornAt).toISOString().replace("T", " ").slice(0, 19);

  lines.push(`  ID:             ${BOLD}${org.id}${RST}`);
  lines.push(`  Status:         ${status}${org.causeOfDeath ? `  (${org.causeOfDeath})` : ""}`);
  lines.push(`  Generation:     ${org.generation}${org.parentId ? `  parent=${org.parentId}` : ""}`);
  lines.push(`  Born:           ${born}`);
  lines.push(`  Cycles:         ${org.cycleCount}`);
  lines.push(`  Mode:           ${org.mode}`);
  lines.push(`  Model:          ${org.genome.routing.thinking.model}`);
  if (org.goal) lines.push(`  Goal:           ${org.goal}`);

  return lines;
}

function renderDetailEnergy(org: OrganismState): string[] {
  const lines: string[] = [];
  const e = org.energy;
  lines.push(renderDetailSection("Energy"));

  const pct = e.capacity > 0 ? Math.floor((e.reserves / e.capacity) * 100) : 0;
  const net = e.earned - e.spent;

  lines.push(`  Budget:         ${fmt(e.budget)}`);
  lines.push(`  Reserves:       ${fmt(e.reserves)} / ${fmt(e.capacity)}  (${pct}%)`);
  lines.push(`  Spent:          ${RED}${fmt(e.spent)}${RST}`);
  lines.push(`  Earned:         ${GREEN}${fmt(e.earned)}${RST}  (pool: ${fmt(e.earnedFromPrizes)})`);
  lines.push(`  Net:            ${colorize(net)}${fmtSigned(net)}${RST}`);
  lines.push(`  BMR:            ${e.bmr}/cycle`);
  lines.push(`  Avg cycle cost: ${fmt(Math.round(e.cycleHistory.reduce((s, r) => s + r.cost, 0) / Math.max(1, e.cycleHistory.length)))}`);

  return lines;
}

function renderDetailCycleHistory(org: OrganismState): string[] {
  const lines: string[] = [];
  const history = org.energy.cycleHistory;
  lines.push(renderDetailSection(`Cycle History (${history.length} cycles)`));

  if (history.length === 0) {
    lines.push(`  ${DIM}no cycle data${RST}`);
    return lines;
  }

  // Column widths
  const hdrs = ["#", "Model", "Cost", "Income", "Net", "Outcome", "Rel", "Out", "In", "Cache W", "Cache R"];
  const ws =   [ 4,   5,      9,      9,        10,     8,         5,     7,     7,    8,        8];

  // Header
  const hdr = hdrs.map((h, i) => padR(h, ws[i]!)).join("  ");
  lines.push(`  ${BOLD}${hdr}${RST}`);
  lines.push(`  ${DIM}${ws.map((w) => "─".repeat(w)).join("──")}${RST}`);

  // Rows
  for (const c of history) {
    const ml = modelLabel(c.model);
    const outcomeColor =
      c.outcome === "success" ? GREEN :
      c.outcome === "partial" ? YELLOW :
      c.outcome === "failure" ? RED : DIM;
    const netColor = colorize(c.net);

    const cells = [
      padR(String(c.cycle), ws[0]!),
      padR(ml, ws[1]!),
      `${RED}${padR(fmt(c.cost), ws[2]!)}${RST}`,
      `${GREEN}${padR(fmt(c.income), ws[3]!)}${RST}`,
      `${netColor}${padR(fmtSigned(c.net), ws[4]!)}${RST}`,
      `${outcomeColor}${padR(c.outcome ?? "?", ws[5]!)}${RST}`,
      padR(c.goalRelevance.toFixed(2), ws[6]!),
      padR(fmt(c.outputTokens ?? 0), ws[7]!),
      padR(fmt(c.inputTokens ?? 0), ws[8]!),
      padR(fmt(c.cacheCreationTokens ?? 0), ws[9]!),
      padR(fmt(c.cacheReadTokens ?? 0), ws[10]!),
    ];
    lines.push(`  ${cells.join("  ")}`);
  }

  // Totals
  const totCost = history.reduce((s, c) => s + c.cost, 0);
  const totIncome = history.reduce((s, c) => s + c.income, 0);
  const totNet = totIncome - totCost;
  const totOut = history.reduce((s, c) => s + (c.outputTokens ?? 0), 0);
  const totIn = history.reduce((s, c) => s + (c.inputTokens ?? 0), 0);
  const totCW = history.reduce((s, c) => s + (c.cacheCreationTokens ?? 0), 0);
  const totCR = history.reduce((s, c) => s + (c.cacheReadTokens ?? 0), 0);

  lines.push(`  ${DIM}${ws.map((w) => "─".repeat(w)).join("──")}${RST}`);
  const totCells = [
    padR("", ws[0]!),
    padR("Total", ws[1]!),
    `${RED}${padR(fmt(totCost), ws[2]!)}${RST}`,
    `${GREEN}${padR(fmt(totIncome), ws[3]!)}${RST}`,
    `${colorize(totNet)}${padR(fmtSigned(totNet), ws[4]!)}${RST}`,
    padR("", ws[5]!),
    padR("", ws[6]!),
    padR(fmt(totOut), ws[7]!),
    padR(fmt(totIn), ws[8]!),
    padR(fmt(totCW), ws[9]!),
    padR(fmt(totCR), ws[10]!),
  ];
  lines.push(`  ${BOLD}${totCells.join("  ")}${RST}`);

  // Cache ratio
  const totalInput = totIn;
  const cachedInput = totCW + totCR;
  const cachePct = totalInput > 0 ? Math.floor((cachedInput / totalInput) * 100) : 0;
  lines.push(`\n  ${DIM}Cache hit ratio: ${cachedInput}/${totalInput} input tokens = ${cachePct}%${RST}`);

  return lines;
}

function renderDetailDrives(org: OrganismState): string[] {
  const lines: string[] = [];
  lines.push(renderDetailSection("Drives"));

  const driveNames: Array<{ key: string; label: string }> = [
    { key: "orient", label: "Orient" },
    { key: "metabolize", label: "Metabolize" },
    { key: "grow", label: "Grow" },
    { key: "coordinate", label: "Coordinate" },
  ];

  for (const { key, label } of driveNames) {
    const d = org.drives[key as keyof typeof org.drives];
    const barLen = 20;
    const filled = Math.round(d.level * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    const levelColor = d.level > d.threshold ? GREEN : d.level > d.threshold * 0.5 ? YELLOW : RED;
    lines.push(
      `  ${pad(label, 12)} ${levelColor}${bar}${RST} ${(d.level * 100).toFixed(0).padStart(3)}%  ` +
      `${DIM}thresh=${(d.threshold * 100).toFixed(0)}% decay=${d.decayRate.toFixed(3)} grow=${d.growthRate.toFixed(3)}${RST}`
    );
  }

  return lines;
}

function renderDetailMemories(org: OrganismState): string[] {
  const lines: string[] = [];
  lines.push(renderDetailSection(`Memories (${org.memories.length})`));

  if (org.memories.length === 0) {
    lines.push(`  ${DIM}no memories${RST}`);
    return lines;
  }

  // Sort by importance descending
  const sorted = [...org.memories].sort((a, b) => b.importance - a.importance);
  const termWidth = process.stdout.columns ?? 120;
  const contentWidth = Math.max(30, termWidth - 42);

  lines.push(`  ${BOLD}${padR("Imp", 4)}  ${pad("Type", 10)}  ${padR("Acc", 4)}  ${pad("Content", contentWidth)}${RST}`);
  lines.push(`  ${DIM}${"─".repeat(4)}──${"─".repeat(10)}──${"─".repeat(4)}──${"─".repeat(contentWidth)}${RST}`);

  for (const m of sorted) {
    const impColor = m.importance >= 0.7 ? GREEN : m.importance >= 0.4 ? YELLOW : DIM;
    lines.push(
      `  ${impColor}${padR(m.importance.toFixed(1), 4)}${RST}  ` +
      `${pad(m.type, 10)}  ` +
      `${padR(String(m.accessCount), 4)}  ` +
      `${truncate(m.content.replace(/\n/g, " "), contentWidth)}`
    );
  }

  return lines;
}

function renderDetailGenome(org: OrganismState): string[] {
  const lines: string[] = [];
  const g = org.genome;
  lines.push(renderDetailSection("Genome"));

  lines.push(`  Version:   ${MAG}v${g.version}${RST}  (${g.promptHistory.length} mutations)`);
  lines.push(`  Routing:   thinking=${g.routing.thinking.model} (${g.routing.thinking.maxTokens})`);
  lines.push(`             resolve=${g.routing.resolve.model} (${g.routing.resolve.maxTokens})`);

  const termWidth = process.stdout.columns ?? 120;
  const promptWidth = Math.max(40, termWidth - 4);
  lines.push(`\n  ${BOLD}System Prompt:${RST}`);
  // Wrap system prompt at terminal width
  const promptLines = g.systemPrompt.split("\n");
  for (const pl of promptLines) {
    if (pl.length <= promptWidth) {
      lines.push(`  ${DIM}${pl}${RST}`);
    } else {
      for (let i = 0; i < pl.length; i += promptWidth) {
        lines.push(`  ${DIM}${pl.slice(i, i + promptWidth)}${RST}`);
      }
    }
  }

  if (g.promptHistory.length > 0) {
    lines.push(`\n  ${BOLD}Mutation History:${RST}`);
    for (const mut of g.promptHistory) {
      const age = formatAge(mut.timestamp);
      lines.push(`  ${MAG}v${mut.version}→v${mut.version + 1}${RST} ${DIM}(${mut.phase}, ${age})${RST}`);
      lines.push(`    ${RED}- ${truncate(mut.oldPrompt.replace(/\n/g, " "), promptWidth - 6)}${RST}`);
      lines.push(`    ${GREEN}+ ${truncate(mut.newPrompt.replace(/\n/g, " "), promptWidth - 6)}${RST}`);
    }
  }

  return lines;
}

function renderOrgDetail(org: OrganismState): void {
  console.log();
  console.log(`${BOLD}${CYAN} TERMITE Organism Detail${RST}`);

  for (const line of renderDetailIdentity(org)) console.log(line);
  for (const line of renderDetailEnergy(org)) console.log(line);
  for (const line of renderDetailCycleHistory(org)) console.log(line);
  for (const line of renderDetailDrives(org)) console.log(line);
  for (const line of renderDetailMemories(org)) console.log(line);
  for (const line of renderDetailGenome(org)) console.log(line);
  console.log();
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

  // Single organism detail mode
  if (values.org) {
    const match = organisms.find((o) =>
      o.id === values.org || o.id.includes(values.org!)
    );
    if (!match) {
      console.error(`${RED}Organism "${values.org}" not found.${RST} Available:`);
      for (const o of organisms) {
        console.error(`  ${o.id}${o.alive ? "" : ` ${DIM}(dead)${RST}`}`);
      }
      process.exit(1);
    }
    if (values.json) {
      console.log(JSON.stringify(match, null, 2));
    } else {
      renderOrgDetail(match);
    }
    return;
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
