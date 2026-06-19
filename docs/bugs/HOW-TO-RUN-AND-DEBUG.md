# How to run & debug this app (read first)

This bug is in a **macOS Electron desktop app** — a coding-agent-style PPT
generator. It is NOT a web page or a CLI. To reproduce/observe the bug you must
launch the Electron app and watch its windows + logs. This guide tells you how.

## What the app is
`app/` is an Electron app:
- **Main process** (`app/main.js`, Node): IPC handlers, LLM calls, file dialogs,
  spawns the Node/Python pipeline. Runs in the Electron main process (has `fs`,
  `fetch`, child_process).
- **Renderer** (`app/renderer/`, Chromium): the chat UI + a `<webview>` preview +
  an HTML code tab. `renderer.js` talks to main via `window.studio.*` (see
  `app/preload.js` for the bridge).
- **Engine** (`app/engine/`): `providers.js` (LLM HTTP + SSE streaming + thinking
  control + max-token retry + truncation continuation), `llm.js` (prompt),
  `orchestrator.js` (plan → parallel per-slide/region workers → stitch),
  `htmlValidation.js` (empty/truncation diagnostics), `pipeline.js` (html→pptx).

## Run it
```bash
cd app
npm install        # first time (installs electron, ~70 pkgs)
npm start          # launches the Electron window
```
A window titled “PPT Agent” opens. Left = chat, right = Preview / HTML tabs,
top-right = provider selector + ⚙ Providers + ⇪ Open HTML.

## Configure a provider (required to generate)
⚙ Providers → add one (nothing is built in):
- format `anthropic` → Base URL `https://…/anthropic`, model, key, Thinking=low.
- or `openai` → Base URL `https://…/v1`, model `gpt-4o`, key.
The active provider config persists at:
`~/Library/Application Support/ppt-native-studio/providers.json`

## Where to look when debugging
- **Main-process stdout/stderr**: whatever `npm start` prints in your terminal.
  Add `console.log` in `app/main.js` / `app/engine/*` — it shows there.
- **Renderer console**: open it from the running app. Either add
  `win.webContents.openDevTools()` in `createWindow()` (main.js), or build with a
  devtools shortcut. `console.log` in `app/renderer/renderer.js` shows in THAT
  devtools console, not the terminal.
- **The `<webview>` preview** is a separate web context. To debug what renders
  inside it, log `did-fail-load` on the webview (already partially handled in
  `renderer.js`'s `loadPreviewUrl`).
- **Saved artifacts** (written by main on each generate): `os.tmpdir()/ppt-last.html`,
  `ppt-last-raw.txt`, `ppt-last-meta.json` — inspect the exact HTML + meta
  (finishReason, thinking/text chars, eventCounts). On macOS tmpdir is under
  `/var/folders/...` or `/private/tmp/...`; the chat shows the exact path.

## Drive the engine WITHOUT the GUI (fastest debug loop)
The engine is plain Node modules — you can exercise them headlessly, no Electron:
```js
// node script
const providers = require("./app/engine/providers");
const { buildDeck } = require("./app/engine/orchestrator");
const cfg = providers.load(require("os").homedir()+"/Library/Application Support/ppt-native-studio");
const p = cfg.providers.find(x=>x.id===cfg.activeId);
buildDeck(p, "<intent>", { onProgress: console.log }).then(d => require("fs").writeFileSync("/tmp/out.html", d.html));
```
Run with a Node that has `fetch` (Node 18+). This isolates LLM/generation bugs
from the Electron UI. To test the html→pptx pipeline without the LLM:
```bash
node app/engine/pipeline.js /tmp/out.html /tmp/out.pptx
```
(`pipeline.js` shells out to `tools/html2scene.cjs` via Node+Playwright and to
`python -m pptx_native` for compile — paths configurable via env `PPT_NODE_BIN`,
`PPT_NODE_PATH`, `PPT_PYTHON`.)

## Hot-reload note
Changes to `app/engine/*` and `app/main.js` need an app restart (`pkill -f
"app/node_modules/electron"` then `npm start`). Renderer changes (`app/renderer/*`)
need a window reload (Cmd+R) — but that clears the chat thread.

## TL;DR for this bug
Repro = launch the app, configure the (slow, thinking) provider, paste a long
multi-slide prompt, Generate. Inspect `ppt-last.html` + `ppt-last-meta.json` and
the main-process terminal output. The headless `buildDeck` loop above reproduces
generation issues far faster than clicking the GUI.
