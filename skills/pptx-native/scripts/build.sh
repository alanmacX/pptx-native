#!/usr/bin/env bash
# Compile a PPT-native HTML file into an editable .pptx.
# Usage: build.sh <input.html> <output.pptx>
# Runs: normalize -> lint -> html2scene -> pptx_native create -> validate -> pack
# and prints a JSON report (ok / lint / validate / losses) to stdout.
#
# Self-locating: finds a node that can resolve Playwright (used by html2scene to
# read computed styles). If none is found, run scripts/setup.sh once.
# Overridable: PPT_NODE_BIN, PPT_NODE_PATH (NODE_PATH for playwright), PPT_PYTHON.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$HERE/engine"
NODE="${PPT_NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE" ]; then echo '{"ok":false,"error":"node not found on PATH; set PPT_NODE_BIN"}'; exit 1; fi

# Locate a directory whose node_modules resolves "playwright". Prefer an explicit
# PPT_NODE_PATH, then the skill's own bundle, then this node's global modules.
resolve_playwright() {
  for cand in \
    "${PPT_NODE_PATH:-}" \
    "$ENGINE/node_modules" \
    "$("$NODE" -e 'process.stdout.write(require("path").join(require("os").homedir(),".cache","codex-runtimes","codex-primary-runtime","dependencies","node","node_modules"))' 2>/dev/null)" \
    "$("$NODE" -e 'try{process.stdout.write(require("child_process").execSync("npm root -g",{stdio:["ignore","pipe","ignore"]}).toString().trim())}catch(e){}' 2>/dev/null)"; do
    [ -n "$cand" ] || continue
    if NODE_PATH="$cand" "$NODE" -e 'require("playwright")' >/dev/null 2>&1; then
      printf '%s' "$cand"; return 0
    fi
  done
  return 1
}

if ! PW_PATH="$(resolve_playwright)"; then
  echo '{"ok":false,"error":"Playwright not found. Run scripts/setup.sh once to install it into the skill."}'
  exit 1
fi

export PPT_NODE_BIN="$NODE"
export PPT_NODE_PATH="$PW_PATH"
export PPT_PYTHON="${PPT_PYTHON:-python3}"
exec "$NODE" "$ENGINE/app/engine/pipeline.js" "$@"
