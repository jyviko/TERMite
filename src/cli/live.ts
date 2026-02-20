import { parseArgs } from "node:util";
import { loadEnv } from "./env.js";
import { Brain } from "../brain/index.js";

loadEnv();
import { Executor } from "../executor/index.js";
import { OrganismStateManager } from "../state/organism-state.js";
import { OrganismStateMachine } from "../loop/state-machine.js";

const { values } = parseArgs({
  options: {
    budget: { type: "string", default: "100000" },
    goal: { type: "string" },
    save: { type: "string", default: "saves" },
    "api-key": { type: "string" },
    "base-url": { type: "string" },
  },
});

const budget = parseInt(values.budget ?? "100000", 10);

async function main() {
  const brain = new Brain({
    apiKey: values["api-key"] ?? process.env.ANTHROPIC_API_KEY,
    baseUrl: values["base-url"] ?? process.env.ANTHROPIC_BASE_URL,
  });

  const executor = new Executor();
  await executor.start();

  const state = new OrganismStateManager({ budget });
  if (values.goal) state.goal = values.goal;

  const savePath = `${values.save}/${state.id}.json`;
  const machine = new OrganismStateMachine(brain, executor, state, savePath);

  console.log(`Organism ${state.id} born (budget: ${budget})`);

  const shutdown = async () => {
    console.log("\nShutting down...");
    await state.save(savePath);
    await executor.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  for await (const event of machine.run()) {
    logEvent(state.id, state.mode, event);
  }

  console.log(`Organism ${state.id} died: ${state.causeOfDeath ?? "unknown"}`);
  await state.save(savePath);
  await executor.stop();
}

function logEvent(
  id: string,
  mode: string,
  event: import("../types/index.js").AgentEvent,
): void {
  const prefix = `[${id}] [${mode.toUpperCase()}]`;
  switch (event.type) {
    case "text":
      console.log(`${prefix} ${event.text.slice(0, 300)}`);
      break;
    case "tool_start":
      console.log(`${prefix} → ${event.name}`);
      break;
    case "tool_result":
      console.log(`${prefix} ← ${event.name}: ${event.result.slice(0, 150)}`);
      break;
    case "state_change":
      console.log(`${prefix} ${event.from} → ${event.to}`);
      break;
    case "error":
      console.error(`${prefix} ERROR: ${event.message}`);
      break;
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
