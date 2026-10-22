#!/bin/bash
# Prepares cloud sessions so grunt can build and deploy
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# node_modules is committed; only reinstall if it's missing or broken
if [ ! -f node_modules/grunt/bin/grunt ] || [ ! -d node_modules/grunt-screeps/tasks ]; then
  npm install --no-audit --no-fund
fi

if [ -z "${SCREEPS_TOKEN:-}" ] && [ ! -f .screeps.json ]; then
  echo "Note: SCREEPS_TOKEN not set; deploy (grunt) will fail until it is added to the environment."
fi
