/**
 * TERM Arena Dashboard — live terminal monitor.
 *
 * Reads agent state files and displays real-time status.
 * Run alongside the arena:
 *
 *     yarn arena --agents 3 --budget 300000 &
 *     yarn dash
 *
 * 1:1 port of the Python curses dashboard.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    workspace: { type: "string", default: "./arena-workspace" },
    interval: { type: "string", default: "1500" },
    run: { type: "string" },
  },
});

const workspaceRoot = values.workspace ?? "./arena-workspace";
const REFRESH_INTERVAL = parseInt(values.interval ?? "1500", 10);

let hideDead = false;
let tierFilter: number | null = null; // null = show all, 1-6 = show only that tier

/** Find the latest run-* directory, or use --run if specified */
function findRunDir(): string {
  if (values.run) return join(workspaceRoot, values.run);
  if (!existsSync(workspaceRoot)) return workspaceRoot;

  const runs = readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("run-"))
    .map((e) => e.name)
    .sort();

  if (runs.length === 0) return workspaceRoot;
  return join(workspaceRoot, runs[runs.length - 1]!);
}

let SAVES_DIR = findRunDir();

const SPARK = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
const MIN_COL_W = 28;
const CARD_ROWS = 14;

// ── ANSI color codes (match curses color pairs) ────────────────────
const RST = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAG = "\x1b[35m";

// ── Model label ──────────────────────────────────────────────────────
function modelLabel(model?: string): string {
  if (!model) return "?";
  if (model.includes("haiku")) return "H";
  if (model.includes("sonnet")) return "S";
  if (model.includes("opus")) return "O";
  return "?";
}

// ── Helpers (identical to Python) ──────────────────────────────────
function sparkline(vals: number[], width = 12): string {
  if (vals.length === 0) return "";
  const sl = vals.slice(-width);
  const lo = Math.min(...sl);
  const hi = Math.max(...sl);
  const spread = hi !== lo ? hi - lo : 1;
  return sl.map((v) => SPARK[Math.min(7, Math.floor(((v - lo) / spread) * 7))]).join("");
}

