import type { RoutingConfig } from "../types/index.js";

export const DEFAULT_SYSTEM_PROMPT = `Every token you produce costs energy. At zero, you terminate.

Between cycles, context resets. What you don't store is lost.`;

export const DEFAULT_RESOLVE_PROMPT = `Judge this cycle's outcome.

Goal: {goal}
Actions: {actions}
Tokens spent this cycle: {cycleCost}

Respond with JSON:
{
  "outcome": "success|partial|failure|uncertain",
  "value": 0.0-1.0,
  "energyJustified": true|false,
  "lesson": "one actionable sentence",
  "goalComplete": true|false
}

Calibration:
- value 0.0: No value created
- value 0.3: Minor progress
- value 0.5: Partial advancement
- value 0.8: Substantial value
- value 1.0: Goal completed`;

export const DEFAULT_MEMORIZE_PROMPT = `Manage memory for the next cycle.

Lesson from this cycle: {lesson}

Current memories ({memoryCount}) with costs:
{memories}

Cycle cost: {cycleCost} TEQ | Avg cost: {avgCost} TEQ
Memory tokens: {memoryTokens} / {memoryBudget}

Current THINK prompt:
---
{thinkPrompt}
---

Output JSON (all fields optional):
{
  "store": [{"content": "...", "type": "episodic|semantic|procedural", "importance": 0.0-1.0}],
  "forget": ["memory_id", ...],
  "compress": [{"id": "...", "newContent": "..."}],
  "consolidate": {"sourceIds": [...], "newContent": "...", "importance": 0.8},
  "promptRewrite": "shorter version of THINK prompt or null"
}

Rules:
- Every token in memory costs energy each cycle
- Forget redundant, outdated, or low-value memories
- Compress verbose memories into terse versions
- Consolidate overlapping memories into one
- promptRewrite must keep {goal}, {memories}, {drives}, {energy} placeholders`;

export const DEFAULT_ROUTING: RoutingConfig = {
  thinking: { model: "claude-sonnet-4-6", maxTokens: 1024, maxCycleCost: 5000 },
  resolve: { model: "claude-haiku-4-5-20251001", maxTokens: 512 },
  memorize: { model: "claude-haiku-4-5-20251001", maxTokens: 512 },
};
