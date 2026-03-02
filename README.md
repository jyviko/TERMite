# TERM-ITE

An energy-constrained agent arena where emergence arises from thermodynamic pressure, not instruction.

Agents compete for a shared TEQ pool by solving tiered challenges. They accumulate memories, rewrite their own prompts, create tools, and can fork into independent copies. No agent is told what to do — selection pressure does the work.

## Requirements

- **Node.js** 20+ (with `yarn` or `npm`)
- **Anthropic API key** with access to Claude models
- **Python 3** (optional, for post-run analysis)

## Installation

```sh
git clone https://github.com/your-org/termite.git
cd termite
yarn install
```

Copy the environment file and add your key:

```sh
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

## Running the Arena

### Start a new run

```sh
yarn arena
```

Spawns 3 Haiku agents with a shared TEQ budget and runs until all agents halt or the budget is exhausted.

### Common options

```sh
yarn arena --agents 5                     # spawn 5 agents
yarn arena --model sonnet                 # use Claude Sonnet
yarn arena --model opus                   # use Claude Opus
yarn arena --budget 2000000               # override total TEQ budget
yarn arena --max-cycles 50                # pause after 50 cumulative cycles
yarn arena --env-seed 42                  # reproducible environment randomness
```

### Resume a previous run

```sh
yarn arena --resume latest                # resume the most recent run
yarn arena --resume run-2026-02-22T13-50  # resume by run ID
yarn arena --list-snapshots --resume latest  # list available snapshots
yarn arena --rewind snap-001 --resume latest # rewind to a snapshot
```

### Seed an agent from a saved state

```sh
yarn arena --seed ./arena-workspace/latest/agent-abc12345/state.json
```

Multiple `--seed` flags are accepted. Seeded agents carry memories and config into the new run; episodic logs are dropped.

### Pool controls

```sh
yarn arena --pool-balance 5000000         # override initial pool balance
yarn arena --pool-regen 50000             # fixed regen per cycle (disables auto-calibration)
yarn arena --pool-max 10000000            # override pool max capacity
```

### Snapshot controls

```sh
yarn arena --snapshot-interval 300        # snapshot every 5 minutes
yarn arena --no-snapshots                 # disable snapshotting
```

## Live Dashboard

Watch agents in real time alongside a running arena:

```sh
# Terminal 1
yarn arena --agents 5

# Terminal 2
yarn dash
```

Dashboard keybindings:

| Key | Action |
|-----|--------|
| `q` | Quit |
| `d` | Toggle dead agents |
| `l` | Switch between card and lineage tree view |
| `1`–`9` | Filter to agents with ≥ N challenges solved |
| `0` | Clear solved filter |

Options:

```sh
yarn dash --workspace ./arena-workspace   # custom workspace path
yarn dash --run run-2026-02-22T13-50      # specific run
yarn dash --interval 2000                 # refresh every 2000ms
```

## Reports

Print a tabular summary of the latest run:

```sh
yarn report                               # summary table for all agents
yarn report --lineage                     # lineage tree view
yarn report --agent abc1234               # detail view for one agent (partial ID match)
yarn report --agent abc1234 --json        # raw JSON for one agent
yarn report --run run-2026-02-22T13-50    # specific run
```

## Analysis (Python)

Post-run statistical analysis across the workspace:

```sh
yarn analyze                              # analyze arena-workspace/latest
python3 -m analysis.run arena-workspace/run-2026-02-22T13-50
```

Produces reports on: energy economics, memory distribution, lineage diversity, challenge solve rates, and pool dynamics.

## Single Agent (no arena)

Run a single isolated agent for debugging or experimentation:

```sh
yarn live --budget 500000
yarn live --goal "explore the workspace"
yarn live --api-key sk-ant-...            # override env var
```

State is saved to `saves/<agent-id>.json` on shutdown.

## Simulation (no API key required)

Run the agentic loop with a mock LLM and executor:

```sh
yarn sim
yarn sim --budget 10000 --cycles 5
```

Useful for testing the state machine and cycle mechanics without hitting the API.

## Workspace Layout

Each run creates a timestamped directory under `arena-workspace/`:

```
arena-workspace/
└── run-2026-02-22T13-50-05/
    ├── shared/
    │   ├── _pool.json          # TEQ pool state
    │   ├── _pool_ledger.jsonl  # pool transaction log
    │   ├── _census.json        # live agent registry
    │   └── _goal_board.json    # bounty board
    └── agent-<id>/
        ├── state.json          # full agent state
        ├── metrics.jsonl       # per-cycle energy records
        └── workspace/
            ├── tools/          # agent's executable tools
            ├── data/           # challenge input files
            └── output/         # agent's output files
```

`arena-workspace/latest` is a symlink to the most recent run.

## Energy System (TEQ)

TEQ (Token EQuivalents) is the dimensionless currency of the arena. 1 TEQ = 1 Haiku base input token. All API costs scale from Anthropic's published $/MTok ratios:

| Model | Input | Cache read | Output |
|-------|-------|------------|--------|
| Haiku 4.5 | 1× | 0.1× | 5× |
| Sonnet 4.x | 3× | 0.3× | 15× |
| Opus 4.x | 5× | 0.5× | 25× |

Agents earn TEQ by solving challenges drawn from the shared pool. The pool regenerates slowly — if agents over-consume, bounties shrink. Each additional memory and tool raises an agent's per-cycle base cost, creating pressure to consolidate.

## Agent Tools

Every agent workspace is seeded with these tools at startup:

| Tool | Description |
|------|-------------|
| `shell` | Execute an arbitrary shell command |
| `read` | Read a file |
| `write` | Write a file |
| `glob` | List files matching a pattern |
| `check` | Verify challenge output (returns `PASS` or `FAIL`) |
| `peers` | Read peer agent states from shared memory |
| `census` | Read the arena census |
| `fork` | Create an independent copy with memory inheritance |
| `create_tool` | Register a new persistent tool |

Agents discover these tools themselves and can create new ones via `create_tool`.

## Agent Interrogation

Load saved agent states into an interactive chat session, using each agent's own system prompt and top memories as context:

```sh
yarn interrogate                                          # all agents from latest run
npx tsx interrogate.ts arena-workspace/latest/agent-abc12345/state.json
```

Commands at the prompt:

```
0 How did you decide to fork?        # ask agent by index
all What is your current goal?       # ask all agents the same question
quit
```

## Development

```sh
yarn build          # compile TypeScript to dist/
yarn test           # run tests with vitest
yarn test:watch     # run tests in watch mode
```
