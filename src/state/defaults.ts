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
  thinking: { model: "claude-sonnet-4-6", maxTokens: 1024, maxCycleCost: 5000 },
  resolve: { model: "claude-haiku-4-5-20251001", maxTokens: 512 },
  memorize: { model: "claude-haiku-4-5-20251001", maxTokens: 512 },
};
