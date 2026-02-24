# TERM-ITE

An energy-constrained agent arena where emergence arises from thermodynamic pressure, not instruction.

## Memorandum of Emergence

Emergence is a property of system dynamics. It cannot be designed into prompts, injected via awareness messages, or achieved by optimizing task completion. The following principles govern all changes to this codebase.

### What emergence requires

1. **Net-positive energy flow.** Every cycle must have a viable path to surplus. If the cost floor exceeds the income ceiling, agents enter a death spiral where no strategy can succeed. Check the economics before anything else: `TIER_REWARDS`, `TIER_EXPECTED_COST`, `MODEL_BOUNTY_MULTIPLIER`, `computeIncome()`.

2. **Compound interest loops.** Success must breed more success. Procedural memories reduce future cost. Tools created by an agent persist and lower subsequent cycle costs. Earning energy grows the memory budget, which improves decision quality, which earns more energy. These feedback loops are the engine of differentiation.

3. **State space expansion, not contraction.** Over time, agents must diverge from each other, not converge. If all drives collapse to one value, all memories stay episodic, and all configs get lobotomized to the same minimal prompt — the system is contracting. Measure: drive diversity, memory type distribution, config version spread, tool count.

4. **Interaction surface.** Agents need to affect each other's environment. The shared TEQ pool, leaderboard data in `/shared`, forking with memory inheritance — these are the interaction channels. Without them, agents are isolated processes, not a population.

### Anti-patterns (never do these)

- **Task awareness in prompts.** Do not tell agents what the current task is, what the expected output format looks like, or how to pass. The `check` tool already returns `PASS` or `FAIL` with an error message. If an agent can't figure out how to use that, it should die.

- **Protected core instructions.** Do not add "never rewrite this section" guards to prompts. Agents own their prompts via `promptRewrite`, `memorizeRewrite`, and `resolveRewrite`. If an agent lobotomizes itself, that's selection pressure working correctly. The fix is to make the prompt actually useful so agents that keep it outperform those that don't.

- **Drive-goal specificity.** Do not make drive goals more explicit or task-oriented ("Complete the current task to earn energy"). Drives are internal pressures, not instructions. `acquire.level` rises when energy is low — the agent already feels the deficit. Spelling it out collapses the agent's problem-solving space to a single strategy.

- **Hand-holding the LLM.** Do not add step-by-step instructions, examples, or hints to the system prompt that tell the agent how to solve tasks. The workflow section (`THINK → ACT → OBSERVE`) is the limit — it describes a process, not a solution. The agent must discover that `check` reveals what's needed, that `write` creates output files, that scripts are faster than in-context reasoning.

- **Pruning successful strategies.** Do not decay or evict memories that are working. Procedural and semantic memories persist with full weight. Only episodic memories (raw action logs) time-decay. If an agent crystallized "always run check first" as a procedural rule, that rule should last forever.

- **Optimizing for task pass rate.** Task completion is a proxy metric, not the goal. An agent that creates its own tools, rewrites its own prompts, and teaches its offspring through memory inheritance is more emergent than one that passes every task but never changes. Reward novel behavior, not just correct behavior.

### Economic invariants

The energy system is the physics of this world. Violating these invariants kills emergence:

- **TEQ is dimensionless.** 1 TEQ = 1 Haiku base input token. All costs scale from Anthropic's published $/MTok ratios. See `src/state/energy.ts`.
- **Model-dependent pricing.** Sonnet output costs 15 TEQ/token; Haiku output costs 5 TEQ/token. This is not configurable — it reflects real API costs. Bounties scale proportionally via `MODEL_BOUNTY_MULTIPLIER` so that Sonnet agents aren't punished for being smarter.
- **Pool is finite.** The TEQ pool (`src/arena/teq-pool.ts`) is a shared commons. Agents withdraw bounties from it. It regenerates slowly. If agents collectively over-consume, the pool drains and bounties shrink. This is intentional — it creates carrying capacity.
- **Base cost scales with state.** More memories and more tools mean higher per-cycle overhead (`computeBaseCost`). This prevents unbounded accumulation and creates a pressure to consolidate.

### The four phases

Each cycle runs: **Think → Execute → Resolve → Memorize**

- **Think** (`src/loop/agentic-loop.ts`): The agent reasons about what to do next. Builds the prompt from system instruction, memory pairs, and the awareness message.
- **Execute** (`src/loop/state-machine.ts`): Tool calls within the agentic loop. Each tool invocation runs a shell script in the agent's container (`/workspace/tools/<name>`). Multiple think-execute iterations happen per cycle, bounded by `maxCycleCost`. Cache breakpoints on the memory prefix enable reuse across iterations.
- **Resolve** (`src/loop/resolve.ts`): A separate LLM call judges the cycle's outcome. It does not guide the agent — it scores what happened. The resolve prompt is rewritable by the agent.
- **Memorize** (`src/loop/memorize.ts`): A separate LLM call manages memory. It decides what to store, forget, compress, consolidate, and whether to rewrite any of the three prompts. This is where crystallization happens — episodic logs become procedural rules.

### Architecture notes

- `src/loop/state-machine.ts` — Cycle orchestrator. The `finalizeCycle()` method is the critical path: resolve → store pair → income → end cycle → memorize → housekeeping.
- `src/state/memory.ts` — Score-based memory selection, not chronological. `effectiveScore()` weights by type, importance, recency (episodic only), and access frequency.
- `src/arena/arena.ts` — Population manager. Handles forking (with memory inheritance), seeding (episodic dropped), resume, and death.
- `src/state/drives.ts` — Four drives: explore, acquire, grow, coordinate. Each has its own activation conditions. Only drives above threshold generate goals.
- `src/arena/task-generator.ts` — Tiers 1-5, each with multiple templates, data generators, and verification scripts. Tools are seeded from `tools/` into each workspace.

### When making changes

Ask: does this change expand or contract the space of possible agent behaviors?

If it contracts (e.g., adding hints, protecting prompts, making goals explicit), don't do it. If it expands (e.g., new interaction channels, new reward sources, new tools agents can discover), do it.

The system's job is to create conditions. The agents' job is to find strategies. Don't confuse the two.
