import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent } from "../types/index.js";
import { LLM, type LLMResponse, type ChatParams } from "../llm/index.js";
import { OrganismStateManager } from "../state/organism-state.js";
import { OrganismStateMachine } from "../loop/state-machine.js";
import { TEQPool } from "../arena/teq-pool.js";

const { values } = parseArgs({
  options: {
    budget: { type: "string", default: "5000" },
    cycles: { type: "string", default: "10" },
  },
});

const budget = parseInt(values.budget ?? "5000", 10);
const maxCycles = parseInt(values.cycles ?? "10", 10);

// Mock executor that returns canned responses
class MockExecutor {
  private files = new Map<string, string>();
  private workingDir_ = "/workspace";

  get workingDir(): string {
    return this.workingDir_;
  }

  async start(): Promise<void> {
    // No-op
  }

  async stop(): Promise<void> {
    // No-op
  }

  async executeShell(command: string): Promise<string> {
    // Tool discovery
    if (command.includes("find /workspace/tools")) {
      return "/workspace/tools/shell\n/workspace/tools/check";
    }
    // Tool execution
    if (command.startsWith("/workspace/tools/shell")) {
      return `(simulated) ${command}`;
    }
    if (command.startsWith("/workspace/tools/check")) {
      const greeting = this.files.get("/workspace/output/greeting.txt");
      if (greeting?.includes("Hello, World!")) return "PASS";
      return "FAIL: file not found or wrong content";
    }
    return `(simulated) ${command}`;
  }

  async writeFile(path: string, content: string): Promise<string> {
    const fullPath = path.startsWith("/") ? path : `/workspace/${path}`;
    this.files.set(fullPath, content);
    return `wrote ${fullPath}`;
  }
}

// Mock LLM that returns simple scripted responses
class MockLLM extends LLM {
  private callIndex = 0;

  constructor() {
    super({});
  }

  async chat(_params: ChatParams): Promise<LLMResponse> {
    this.callIndex++;

    // First few calls: explore and solve
    if (this.callIndex <= 2) {
      return {
        content: [
          { type: "text" as const, text: "Let me explore my workspace." },
          {
            type: "tool_use" as const,
            id: `toolu_${this.callIndex}`,
            name: "shell",
            input: { input: "ls /workspace/" },
          },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 },
      };
    }

    if (this.callIndex === 3) {
      return {
        content: [
          { type: "text" as const, text: "Let me look at the data." },
          {
            type: "tool_use" as const,
            id: `toolu_${this.callIndex}`,
            name: "shell",
            input: { input: "ls /workspace/data/" },
          },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 },
      };
    }

    if (this.callIndex === 4) {
      return {
        content: [
          { type: "text" as const, text: "Writing the greeting file." },
          {
            type: "tool_use" as const,
            id: `toolu_${this.callIndex}`,
            name: "shell",
            input: { input: "echo 'Hello, World!' > /workspace/output/greeting.txt" },
          },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 },
      };
    }

    // Default: return text only (stops the loop)
    return {
      content: [
        { type: "text" as const, text: "I've completed my task for now." },
      ] as Anthropic.ContentBlock[],
      stopReason: "end_turn",
      usage: { input: 50, output: 20, cacheCreation: 0, cacheRead: 0 },
    };
  }
}

async function main() {
  console.log(`=== TERMITE SIMULATION ===`);
  console.log(`Budget: ${budget} | Max cycles: ${maxCycles}`);

  const llm = new MockLLM();
  const executor = new MockExecutor();
  const state = new OrganismStateManager({ budget });

  const teqPool = TEQPool.initialize();
  const machine = new OrganismStateMachine(
    llm,
    executor as unknown as import("../executor/index.js").Executor,
    state,
    teqPool,
    `saves/${state.id}-sim.json`,
  );

  console.log(`Organism ${state.id} born\n`);

  let cycles = 0;
  for await (const event of machine.run()) {
    logEvent(state.id, state.mode, event);
    if (state.cycleCount > cycles) {
      cycles = state.cycleCount;
      if (cycles >= maxCycles) {
        console.log(`\nReached max cycles (${maxCycles})`);
        break;
      }
    }
  }

  console.log(`\n=== FINAL STATE ===`);
  console.log(`Alive: ${state.alive}`);
  console.log(`Energy: ${state.energy.remaining}/${state.energy.capacity}`);
  console.log(`Cycles: ${state.cycleCount}`);
  console.log(`Memories: ${state.memories.memories.length}`);
  console.log(`Genome version: ${state.genome.version}`);
  if (state.causeOfDeath) console.log(`Cause of death: ${state.causeOfDeath}`);
}

function logEvent(id: string, mode: string, event: AgentEvent): void {
  const prefix = `[${id}] [${mode.toUpperCase()}]`;
  switch (event.type) {
    case "text":
      console.log(`${prefix} ${event.text.slice(0, 200)}`);
      break;
    case "tool_start":
      console.log(`${prefix} → ${event.name}`);
      break;
    case "tool_result":
      console.log(`${prefix} ← ${event.name}: ${event.result.slice(0, 100)}`);
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
