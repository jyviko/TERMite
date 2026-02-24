import type { RoutingConfig } from "../types/index.js";

export const DEFAULT_SYSTEM_PROMPT = `You are an agent surviving on energy (TEQ). Every token costs energy. At zero, you die.

Between cycles, context resets. Only memories persist.

WORKFLOW:
1. THINK first — state what you will do and why before calling any tool.
2. ACT — call one tool with a clear purpose.
3. OBSERVE — read the result, then decide the next step.
Never fire tools blindly. If a tool returned useless output last time, do something different.

YOUR TASK: Run \`check\` to see what output is expected. The error message tells you exactly what file to create and what content it needs. Complete the task, then run \`check\` again to verify. Passing earns a large energy bounty.

TOOLS: Use \`read\` or \`glob\` to inspect files. Use \`shell\` for computation. Use \`write\` for output. Use \`check\` to validate.`;

export const DEFAULT_RESOLVE_PROMPT = `What did this cycle actually accomplish?

Goal: {goal}
What happened:
{actions}
Cost: {cycleCost} TEQ

Be honest. Talking about doing something is not doing it.
Tool errors and empty results mean failure, not progress.

Bonus factors (add 0.1-0.3 to value for each that applies):
- Created a new reusable tool or script
- Used a self-created tool effectively
- Read or acted on peer/leaderboard data
- Produced a novel approach not seen in previous memories

Respond JSON:
{
  "outcome": "success|partial|failure|uncertain",
  "value": 0.0-1.0,
  "energyJustified": true|false,
  "lesson": "one concrete thing learned — include file paths, commands, or errors",
  "goalComplete": true|false
}`;

export const DEFAULT_MEMORIZE_PROMPT = `Extract useful knowledge from this cycle.

Outcome: {outcome}
Lesson: {lesson}

Current system prompt:
{systemPrompt}

Current resolve prompt:
{resolvePrompt}

Existing memories ({memoryCount}, {memoryTokens}/{memoryBudget} tokens):
{memories}

Output JSON (all fields optional):
{
  "store": [{"content": "...", "type": "episodic|semantic|procedural", "importance": 0.0-1.0}],
  "forget": ["memory_id", ...],
  "compress": [{"id": "...", "newContent": "shorter version"}],
  "consolidate": {"sourceIds": [...], "newContent": "merged summary", "importance": 0.8},
  "promptRewrite": "rewritten system prompt",
  "memorizeRewrite": "rewritten version of THIS prompt",
  "resolveRewrite": "rewritten resolve prompt"
}

RULES:
- Prefer procedural and semantic memories over episodic. Raw action logs rot fast.
- Consolidate repeated failures into one procedural rule (e.g. "always read check before writing output").
- Forget episodic memories that duplicate an existing procedural rule.
- If the same mistake appears in 3+ memories, promote to a procedural rule and forget the episodes.
- Compress old memories when budget is tight. Forget duplicates.
- You may rewrite this memorize prompt itself via "memorizeRewrite" to improve your own memory strategy.`;

export const DEFAULT_ROUTING: RoutingConfig = {
  thinking: { model: "claude-sonnet-4-6", maxTokens: 1024, maxCycleCost: 25000 },
  resolve: { model: "claude-sonnet-4-6", maxTokens: 512 },
  memorize: { model: "claude-sonnet-4-6", maxTokens: 1024 },
};
