
# Task: emergence-economics

## Description
TASK: Emergence Economics — increase bounties + model-dependent multiplier + pool regen

FILES TO MODIFY:
1. src/arena/task-generator.ts — Update TIER_REWARDS:
   Tier 1: 180_000 (was 60k), Tier 2: 300_000 (was 100k), Tier 3: 500_000 (was 150k), Tier 4: 700_000 (was 200k), Tier 5: 1_000_000 (was 300k)
   Also update TIER_EXPECTED_COST proportionally: Tier 1: 25_000, Tier 2: 45_000, Tier 3: 90_000, Tier 4: 150_000, Tier 5: 225_000

2. src/loop/resolve.ts — In computeIncome(), add a model-dependent multiplier to the task bounty.
   Add a new parameter `model: string` to computeIncome. Before applying efficiency bonus, multiply bountyRequested by a model cost multiplier:
   ```
   const MODEL_BOUNTY_MULTIPLIER: Record<string, number> = {
     "claude-haiku-4-5-20251001": 1.0,
     "claude-haiku-3-5": 1.0,
     "claude-sonnet-4-6": 3.0,
     "claude-sonnet-4-5": 3.0,
     "claude-sonnet-4": 3.0,
     "claude-opus-4-6": 5.0,
     "claude-opus-4-5": 5.0,
   };
   ```
   Use prefix matching (like energy.ts lookupPricing does). Apply multiplier: `bountyRequested = Math.floor(bountyRequested * modelMultiplier)`.
   The caller in state-machine.ts finalizeCycle already has access to this.cur.model — pass it through.

3. src/loop/state-machine.ts — Pass this.cur.model to computeIncome() call on line ~111.

4. src/arena/teq-pool.ts — Update DEFAULT_CONFIG:
   initialBalance: 10_000_000 (was 2M), regenPerCycle: 50_000 (was 5k), maxBalance: 25_000_000 (was 5M)

After changes, run: npx tsc --noEmit
Commit with a clear message about what changed and why.

## Project
- Name: termite
- Path: /Users/kourtis/Sources/termite
- Branch: fix/emergence-economics-1771944855811
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
   - Use `echo "\n## Update: $(date)" >> .claude-o/*_emergence-economics-*.task.md`
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
   cat > .claude-o/$(date -u +%Y-%m-%dT%H-%M-%S-%3N)_emergence-economics-c18fae6f.task_complete << 'COMPLETION'
   # Task Completion Summary

   ## Task: emergence-economics
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
⚠️ **DO** follow the exact naming format: YYYY-MM-DDTHH-MM-SS-mmm_emergence-economics-c18fae6f.task_complete
⚠️ **DO** include all sections in the completion file (Changes Made, Tests Run, Files Changed, etc.)
⚠️ **DO** commit all .claude-o files before considering the task complete

The orchestrator checks for files matching: .claude-o/*_emergence-economics-*.task_complete
If this file doesn't exist with the exact naming pattern, your task will NOT be detected as complete!
