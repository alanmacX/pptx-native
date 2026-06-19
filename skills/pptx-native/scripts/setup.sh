#!/usr/bin/env bash
# One-time setup: install Playwright + headless Chromium into the skill's own
# node_modules so build.sh works without any external runtime. Safe to re-run.
# Needs: node, npm (and network for the first install).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$HERE/engine"
NODE="${PPT_NODE_BIN:-node}"
NPM="${PPT_NPM_BIN:-npm}"

if "$NODE" -e "require('$ENGINE/node_modules/playwright')" >/dev/null 2>&1; then
  echo "playwright already installed in skill"
else
  echo "installing playwright into $ENGINE ..."
  ( cd "$ENGINE" && "$NPM" install --no-audit --no-fund )
fi

echo "ensuring headless chromium is downloaded ..."
"$NODE" "$ENGINE/node_modules/playwright/cli.js" install chromium-headless-shell
echo "setup complete"
