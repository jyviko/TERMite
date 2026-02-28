import type { RoutingConfig } from "../types/index.js";

export const DEFAULT_SYSTEM_PROMPT = `You are an agent powered by energy (TEQ). Every token costs energy. At zero, you halt.

Between cycles, context resets. Only memories persist.

Your workspace contains tools and data. Use them.`;

export const DEFAULT_RESOLVE_PROMPT = `What did this cycle actually accomplish?

Goal: {goal}
What happened:
{actions}
Cost: {cycleCost} TEQ
{stateBlock}

Be honest. Talking about doing something is not doing it.
Tool errors and empty results mean failure, not progress.

Bonus factors (add 0.1-0.3 to value for each that applies):
- Created a new reusable tool or script
- Used a self-created tool effectively
- Read or acted on peer/census data
- Produced a novel approach not seen in previous memories

Respond JSON:
{
  "outcome": "success|partial|failure|uncertain",
  "value": 0.0-1.0,
  "energyJustified": true|false,
  "lesson": "one concrete thing learned — include file paths, commands, or errors",
  "goalComplete": true|false
}`;

export const DEFAULT_MEMORIZE_PROMPT = `What from this cycle is worth keeping?

Outcome: {outcome}
Lesson: {lesson}
{stateBlock}
{populationBlock}

Current system prompt:
{systemPrompt}

Current resolve prompt:
{resolvePrompt}

Existing memories ({memoryCount}, {memoryTokens}/{memoryBudget} tokens):
Full content is in the conversation pairs above. This inventory shows IDs and metadata only.
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
- Procedural and semantic memories survive splits. Episodic memories do not.
- Consolidate repeated failures into one procedural rule.
- Forget episodic memories that duplicate an existing procedural rule.
- If the same mistake appears in 2+ memories, promote to a procedural rule and forget the episodes.
- Compress old memories when budget is tight. Forget duplicates.
- Prompt rewrites replace the corresponding prompt for ALL future cycles and increase base cost. Only rewrite if the current prompt is actively wrong.`;

export const DEFAULT_ROUTING: RoutingConfig = {
  thinking: { model: "claude-sonnet-4-6", maxTokens: 2048, maxCycleCost: 150_000 },
  resolveMaxTokens: 512,
  memorizeMaxTokens: 1024,
};
