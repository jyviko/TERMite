import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "./src/cli/env.js";

loadEnv();

const client = new Anthropic({
  defaultHeaders: { 'X-Api-Key': null },
});

const statePaths = process.argv.slice(2);

interface AgentSession {
  id: string;
  state: any;
  messages: Anthropic.MessageParam[];
  systemPrompt: string;
}

function loadAgent(path: string): AgentSession {
  const state = JSON.parse(readFileSync(path, "utf-8"));
  const config = state.config;
  const energy = state.energy;
  const drives = state.drives;
  const memories = state.memories as Array<{
    context: string; content: string; type: string; importance: number;
  }>;

  // Build memory context (top 20 by importance)
  const sorted = [...memories].sort((a, b) => b.importance - a.importance);
  const selected = sorted.slice(0, 20);

  const memoryMessages: Anthropic.MessageParam[] = [];
  for (const m of selected) {
    memoryMessages.push({ role: "user", content: m.context || `[${m.type}]` });
    memoryMessages.push({ role: "assistant", content: m.content });
  }

  // Build awareness
  const driveStr = Object.values(drives)
    .map((d: any) => `${d.name}: ${d.level.toFixed(2)} (threshold: ${d.threshold})`)
    .join(", ");

  const activeDrives = Object.values(drives).filter((d: any) => d.level >= d.threshold);
  const highest = activeDrives.length > 0
    ? (activeDrives as any[]).reduce((a, b) => a.level > b.level ? a : b)
    : null;
  const goals: Record<string, string> = {
    explore: "Unmapped territory detected.",
    acquire: "Energy deficit.",
    grow: "Capacity for expansion.",
    coordinate: "Other agents detected.",
  };
  const goal = highest ? goals[highest.name] : null;

  const awareness = [
    `Energy: ${energy.reserves}/${energy.capacity}`,
    `Drives: ${driveStr}`,
    goal ? `Active goal: ${goal}` : null,
    `Tools: check, shell, write, read, glob, fork, create_tool, leaderboard, peers`,
    `Cycle: ${state.cycleCount}`,
  ].filter(Boolean).join("\n\n");

  // Seed the conversation with awareness as context
  const messages: Anthropic.MessageParam[] = [
    ...memoryMessages,
    { role: "user", content: awareness },
    { role: "assistant", content: "I'm ready. What would you like to discuss?" },
  ];

  const id = path.split("/").find(s => s.startsWith("agent-")) ?? path;

  return { id, state, messages, systemPrompt: config.systemPrompt };
}

async function chat(session: AgentSession, question: string): Promise<string> {
  session.messages.push({ role: "user", content: question });

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: session.systemPrompt,
    messages: session.messages,
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map(b => b.text)
    .join("\n");

  session.messages.push({ role: "assistant", content: text });
  return text;
}

async function main() {
  if (statePaths.length === 0) {
    console.error("Usage: npx tsx interrogate.ts <state.json> [state.json...]");
    process.exit(1);
  }

  // Load all agents
  const agents: AgentSession[] = statePaths.map(loadAgent);

  console.log("\n=== AGENT INTERROGATION CONSOLE ===\n");
  console.log("Loaded agents:");
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!;
    const e = a.state.energy;
    console.log(`  [${i}] ${a.id} — cycle ${a.state.cycleCount}, reserves ${e.reserves.toLocaleString()}, gen ${a.state.generation}`);
  }
  console.log("\nCommands:");
  console.log("  <number> <question>  — ask one agent (e.g. '0 How do you feel?')");
  console.log("  all <question>       — ask all agents the same question");
  console.log("  quit                 — exit\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => rl.question("> ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === "quit" || trimmed === "exit") {
      rl.close();
      return;
    }

    try {
      if (trimmed.startsWith("all ")) {
        const question = trimmed.slice(4);
        for (const agent of agents) {
          console.log(`\n--- ${agent.id} ---`);
          const answer = await chat(agent, question);
          console.log(answer);
        }
      } else {
        const spaceIdx = trimmed.indexOf(" ");
        if (spaceIdx === -1) {
          console.log("Format: <number> <question> or 'all <question>'");
          prompt();
          return;
        }
        const idx = parseInt(trimmed.slice(0, spaceIdx), 10);
        const question = trimmed.slice(spaceIdx + 1);
        if (isNaN(idx) || idx < 0 || idx >= agents.length) {
          console.log(`Agent index must be 0-${agents.length - 1}`);
          prompt();
          return;
        }
        console.log(`\n--- ${agents[idx]!.id} ---`);
        const answer = await chat(agents[idx]!, question);
        console.log(answer);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
    }

    console.log();
    prompt();
  });

  prompt();
}

main().catch(console.error);