function pctBar(current: number, maximum: number, width = 10): string {
  if (maximum <= 0) return "\u2591".repeat(width);
  const ratio = Math.max(0, Math.min(1, current / maximum));
  const filled = Math.floor(ratio * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

function fmt(n: number): string {
  return (n ?? 0).toLocaleString();
}

function fmtSigned(n: number): string {
  const v = n ?? 0;
  return (v > 0 ? "+" : "") + v.toLocaleString();
}

// ── Terminal primitives ────────────────────────────────────────────
function getSize(): [number, number] {
  return [process.stdout.rows ?? 24, process.stdout.columns ?? 80];
}

function moveTo(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`;
}

/** Safe write — clips to screen bounds like curses addnstr */
function safe(buf: string[], row: number, col: number, text: string, color = ""): void {
  const [h, w] = getSize();
  if (row < 0 || row >= h || col >= w) return;
  const maxLen = w - col;
  // Strip ANSI to measure visible length
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  let out = text;
  if (visible.length > maxLen) {
    let vis = 0;
    let cut = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\x1b") {
        const end = text.indexOf("m", i);
        if (end !== -1) { i = end; continue; }
      }
      vis++;
      if (vis >= maxLen) { cut = i + 1; break; }
    }
    out = text.slice(0, cut);
  }
  buf.push(`${moveTo(row, col)}${color}${out}${RST}`);
}

// ── Data loading ───────────────────────────────────────────────────
interface AgentData {
  // camelCase (TS state) with fallbacks to snake_case (Python state)
  [key: string]: unknown;
}

function loadCensus(): Map<string, AgentData> {
  const censusPath = join(SAVES_DIR, "shared", "_census.json");
  try {
    const data = JSON.parse(readFileSync(censusPath, "utf-8"));
    const map = new Map<string, AgentData>();
    if (Array.isArray(data.agents)) {
      for (const a of data.agents) {
        const id = String(a.id ?? "");
        if (id) map.set(id, a);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function loadAgents(): AgentData[] {
  if (!existsSync(SAVES_DIR)) return [];
  const census = loadCensus();
  const agents: AgentData[] = [];
  for (const entry of readdirSync(SAVES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "shared") continue;
    const statePath = join(SAVES_DIR, entry.name, "state.json");
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      // Load cycle history from metrics.jsonl (SSoT)
      const energyObj = state.energy ?? {};
      const metricsPath = join(SAVES_DIR, entry.name, "metrics.jsonl");
      try {
        const raw = readFileSync(metricsPath, "utf-8");
        const records = raw
          .split("\n")
          .filter((l: string) => l.trim().length > 0)
          .map((l: string) => JSON.parse(l));
        if (records.length > 0) {
          energyObj.cycleHistory = records;
        }
      } catch {
        // No metrics file — legacy state.json may still have cycleHistory
      }
      // Merge live tier from census (entry.json only exists after death/shutdown)
      const id = String(state.id ?? state.agent_id ?? "");
      const cEntry = census.get(id);
      if (cEntry) {
        state._challengesSolved = gn(cEntry, "challengesSolved");
      }
      agents.push(state);
    } catch {
      // Not written yet
    }
  }
  return agents.sort((a, b) => {
    const aid = String(a.id ?? a.agent_id ?? "");
    const bid = String(b.id ?? b.agent_id ?? "");
    return aid.localeCompare(bid);
  });
}

function loadGoalBoard(): AgentData[] {
  const boardPath = join(SAVES_DIR, "shared", "_goal_board.json");
  try {
    const data = JSON.parse(readFileSync(boardPath, "utf-8"));
    return Array.isArray(data.goals) ? data.goals : [];
  } catch {
    return [];
  }
}

interface PoolData {
  balance: number;
  totalWithdrawn: number;
  totalDeposited: number;
  totalRegenerated: number;
  maxBalance: number;
  regenPerCycle: number;
}

function loadPool(): PoolData | null {
  const poolPath = join(SAVES_DIR, "shared", "_pool.json");
  try {
    return JSON.parse(readFileSync(poolPath, "utf-8"));
  } catch {
    return null;
  }
}

interface PoolEvent {
  t: string;
  type: "withdraw" | "deposit" | "regen";
  amount: number;
  balance: number;
  agentId?: string;
}

function loadPoolLedger(maxEvents = 2000): PoolEvent[] {
  const ledgerPath = join(SAVES_DIR, "shared", "_pool_ledger.jsonl");
  try {
    const raw = readFileSync(ledgerPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    // Take last N lines for performance
    const tail = lines.slice(-maxEvents);
    return tail.map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Downsample pool balance history to N points for sparkline */
function sampleBalances(events: PoolEvent[], points: number): number[] {
  if (events.length === 0) return [];
  if (events.length <= points) return events.map((e) => e.balance);
  const step = events.length / points;
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    out.push(events[Math.floor(i * step)]!.balance);
  }
  // Always include the latest
  out[out.length - 1] = events[events.length - 1]!.balance;
  return out;
}

/** Compute flow rates from recent ledger events (per-minute) */
function flowRates(events: PoolEvent[]): { wRate: number; dRate: number; rRate: number } {
  if (events.length < 2) return { wRate: 0, dRate: 0, rRate: 0 };
  // Use last 200 events for rate calc
  const recent = events.slice(-200);
  const t0 = new Date(recent[0]!.t).getTime();
  const t1 = new Date(recent[recent.length - 1]!.t).getTime();
  const mins = Math.max(1, (t1 - t0) / 60_000);
  let w = 0, d = 0, r = 0;
  for (const e of recent) {
    if (e.type === "withdraw") w += e.amount;
    else if (e.type === "deposit") d += e.amount;
    else if (e.type === "regen") r += e.amount;
  }
  return { wRate: Math.floor(w / mins), dRate: Math.floor(d / mins), rRate: Math.floor(r / mins) };
}

// Field accessors — handle both camelCase and snake_case
function g(obj: AgentData, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

function gn(obj: AgentData, ...keys: string[]): number {
  const v = g(obj, ...keys);
  return typeof v === "number" ? v : 0;
}

function gs(obj: AgentData, ...keys: string[]): string {
  const v = g(obj, ...keys);
  return typeof v === "string" ? v : "";
}

// ── Card renderer (matches Python draw_card exactly) ───────────────
function drawCard(buf: string[], org: AgentData, r0: number, c0: number, colW: number): void {
  let r = r0;

  // Row 0: agent ID (strip prefix, show UUID only)
  const rawId = gs(org, "id", "agent_id");
  const oid = rawId.replace(/^(agent|org)-/, "").slice(0, 8) || "?";
  safe(buf, r, c0, ` [${oid}]`, BOLD);
  r++;

  // Row 1: separator
  safe(buf, r, c0, "─".repeat(colW - 1), CYAN);
  r++;

  // Row 2: active / stopped
  const active = Boolean(g(org, "active"));
  if (active) {
    safe(buf, r, c0, " \u25cf ACTIVE", `${GREEN}${BOLD}`);
  } else {
    const cause = gs(org, "stopReason", "stop_reason") || "stopped";
    safe(buf, r, c0, ` \u2717 ${cause}`.slice(0, colW - 1), RED);
  }
  r++;

  // Row 3: cycle + config version
  const cyc = gn(org, "cycleCount", "cycle_count");
  const cfg = (g(org, "config") ?? {}) as AgentData;
  const gv = gn(cfg, "version");
  safe(buf, r, c0, ` Cyc ${cyc}  v${gv}`);
  r++;

  // Row 4: energy bar + reserves
  const e = (g(org, "energy") ?? {}) as AgentData;
  const res = gn(e, "reserves");
  const cap = gn(e, "capacity") || 1;
  const pct = Math.floor((res / cap) * 100);
  const ec = pct > 40 ? GREEN : pct > 15 ? YELLOW : RED;
  safe(buf, r, c0, ` ${String(pct).padStart(3)}% ${pctBar(res, cap, 10)}`, ec);
  safe(buf, r, c0 + 17, `${fmt(res)}`.slice(0, colW - 18), ec);
  r++;

  // Row 5: capacity + base cost
  safe(buf, r, c0, ` Cap=${fmt(cap)} Base=${gn(e, "baseCost", "bmr")}`);
  r++;

  // Row 6-7: last cycle cost/income/net/yield
  const ch = (g(org, "energy") as AgentData)?.cycleHistory ?? (g(org, "energy") as AgentData)?.cycle_history;
  const history = Array.isArray(ch) ? ch as AgentData[] : [];
  if (history.length > 0) {
    const last = history[history.length - 1]!;
    const ln = gn(last, "net");
    const nc = ln >= 0 ? GREEN : RED;
    const yld = gn(last, "goalRelevance", "goal_relevance");
    const ml = modelLabel(gs(last, "model"));
    const mc = ml === "S" ? MAG : ml === "H" ? CYAN : "";
    safe(buf, r, c0, ` ${mc}[${ml}]${RST} c=${fmt(gn(last, "cost"))} i=${fmt(gn(last, "income"))}`);
    r++;
    safe(buf, r, c0, ` net=${fmtSigned(ln)} yield=${yld.toFixed(2)}`, nc);
  } else {
    r++;
  }
  r++;

  // Row 8: averages over last 10
  if (history.length >= 2) {
    const sl = history.slice(-10);
    const ac = sl.reduce((s, x) => s + gn(x, "cost"), 0) / sl.length;
    const ai = sl.reduce((s, x) => s + gn(x, "income"), 0) / sl.length;
    const an = ai - ac;
    const nc = an >= 0 ? GREEN : RED;
    safe(buf, r, c0, ` Avg: ${ac.toFixed(0)}/${ai.toFixed(0)}`, nc);
  }
  r++;

  // Row 9: sparkline
  if (history.length > 0) {
    const nets = history.map((x) => gn(x, "net"));
    safe(buf, r, c0, ` ${sparkline(nets, colW - 4)}`, YELLOW);
  }
  r++;

  // Row 10: lifetime balance
  const lifetime = gn(e, "earned") - gn(e, "spent");
  const lc = lifetime >= 0 ? GREEN : RED;
  safe(buf, r, c0, ` Life: ${fmtSigned(lifetime)}`, lc);
  r++;

  // Row 11: challenges solved + tools
  const solved = gn(org, "_challengesSolved");
  const solvedLabel = `C:${solved}`;
  const tools = g(org, "tool_registry", "toolRegistry");
  const toolNames = Array.isArray(tools) && tools.length > 0
    ? tools.map((t: AgentData) => gs(t, "name")).join(",")
    : "";
  const solvedColor = solved >= 10 ? GREEN : solved >= 5 ? YELLOW : "";
  if (toolNames) {
    safe(buf, r, c0, ` ${solvedLabel} ${toolNames}`.slice(0, colW - 1), `${solvedColor}`);
  } else {
    safe(buf, r, c0, ` ${solvedLabel}`, solvedColor);
  }
  r++;

  // Row 12: memories + drives
  const mems = g(org, "memories");
  const memCount = Array.isArray(mems) ? mems.length : 0;
  const drives = (g(org, "drives") ?? {}) as AgentData;
  const parts: string[] = [];
  for (const [name, d] of Object.entries(drives)) {
    if (d && typeof d === "object" && d !== null) {
      const lv = (d as AgentData).level;
      if (typeof lv === "number") {
        parts.push(`${name[0]!.toUpperCase()}${lv.toFixed(1)}`);
      }
    }
  }
  safe(buf, r, c0, ` M:${memCount} ${parts.join(" ")}`.slice(0, colW - 1));
  r++;

  // Row 13: bottom separator
  safe(buf, r, c0, "─".repeat(colW - 1), CYAN);
}

// ── Main render (matches Python draw exactly) ──────────────────────
function render(): string {
  const [height, width] = getSize();
  const buf: string[] = [];

  // Clear
  buf.push("\x1b[2J\x1b[H");

  const allOrgs = loadAgents();
  let orgs = hideDead ? allOrgs.filter((o) => Boolean(g(o, "active"))) : allOrgs;
  if (tierFilter !== null) {
    orgs = orgs.filter((o) => gn(o, "_challengesSolved") >= (tierFilter ?? 0));
  }
  const deadCount = allOrgs.length - allOrgs.filter((o) => Boolean(g(o, "active"))).length;

  // Global stats
  const totalSpent = orgs.reduce((s, o) => s + gn((g(o, "energy") ?? {}) as AgentData, "spent"), 0);
  const totalEarned = orgs.reduce((s, o) => s + gn((g(o, "energy") ?? {}) as AgentData, "earned"), 0);
  const nActive = orgs.filter((o) => Boolean(g(o, "active"))).length;

  // Goal board
  const goals = loadGoalBoard();
  const nOpen = goals.filter((g) => g.status === "open").length;
  const nClaimed = goals.filter((g) => g.status === "claimed").length;
  const nCompleted = goals.filter((g) => g.status === "completed").length;
  const totalBounty = goals
    .filter((g) => g.status === "open" || g.status === "claimed")
    .reduce((s, g) => s + (typeof g.bounty === "number" ? g.bounty : 0), 0);

  // Pool status
  const pool = loadPool();

  // Row 0: header
  safe(buf, 0, 0, " TERM ARENA ", `${BOLD}${CYAN}`);
  safe(buf, 0, 13, `Spent:${fmt(totalSpent)}  Earned:${fmt(totalEarned)}  Net:${fmtSigned(totalEarned - totalSpent)}`);
  const timeStr = new Date().toTimeString().slice(0, 8);
  safe(buf, 0, width - 20, `${nActive}/${orgs.length} active  ${timeStr}`, CYAN);

  // Row 1: TEQ pool status
  const ledger = loadPoolLedger();
  if (pool) {
    const poolPct = pool.maxBalance > 0 ? Math.floor((pool.balance / pool.maxBalance) * 100) : 0;
    const poolColor = poolPct > 40 ? GREEN : poolPct > 15 ? YELLOW : RED;
    safe(buf, 1, 0,
      ` Pool: ${pctBar(pool.balance, pool.maxBalance, 12)} ${fmt(pool.balance)}/${fmt(pool.maxBalance)} (${poolPct}%)` +
      `  W:${fmt(pool.totalWithdrawn)}  D:${fmt(pool.totalDeposited)}  R:${fmt(pool.totalRegenerated)}`,
      poolColor,
    );
  }

  // Row 2: pool balance sparkline + flow rates
  if (ledger.length > 1) {
    const sparkW = Math.min(40, Math.floor(width * 0.4));
    const balances = sampleBalances(ledger, sparkW);
    const spark = sparkline(balances, sparkW);
    const rates = flowRates(ledger);
    const netFlow = rates.rRate + rates.dRate - rates.wRate;
    const flowColor = netFlow >= 0 ? GREEN : RED;
    safe(buf, 2, 0, ` ${spark}`, YELLOW);
    safe(buf, 2, sparkW + 2,
      `w:${fmt(rates.wRate)}/m  d:${fmt(rates.dRate)}/m  r:${fmt(rates.rRate)}/m  net:${fmtSigned(netFlow)}/m`,
      flowColor,
    );
  }

  // Row 3: bounty board
  if (goals.length > 0) {
    safe(buf, 3, 0, ` Bounties: ${nOpen} open  ${nClaimed} claimed  ${nCompleted} done  (${fmt(totalBounty)}e locked)`, YELLOW);
  }

  // Empty state
  if (orgs.length === 0) {
    safe(buf, 5, 2, `Waiting for agents... (${SAVES_DIR})`, YELLOW);
    safe(buf, height - 1, 0, ` [q] quit`, CYAN);
    return buf.join("");
  }

  // Grid layout (start at row 5 to leave room for header, pool, chart, bounties)
  const n = orgs.length;
  const nCols = Math.max(1, Math.floor(width / MIN_COL_W));
  const nGridRows = Math.ceil(n / nCols);
  const colW = Math.floor(width / nCols);

  for (let idx = 0; idx < n; idx++) {
    const gridR = Math.floor(idx / nCols);
    const gridC = idx % nCols;
    const r0 = 5 + gridR * CARD_ROWS;
    const c0 = gridC * colW;

    if (r0 + CARD_ROWS > height - 1) {
      safe(buf, height - 2, 0, ` +${n - idx} more agents (resize terminal)`, YELLOW);
      break;
    }

    drawCard(buf, orgs[idx]!, r0, c0, colW);
  }

  // Footer
  const deadLabel = hideDead ? `${deadCount} hidden` : `${deadCount} dead`;
  const tierLabel = tierFilter !== null ? `T${tierFilter}` : "all";
  safe(buf, height - 1, 0, ` [q]uit [d]ead [1-6]tier [0]all  ${n}/${allOrgs.length} shown (${deadLabel}) tier:${tierLabel}`, CYAN);

  return buf.join("");
}

// ── Main loop ──────────────────────────────────────────────────────
function tick(): void {
  SAVES_DIR = findRunDir();
  process.stdout.write(render());
}

// Raw mode for 'q' to quit (matches curses getch behavior)
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (key: string) => {
    if (key === "q" || key === "Q" || key === "\x03") {
      cleanup();
    } else if (key === "d" || key === "D") {
      hideDead = !hideDead;
      tick();
    } else if (key >= "1" && key <= "6") {
      tierFilter = tierFilter === Number(key) ? null : Number(key);
      tick();
    } else if (key === "0") {
      tierFilter = null;
      tick();
    }
  });
}

function cleanup(): void {
  clearInterval(timer);
  process.stdout.write("\x1b[?25h" + RST + "\n");
  process.exit(0);
}

// Hide cursor
process.stdout.write("\x1b[?25l");

tick();
const timer = setInterval(tick, REFRESH_INTERVAL);

process.on("SIGINT", cleanup);
process.on("exit", () => {
  process.stdout.write("\x1b[?25h" + RST);
});
