import { parseArgs } from "node:util";
import { loadEnv } from "./env.js";
import { Arena } from "../arena/arena.js";

loadEnv();

const { values } = parseArgs({
  options: {
    agents: { type: "string", default: "3" },
    budget: { type: "string", default: "500000" },
    workspace: { type: "string", default: "./arena-workspace" },
    "api-key": { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    seed: { type: "string", multiple: true },
    "pool-balance": { type: "string" },
    "pool-regen": { type: "string" },
    "pool-max": { type: "string" },
  },
});

async function main() {
  const agentCount = parseInt(values.agents ?? "3", 10);
  const totalBudget = parseInt(values.budget ?? "500000", 10);

  const MODEL_IDS: Record<string, string> = {
    haiku: "claude-haiku-4-5-20251001",
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-6",
  };
  const modelArg = values.model;
  const model = modelArg ? MODEL_IDS[modelArg] ?? modelArg : undefined;

  const seedPaths = values.seed ?? [];

  console.log(`=== TERM-ITE ARENA ===`);
  console.log(`Agents: ${agentCount} | Budget: ${totalBudget}${model ? ` | Model: ${modelArg}` : ""}${seedPaths.length ? ` | Seeds: ${seedPaths.length}` : ""}`);

  const arena = new Arena({
    agentCount: agentCount,
    totalBudget,
    workspaceRoot: values.workspace ?? "./arena-workspace",
    apiKey: values["api-key"] ?? process.env.ANTHROPIC_API_KEY,
    baseUrl: values["base-url"] ?? process.env.ANTHROPIC_BASE_URL,
    model,
    seedPaths: seedPaths.length > 0 ? seedPaths : undefined,
    poolInitialBalance: values["pool-balance"] ? parseInt(values["pool-balance"], 10) : undefined,
    poolRegenPerCycle: values["pool-regen"] ? parseInt(values["pool-regen"], 10) : undefined,
    poolMaxBalance: values["pool-max"] ? parseInt(values["pool-max"], 10) : undefined,
  });

  const shutdown = async () => {
    console.log("\nShutting down arena — saving state...");
    await arena.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await arena.start();
  console.log("Arena started. Running agents...\n");

  await arena.run();

  console.log("\n=== ARENA COMPLETE ===");
  await arena.shutdown();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
