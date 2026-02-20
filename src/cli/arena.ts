import { parseArgs } from "node:util";
import { loadEnv } from "./env.js";
import { Arena } from "../arena/arena.js";

loadEnv();

const { values } = parseArgs({
  options: {
    organisms: { type: "string", default: "3" },
    budget: { type: "string", default: "500000" },
    workspace: { type: "string", default: "./arena-workspace" },
    "api-key": { type: "string" },
    "base-url": { type: "string" },
  },
});

async function main() {
  const organismCount = parseInt(values.organisms ?? "3", 10);
  const totalBudget = parseInt(values.budget ?? "500000", 10);

  console.log(`=== TERM-ITE ARENA ===`);
  console.log(`Organisms: ${organismCount} | Budget: ${totalBudget}`);

  const arena = new Arena({
    organismCount,
    totalBudget,
    workspaceRoot: values.workspace ?? "./arena-workspace",
    apiKey: values["api-key"] ?? process.env.ANTHROPIC_API_KEY,
    baseUrl: values["base-url"] ?? process.env.ANTHROPIC_BASE_URL,
  });

  const shutdown = async () => {
    console.log("\nShutting down arena...");
    await arena.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await arena.start();
  console.log("Arena started. Running organisms...\n");

  await arena.run();

  console.log("\n=== ARENA COMPLETE ===");
  await arena.stop();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
