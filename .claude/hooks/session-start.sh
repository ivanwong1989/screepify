#!/bin/bash
# Prepares cloud sessions so the v2 toolchain (esbuild, tsc, node --test) can run
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# node_modules is not committed on v2; install if missing or incomplete
if [ ! -x node_modules/.bin/esbuild ] || [ ! -x node_modules/.bin/tsc ] || [ ! -d node_modules/screeps-api ]; then
  npm install --no-audit --no-fund
fi

if [ -z "${SCREEPS_TOKEN:-}" ] && [ ! -f .screeps.json ]; then
  echo "Note: SCREEPS_TOKEN not set; npm run deploy will fail until it is added to the environment."
fi
