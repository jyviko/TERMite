
# Task: reward-emergent-behavior

## Description
TASK: Reward emergent behaviors — tool creation bonus, memory consolidation bonus, raise tool cap

FILES TO MODIFY:

1. src/loop/state-machine.ts — Three changes:

a) Raise MAX_AUTO_TOOLS from 3 to 10 (line ~14):
```ts
const MAX_AUTO_TOOLS = 10;
```
Agents should be able to build a rich toolbox. Base cost already scales with tool count (toolCount * 20 in energy.ts), which provides natural pressure.

b) Add tool creation energy bonus in autoPersistTool() (~line 240-277).
After the tool is successfully persisted (after the executor.executeShell call), credit energy:
```ts
// After the executor.executeShell(persistCmd) call, change from .catch(() => {}) to:
this.executor.executeShell(persistCmd).then(() => {
  // Reward emergent tool creation
  this.state.energy.credit(10_000);
}).catch(() => {});
```
Add a yield for tool creation event? No — autoPersistTool is sync-ish (fire and forget). Just credit the energy directly. Actually, since executor.executeShell returns a Promise and we're in a .then(), we need to handle this differently. Change to:
```ts
this.executor.executeShell(persistCmd).then(() => {
  this.state.energy.credit(10_000);
  this.cur.sources.push("tool_creation:10000");
}).catch(() => {});
```

c) Add memory consolidation bonus in finalizeCycle() (~line 155-156).
After applyMemorizeOperations, check if token count decreased:
```ts
const oldTokens = this.state.memories.totalTokenCost;
applyMemorizeOperations(memorizeResult.ops, this.state.memories, this.state.config);
const newTokens = this.state.memories.totalTokenCost;
const tokensSaved = oldTokens - newTokens;
if (tokensSaved > 0) {
  const bonus = Math.floor(tokensSaved * 2);
  this.state.energy.credit(bonus);
  this.cur.sources.push(`consolidation:${bonus}`);
}
```
Move the `const oldTokens` line BEFORE the applyMemorizeOperations call.

2. src/state/defaults.ts — Update DEFAULT_RESOLVE_PROMPT to recognize emergent behaviors.
Add before the "Respond JSON:" line:
```
Bonus factors (add 0.1-0.3 to value for each that applies):
- Created a new reusable tool or script
- Used a self-created tool effectively
- Read or acted on peer/leaderboard data
- Produced a novel approach not seen in previous memories
```

After changes, run: npx tsc --noEmit
Commit with a clear message.

## Project
- Name: termite
- Path: /Users/kourtis/Sources/termite
- Branch: fix/reward-emergent-behavior-1771944857447
- Base: feature/TERM_tools

## Instructions
1. Work ONLY on this specific task
2. Do not refactor unrelated code
3. Stay in this worktree directory
4. **Keep your branch up-to-date**: Periodically pull latest changes to stay current
   - Check status: `git fetch origin feature/TERM_tools`
   - Review what's new: `git log HEAD..origin/feature/TERM_tools`
   - Merge will use ort strategy to handle conflicts intelligently
   - Do this check every 30-60 minutes or when you suspect changes may have landed
5. **You are being orchestrated**: The main AI assistant may send you commands via tmux to check progress or provide guidance
6. When you receive new requests via tmux, APPEND them to the TASK.md file in .claude-o
   - Use `echo "\n## Update: $(date)" >> .claude-o/*_reward-emergent-behavior-*.task.md`
   - Then append the new request details
7. Create .task_complete when done

## Orchestration Notice
**Your terminal session is monitored by the orchestrating AI assistant.**
- The orchestrator can read your terminal output to check progress
- The orchestrator may send you commands or guidance if you deviate from the task
- If you receive a command from the orchestrator, respond appropriately and acknowledge
- Stay focused on the task description above - any deviation may trigger intervention

## Testing & Validation
Before marking complete, run sanity checks appropriate for this codebase:

