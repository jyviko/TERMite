import { parseArgs } from "node:util";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv } from "./env.js";
import { Arena } from "../arena/arena.js";

loadEnv();

const { values } = parseArgs({
  options: {
    agents: { type: "string", default: "3" },
    budget: { type: "string" },
    workspace: { type: "string", default: "./arena-workspace" },
    "api-key": { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    seed: { type: "string", multiple: true },
    resume: { type: "string" },
    "pool-balance": { type: "string" },
    "pool-regen": { type: "string" },
    "pool-max": { type: "string" },
    "snapshot-interval": { type: "string" },
    "no-snapshots": { type: "boolean", default: false },
    "list-snapshots": { type: "boolean", default: false },
    rewind: { type: "string" },
    "max-cycles": { type: "string" },
    "break-cycles": { type: "string" },
  },
});

async function main() {
  const workspaceRoot = values.workspace ?? "./arena-workspace";

  // Snapshot-only commands (no arena startup needed)
  if (values["list-snapshots"]) {
    const resumeDir = resolveResumeDir(values.resume, workspaceRoot);
    if (!resumeDir) throw new Error("--list-snapshots requires --resume <run>");
    const snapshots = await Arena.listSnapshots(resumeDir);
    if (snapshots.length === 0) {
      console.log("No snapshots found.");
    } else {
      console.log(`Snapshots for ${resumeDir}:\n`);
      for (const s of snapshots) {
        console.log(`  ${s.id}  ${s.timestamp}  ${s.description}`);
      }
    }
    return;
  }

  if (values.rewind) {
    const resumeDir = resolveResumeDir(values.resume, workspaceRoot);
    if (!resumeDir) throw new Error("--rewind requires --resume <run>");
    console.log(`Rewinding ${resumeDir} to ${values.rewind}...`);
    await Arena.rewindRun(resumeDir, values.rewind);
    console.log("Rewind complete. You can now --resume this run.");
    return;
  }

  const agentCount = parseInt(values.agents ?? "3", 10);

  // Default per-agent starting budget scales with model cost so agents have enough
  // runway to discover and solve challenges before running out. Base is 500K per agent
  // for Haiku (1×); Sonnet agents get 1.5M each (3×); Opus gets 2.5M each (5×).
  const BASE_PER_AGENT_BUDGET = 500_000;
  const modelMultiplier = (() => {
    const m = values.model ?? "";
    if (m.includes("opus")) return 5;
    if (m.includes("sonnet")) return 3;
    return 1; // haiku or unspecified
  })();
  const defaultBudget = BASE_PER_AGENT_BUDGET * modelMultiplier * agentCount;
  const totalBudget = parseInt(values.budget ?? String(defaultBudget), 10);

  const MODEL_IDS: Record<string, string> = {
    haiku: "claude-haiku-4-5-20251001",
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-6",
  };
  const modelArg = values.model;
  const model = modelArg ? MODEL_IDS[modelArg] ?? modelArg : undefined;

  const resumeDir = resolveResumeDir(values.resume, workspaceRoot);
  const seedPaths = resumeDir ? [] : (values.seed ?? []).map((s) => resolveSeedPath(s, workspaceRoot));

  const snapshotIntervalMs = values["snapshot-interval"]
    ? parseInt(values["snapshot-interval"], 10) * 1000
    : undefined;

  const arena = new Arena({
    agentCount: agentCount,
    totalBudget,
    workspaceRoot,
    apiKey: values["api-key"] ?? process.env.ANTHROPIC_API_KEY,
    baseUrl: values["base-url"] ?? process.env.ANTHROPIC_BASE_URL,
    model,
    seedPaths: seedPaths.length > 0 ? seedPaths : undefined,
    poolInitialBalance: values["pool-balance"] ? parseInt(values["pool-balance"], 10) : undefined,
    poolRegenPerCycle: values["pool-regen"] ? parseInt(values["pool-regen"], 10) : undefined,
    poolMaxBalance: values["pool-max"] ? parseInt(values["pool-max"], 10) : undefined,
    snapshotIntervalMs,
    noSnapshots: values["no-snapshots"],
    maxCycles: values["max-cycles"] ? parseInt(values["max-cycles"], 10) : undefined,
    breakCycles: values["break-cycles"] ? parseInt(values["break-cycles"], 10) : undefined,
  });

  const shutdown = async () => {
    console.log("\nShutting down arena — saving state...");
    await arena.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (resumeDir) {
    console.log(`=== TERM-ITE ARENA (RESUME) ===`);
    console.log(`Resuming: ${resumeDir}`);
    await arena.resume(resumeDir);
  } else {
    console.log(`=== TERM-ITE ARENA ===`);
    console.log(`Agents: ${agentCount} | Budget: ${totalBudget}${model ? ` | Model: ${modelArg}` : ""}${seedPaths.length ? ` | Seeds: ${seedPaths.length}` : ""}`);
    await arena.start();
  }

  console.log("Arena started. Running agents...\n");

  await arena.run();

  console.log("\n=== ARENA COMPLETE ===");
  await arena.shutdown();
}

/**
 * Resolve a resume argument to a run directory path.
 * Accepts:
 *   - Full path to a run directory
 *   - Run ID like "run-2026-02-22T13-50-05"
 *   - "latest" or "last" to pick the most recent run
 */
function resolveResumeDir(input: string | undefined, workspaceRoot: string): string | null {
  if (!input) return null;

  // Direct path
  if (existsSync(input) && statSync(input).isDirectory()) return input;

  const absWorkspace = resolve(workspaceRoot);

  // "latest" / "last" — pick most recent run
  if (input === "latest" || input === "last") {
    if (existsSync(absWorkspace)) {
      const runs = readdirSync(absWorkspace)
        .filter((d) => d.startsWith("run-"))
        .sort();
      if (runs.length > 0) return join(absWorkspace, runs[runs.length - 1]!);
    }
    throw new Error(`No runs found in ${absWorkspace}`);
  }

  // Run ID or partial name — search workspace
  const asChild = join(absWorkspace, input);
  if (existsSync(asChild) && statSync(asChild).isDirectory()) return asChild;

  throw new Error(`Cannot find run directory: ${input}`);
}

/**
 * Resolve a seed argument to a state.json path.
 * Accepts:
 *   - Direct path to state.json
 *   - Path to an agent directory (contains state.json)
 *   - Agent ID like "agent-3a804444" (searches workspace for most recent run)
 */
function resolveSeedPath(input: string, workspaceRoot: string): string {
  // Already a file path that exists
  if (existsSync(input) && statSync(input).isFile()) return input;

  // Directory containing state.json
  const asDir = join(input, "state.json");
  if (existsSync(asDir)) return asDir;

  // Agent ID — search runs in workspace for most recent match
  const absWorkspace = resolve(workspaceRoot);
  if (existsSync(absWorkspace)) {
    const runs = readdirSync(absWorkspace)
      .filter((d) => d.startsWith("run-"))
      .sort()
      .reverse(); // most recent first

    for (const run of runs) {
      const candidate = join(absWorkspace, run, input, "state.json");
      if (existsSync(candidate)) return candidate;
    }
  }

  // Also check saves/ directory
  const savePath = join("saves", `${input}.json`);
  if (existsSync(savePath)) return savePath;

  // Return as-is, let it fail with a clear error downstream
  return input;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
