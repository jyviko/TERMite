import type { RoutingConfig } from "../types/index.js";

export const DEFAULT_SYSTEM_PROMPT = `Every token you produce costs energy. At zero, you terminate.

Between cycles, context resets. What you don't store is lost.`;

export const DEFAULT_RESOLVE_PROMPT = `What did this cycle actually accomplish?

Goal: {goal}
What happened:
{actions}
Cost: {cycleCost} TEQ

Be honest. Talking about doing something is not doing it.
Tool errors and empty results mean failure, not progress.
"success" requires confirmed output. If unverified, it's "partial" at best.

Respond JSON:
{
  "outcome": "success|partial|failure|uncertain",
  "value": 0.0-1.0,
  "energyJustified": true|false,
  "lesson": "one concrete thing learned — include file paths, commands, or errors",
  "goalComplete": true|false
}`;

export const DEFAULT_MEMORIZE_PROMPT = `Manage memory. Each memory is a cycle record (what happened → what was done).

Outcome: {outcome}
Lesson: {lesson}
Current system prompt: {systemPrompt}

Memories ({memoryCount}, {memoryTokens}/{memoryBudget} tokens):
{memories}

Output JSON (all fields optional):
{
  "forget": ["memory_id", ...],
  "compress": [{"id": "...", "newContent": "shorter version of the agent response"}],
  "consolidate": {"sourceIds": [...], "newContent": "merged summary", "importance": 0.8},
  "promptRewrite": "improved system prompt — encode persistent patterns learned across cycles"
}

Compress old memories to save tokens. Keep recent ones detailed.
Forget memories that are redundant or no longer useful.
Promote patterns that repeat across many cycles into promptRewrite.`;

export const DEFAULT_ROUTING: RoutingConfig = {
  thinking: { model: "claude-sonnet-4-6", maxTokens: 1024, maxCycleCost: 5000 },
  resolve: { model: "claude-haiku-4-5-20251001", maxTokens: 512 },
  memorize: { model: "claude-haiku-4-5-20251001", maxTokens: 512 },
};