**Auto-detect the project type and run appropriate commands:**
- JavaScript/TypeScript: Check for package.json, run npm test/yarn test/pnpm test, then build
- Go: Check for go.mod, run go test ./... && go build ./...
- Rust: Check for Cargo.toml, run cargo test && cargo clippy && cargo build
- Python: Check for setup.py/pyproject.toml, run pytest or python -m unittest
- C/C++: Check for Makefile/CMakeLists.txt, run make test or ctest
- Other: Look for common test scripts or ask user

**You MUST verify the code works before completing!**
The merge tool does NOT run tests - you are responsible for quality.

## Completion Checklist
When done, follow these steps EXACTLY:

1. **CHECK FOR CONFLICTS** - Verify your changes will merge cleanly:
   - Run `git fetch origin feature/TERM_tools`
   - Check: `git log HEAD..origin/feature/TERM_tools` to see what's new
   - The merge will use ort strategy to handle conflicts intelligently

2. **DETECT PROJECT TYPE** - Look for package.json, Cargo.toml, go.mod, etc.

3. **RUN APPROPRIATE TESTS/BUILDS** - Based on what you found:
   - Node.js: npm/yarn/pnpm test && build
   - Go: go test ./... && go build
   - Rust: cargo test && cargo build
   - Python: pytest or unittest
   - C/C++: make test && make
   - If unsure, ask the user what to run

4. **COMMIT ALL YOUR WORK** - Run git add -A && git commit with descriptive message

5. **CREATE COMPLETION FILE** - You MUST create this file with EXACT naming.

   Option A - Use the helper script (RECOMMENDED):
   ```bash
   ./.claude-o/complete_task.sh
   # Then edit the file to fill in the [FILL IN] sections
   ```

   Option B - Manual creation:
   ```bash
   cat > .claude-o/$(date -u +%Y-%m-%dT%H-%M-%S-%3N)_reward-emergent-behavior-f362b03e.task_complete << 'COMPLETION'
   # Task Completion Summary

   ## Task: reward-emergent-behavior
   **Status**: ✅ Completed
   **Date**: $(date -u +%Y-%m-%d)

   ## Changes Made
   - [List specific files changed]
   - [List specific features added/bugs fixed]
   - [Any architectural decisions made]

   ## Tests Run
   - [Which tests were executed]
   - [Test results summary]
   - [Any skipped tests and why]

   ## Files Changed
   ```
   $(git diff --name-status feature/TERM_tools...HEAD)
   ```

   ## Commit Summary
   ```
   $(git log --oneline feature/TERM_tools..HEAD)
   ```

   ## Notes
   - [Any caveats or issues encountered]
   - [Any follow-up work needed]
   - [Dependencies or breaking changes]
   COMPLETION
   ```

6. **COMMIT TASK FILES** - Run git add .claude-o && git commit -m "docs: task complete"
   This archives the task for history - all files in .claude-o will be merged and kept

7. Ask user if they want to merge the task back to feature/TERM_tools

8. If yes, use mcp__claude-o__merge_task tool (only merges - no tests)

## CRITICAL REQUIREMENTS
⚠️ **DO NOT** create files with custom names like "summary.md" or "completion.txt"
⚠️ **DO NOT** skip the completion file - the orchestrator looks for *.task_complete files
⚠️ **DO NOT** use hardcoded test commands - detect the project type first
⚠️ **DO** follow the exact naming format: YYYY-MM-DDTHH-MM-SS-mmm_reward-emergent-behavior-f362b03e.task_complete
⚠️ **DO** include all sections in the completion file (Changes Made, Tests Run, Files Changed, etc.)
⚠️ **DO** commit all .claude-o files before considering the task complete

The orchestrator checks for files matching: .claude-o/*_reward-emergent-behavior-*.task_complete
If this file doesn't exist with the exact naming pattern, your task will NOT be detected as complete!
