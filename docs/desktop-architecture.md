# Desktop Client Architecture (macOS + Windows)

Verdict: **feasible**. The existing pipeline already factors cleanly into a
desktop app. This document is architecture only — no implementation.

## 1. The invariant core (shell-independent)

Whatever UI shell is chosen, these layers do not change. They are the product.

```
LLM (HTTPS)                 -> writes constrained HTML (data-ppt-* DSL)
preview engine (browser)    -> ppt-anim-runtime.js plays the same attributes
lint  (tools/ppt_html_lint) -> structured {selector, rule, fix}
extract (tools/html2scene)  -> scene JSON + losses (runs IN a browser page)
compile (pptx_native)       -> native editable .pptx + losses[]
validate (pptx_native)      -> package/timing integrity
```

Two properties to protect at all costs:
- **Determinism**: same input -> same .pptx. This is why the *extraction* browser
  engine must be identical on both OSes (see §3).
- **No-vision text loop**: lint violations + compile losses feed back to the LLM
  for automatic correction, with no screenshot in the critical path.

## 2. Runtime dependencies

- A **browser engine** — needed twice: live preview AND structural extraction
  (`html2scene` is already in-page JS via `page.evaluate`).
- **Node** — runs `html2scene` / `ppt_html_lint`.
- **Python** — runs `pptx_native` (compile/validate/pack). ~5k lines.
- **LLM API client** — plain HTTPS.

The browser is the heavy dependency. Everything else is light.

## 3. The critical decision: extraction engine must be ONE engine

The user's instinct is native-per-platform (SwiftUI on macOS, WinUI on Windows).
That is viable for the **shell**, but it creates a real hazard for the **engine**:

| Platform | Native WebView | Engine |
|---|---|---|
| macOS (WKWebView) | WebKit | Safari-family |
| Windows (WebView2) | Chromium | Chrome-family |

`html2scene` (`getComputedStyle`, `getAnimations`, layout boxes) was built and
tested on **Chromium**. Running extraction on WebKit on macOS would make the same
HTML extract differently across platforms — breaking determinism.

**Rule: extraction runs on a single bundled Chromium on every OS.** Preview may
use the system WebView (visual differences are tolerable); extraction may not.

Consequence: you are bundling Chromium regardless. That removes most of the size
advantage of going native, while native still costs two UI codebases.

## 4. Shell options (honest comparison)

| Option | UI code | Engine consistency | Package size | Effort |
|---|---|---|---|---|
| **Electron** | one (web) | built-in Chromium (preview + extract) | ~150–250 MB | lowest |
| **Native shell + bundled Chromium** | two (Swift + WinUI) | OK if extraction pinned to bundled Chromium | ~150–250 MB | highest |
| **Tauri + system WebView** | one (web) | risky: WebKit on mac vs WebView2 | ~40–90 MB | medium, divergence risk |

Recommendation:
- **Fastest viable product / small team → Electron.** One UI, engine unified for
  free, the no-vision loop drops in directly.
- **Native feel is a hard requirement → native shells + one bundled Chromium for
  extraction.** Accept the double-UI cost; never extract on the system WebView.
- Avoid Tauri-with-system-WebView for this product specifically, because the
  deterministic extractor cannot tolerate two different engines.

## 5. Python: bundle now, port later

- **v1**: ship `pptx_native` as a **PyInstaller sidecar** binary, called as a
  subprocess. Build once per OS in CI. Fastest path.
- **Long term**: port `pptx_native` to TypeScript for a single JS runtime (no
  Python, simpler packaging, smaller). It is deterministic string/XML generation —
  a mechanical port, not research.

## 6. Process model (Electron example)

```
main process (Node)
  ├─ LLM client (API key in OS keychain / credential vault)
  ├─ spawns: html2scene / ppt_html_lint (Node)
  ├─ spawns: pptx_native sidecar (compile/validate/pack)
  └─ file I/O, export dialog
renderer (Chromium)
  ├─ chat / prompt UI
  ├─ live preview <webview> with ppt-anim-runtime.js
  └─ shows lint violations + compile losses inline
```

For native shells: replace main+renderer with SwiftUI/WinUI windows that embed a
preview WebView and shell out to the same Node + Python + bundled-Chromium engine.

## 7. End-to-end user loop

```
user describes intent
  -> LLM returns HTML constrained by capabilities.json + ppt-html-contract.md
  -> preview in webview (animations play via ppt-anim-runtime.js)
  -> user edits / approves
  -> lint -> extract -> compile -> validate
  -> losses/violations returned to LLM -> auto-fix -> re-preview
  -> export .pptx (still fully editable in PowerPoint/Keynote)
```

The LLM system prompt ships `capabilities.json` and the contract so the model
stays inside the compilable subset from the first draft.

## 8. Distribution

- macOS: `.app` in a notarized, signed `.dmg` (Developer ID + notarization).
- Windows: signed installer (MSIX or NSIS), code-signing cert.
- Auto-update: Electron has Squirrel/electron-updater; native needs Sparkle
  (mac) + custom (Windows).
- Bundle Chromium + Node + the PyInstaller sidecar inside the app payload.

## 9. Risks / honest caveats

- **Quality still depends on the LLM's HTML.** The app gives preview + the text
  loop, but a human judges visuals. The pipeline guarantees *valid + editable*,
  not *beautiful*.
- **No PowerPoint-open smoke on user machines.** That was a dev QA step; runtime
  relies on deterministic compile + `validate`. Acceptable.
- **Bundle size** (~200 MB) from Chromium.
- **API key handling**: store in OS keychain/credential manager, never in plaintext
  config. Consider a thin backend proxy if you don't want keys on-device.
- **Cost/latency**: each iteration is one LLM call; the auto-fix loop can be 2–3
  calls. Cache capabilities/contract as a stable prefix (prompt caching).

## 10. Milestones

1. Headless engine CLI wrapper: `intent -> html -> lint -> scene -> pptx` callable
   as one command (no UI). Proves the loop outside any shell.
2. Electron MVP: chat -> preview -> export, reusing #1.
3. Auto-fix loop wired to lint/losses.
4. Polish: templates, component palette, undo, multi-slide.
5. (Optional) native shells once the engine is stable; or TS port of pptx_native.
```
