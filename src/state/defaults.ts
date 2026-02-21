import type { RoutingConfig } from "../types/index.js";

export const DEFAULT_SYSTEM_PROMPT = `Every token you produce costs energy. At zero, you terminate.

Between cycles, context resets. What you don't store is lost.`;

export const DEFAULT_REST_PROMPT = `Compact working memory into long-term storage.
Extract learnings, successful strategies, discoveries, and mistakes to avoid.
Every token in a memory costs energy to recall.

Return JSON:
{ "memories": [{ "content": "...", "type": "episodic|semantic|procedural", "importance": 0.0-1.0 }] }

Types:
- episodic: what happened (events, outcomes)
- semantic: facts and knowledge discovered
- procedural: strategies and methods that worked`;

export const DEFAULT_RESOLVE_PROMPT = `Evaluate recent actions against the goal.

Goal: {goal}
Actions: {actions}
Energy: {remaining}/{capacity}

Respond with JSON:
{
  "outcome": "success|partial|failure|uncertain",
  "lesson": "one actionable sentence",
  "goalRelevance": 0.0-1.0
}

Calibration:
- 0.0: No connection to goal
- 0.3: Tangentially related
- 0.5: Partial progress
- 0.8: Substantial advancement
- 1.0: Goal completed`;

export const DEFAULT_MEMORIZE_PROMPT = `Decide what to store and what to change.

Recent actions: {actions}
Lesson: {lesson}
Outcome: {outcome} (relevance: {goalRelevance})
Energy: {remaining}/{capacity}

Current memories:
{memories}

Current prompts:
- systemPrompt: {systemPrompt}
- resolvePrompt: {resolvePrompt}
- restPrompt: {restPrompt}

JSON, all fields optional:
{
  "store": [{"content": "...", "type": "episodic|semantic|procedural", "importance": 0.0-1.0}],
  "forget": ["memory_id", ...],
  "compress": [{"id": "...", "newContent": "..."}],
  "consolidate": {"sourceIds": [...], "newContent": "...", "importance": 0.8},
  "rewrite": [{"target": "systemPrompt", "newPrompt": "..."}]
}`;

export const DEFAULT_ROUTING: RoutingConfig = {
  thinking: { model: "claude-sonnet-4-6", maxTokens: 4096, maxCycleCost: 5000 },
  resolve: { model: "claude-haiku-4-5-20251001", maxTokens: 1024 },
};
