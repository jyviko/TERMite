#!/bin/bash
# Helper script to create task completion file with proper naming
# Usage: ./complete_task.sh

TASK_NAME="memorize-resolve-sonnet"
TASK_ID="33536708"
BASE_BRANCH="feature/TERM_tools"
TIMESTAMP=$(date -u +%Y-%m-%dT%H-%M-%S-%3N)
COMPLETION_FILE=".claude-o/${TIMESTAMP}_${TASK_NAME}-${TASK_ID}.task_complete"

# Collect git information
FILES_CHANGED=$(git diff --name-status ${BASE_BRANCH}...HEAD)
COMMIT_LOG=$(git log --oneline ${BASE_BRANCH}..HEAD)

# Create completion file
cat > "${COMPLETION_FILE}" << 'COMPLETION_EOF'
# Task Completion Summary

## Task: ${TASK_NAME}
**Status**: ✅ Completed
**Date**: $(date -u +%Y-%m-%d)

## Changes Made
- [FILL IN: List specific files changed]
- [FILL IN: List specific features added/bugs fixed]
- [FILL IN: Any architectural decisions made]

## Tests Run
- [FILL IN: Which tests were executed]
- [FILL IN: Test results summary]
- [FILL IN: Any skipped tests and why]

## Files Changed
```
${FILES_CHANGED}
```

## Commit Summary
```
${COMMIT_LOG}
```

## Notes
- [FILL IN: Any caveats or issues encountered]
- [FILL IN: Any follow-up work needed]
- [FILL IN: Dependencies or breaking changes]
COMPLETION_EOF

echo "✅ Created completion file: ${COMPLETION_FILE}"
echo ""
echo "⚠️  IMPORTANT: Edit the file to fill in [FILL IN] sections:"
echo "   vi ${COMPLETION_FILE}"
echo ""
echo "Then commit:"
echo "   git add .claude-o && git commit -m 'docs: task complete'"
