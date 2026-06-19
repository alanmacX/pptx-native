# Parallel PPT Agent — Design

Goal: remove the "rigid / serial" feel by replacing one monolithic generation
with an **orchestrator + parallel workers** task graph. Latency drops from
O(sum of slides) to ~O(slowest slide); the UI shows slides building concurrently.

This document is the design. No code yet.

---

## 1. Task graph (DAG)

```
intent
  → [PLAN]                         1 fast LLM call → deck plan (JSON)
  → [SLIDE 1] [SLIDE 2] … [SLIDE N] parallel LLM calls → per-slide HTML fragments
  → [STITCH]                       deterministic merge → single multi-step HTML
  → [LINT 1] [LINT 2] … [LINT N]   parallel checks on fragments
  → [FIX k]  (only failing ones)   parallel repair calls
  → [COMPILE]                      single deterministic pass → .pptx
```

What parallelizes and what does not:

| Stage | Parallel? | Why |
|---|---|---|
| Plan | no (1 call) | global decisions must come first |
| Slide workers | **yes** | independent given the plan — the main win |
| Stitch | no (deterministic) | merges fragments; fast |
| Lint | **yes** | per-fragment, independent |
| Fix | **yes** | only failing fragments, independent |
| Extract + Compile | no | operate on the whole document; already fast |

Bottleneck is LLM latency, so parallelism lives in Plan-output → Workers and in
Lint/Fix. Stitch/extract/compile stay single and deterministic.

---

## 2. Planner output schema (the contract every worker obeys)

The planner does NOT write HTML. It emits structured JSON:

```jsonc
{
  "canvas": { "w": 1280, "h": 720 },
  "tokens": {                      // global design system — all workers must use
    "bg": "#0b1020",
    "fontFamily": "Inter, system-ui, sans-serif",
    "palette": ["#c4b5fd", "#6d28d9", "#f59e0b", "#06b6d4"],
    "title": { "size": 46, "weight": 700, "color": "#e5e7eb" },
    "grid": { "margin": 80, "gap": 24 }
  },
  "slides": [
    {
      "id": "s1",
      "step": 0,
      "summary": "three glowing orbs top-right, title left",
      "transitionInto": null,                       // between-slide anim into this step
      "elements": [
        { "id": "title", "kind": "textbox", "text": "Three orbs",
          "box": [80,90,760,90], "role": "title" },
        { "id": "orb1", "kind": "ellipse", "box": [980,70,120,120], "fill": "palette.0",
          "anim": "entrance:fade; trigger:auto" }
      ]
    },
    {
      "id": "s2",
      "step": 1,
      "summary": "orb1 grows to engulf the whole canvas",
      "transitionInto": "morph; option:byObject; dur:1600; speed:slow",
      "elements": [
        { "id": "orb1", "kind": "ellipse", "box": [-260,-1170,2600,2600], "fill": "palette.0" }
      ]
    }
  ],
  "morph": [
    // objects that are the SAME across steps → shared id, must keep geometry type
    { "id": "orb1", "shape": "ellipse", "steps": [0,1],
      "rule": "keep circle; grow from own center; aspect ratio constant" }
  ]
}
```

Key fields that make parallel generation coherent:
- **tokens** — one design system, referenced by all workers (`fill:"palette.0"`).
- **morph[]** — declares cross-step identity + the morph rule, so independently
  generated slides still share object ids and keep circle→circle (no stretch).
- **box** in canvas px — workers place elements deterministically, not by taste,
  which keeps slides aligned and avoids overflow.

---

## 3. Slide worker contract

Each worker gets: `{ tokens, slide, morphRefs }` for ONE slide and returns an
HTML fragment for that step only.

Rules enforced in the worker prompt:
- Output ONLY the inner HTML for this slide's elements (no `<html>`/stage wrapper —
  the stitcher owns those).
- Use the given element `id`s verbatim (so morph + goToStep wiring works).
- Resolve `fill:"palette.N"` against tokens; use `linear-gradient` for richness.
- Emit `data-ppt-anim` for within-slide and nothing for between-slide (the stage
  transition is set by the stitcher from `transitionInto`).
- Morph objects: must match the geometry in `morph[]` for each step they appear in.

Worker output example (fragment for s1):
```html
<div class="ppt-textbox" id="title" style="left:80px;top:90px;width:760px;font-size:46px;color:#e5e7eb;font-weight:700">Three orbs</div>
<div class="ppt-shape" id="orb1" data-shape="ellipse" style="left:980px;top:70px;width:120px;height:120px;background:linear-gradient(135deg,#c4b5fd,#6d28d9)" data-ppt-glow="color:#a78bfa; radius:24" data-ppt-anim="entrance:fade; trigger:auto"></div>
```

A worker emits one fragment PER step the slide's object appears in (or, for the
goToStep model, the base fragment + the per-step style deltas — see §4).

---

## 4. Stitcher (deterministic, no LLM)

Responsibilities:
1. **Assemble** one `.ppt-slide` stage with all base elements (step 0 state).
2. **goToStep wiring**: for each later step, emit `body.stepN #id { …overrides }`
   CSS from the plan's per-step `box`/style deltas, and generate
   `window.goToStep(n)` that toggles `body.stepN`.
3. **Stage transition**: set `data-ppt-transition` on `.ppt-slide` from each
   step's `transitionInto` (apply via goToStep, or a per-step attribute map).
4. **Dedupe & namespace**: merge `<style>` blocks; detect id collisions between
   workers and prefix non-morph ids (`s2__foo`); morph ids (from `morph[]`) are
   kept global and never prefixed.
5. **Sanity**: drop elements whose box falls fully outside the canvas unless
   they're a declared morph "engulf" object.

Output: the single self-contained HTML doc that is both preview and pptx
blueprint — identical shape to what we hand-author today, so extract/compile are
unchanged.

---

## 5. Concurrency control

- **Pool**: cap concurrent LLM calls (default 3–4) with a queue; providers rate-limit.
- **Backpressure**: workers stream; the orchestrator advances the queue as each finishes.
- **Failure isolation**: a worker failure marks only that slide; retry once, then
  fall back to a minimal placeholder fragment + a loss entry. The deck still builds.
- **Cancellation**: a single AbortController per run cancels all in-flight calls.
- **Speculative (optional)**: for a slide flagged "hard" (e.g. the morph step),
  fan out 2–3 variants in parallel, keep the first that lints clean and matches
  the morph rule. Trades tokens for latency + quality.

---

## 6. Orchestrator (in the Electron main process)

A small task runner:
```
run(intent):
  plan      = await planner(intent)                  # 1 call, streamed as status
  fragments = await pool.map(plan.slides, worker)    # parallel, each streams to its card
  html      = stitch(plan, fragments)                # deterministic
  lint      = await pool.map(fragments, lintFragment)# parallel
  fixes     = await pool.map(lint.failures, fixSlide)# parallel, re-stitch
  return { html, report }                            # then UI calls compile/export
```
Each node emits events (`plan:done`, `slide:k:thinking|writing|done|error`,
`stitch:done`, `lint:k`, …) so the UI renders live per-slide progress.

---

## 7. UI: parallel cards (kills the "rigid" feel)

Replace the single pending bubble with a board:
```
Planner ✓  (design tokens, 2 slides, 1 morph object)
┌── Slide 1 ──────────┐ ┌── Slide 2 ──────────┐
│ ✍️ writing… 6s      │ │ 🤔 thinking… 6s     │
│ <fragment preview>  │ │                     │
└─────────────────────┘ └─────────────────────┘
```
Cards stream independently; each flips to ✓ lint-ok or ⚠ with a one-click fix.
The right pane shows the stitched preview once all cards are done (or live as
each completes for a progressive preview).

---

## 8. Consistency: why parallel slides still look like one deck

1. **One planner, one token set** → shared palette/typography/grid.
2. **Boxes from the plan** → deterministic layout, no per-slide drift, no overflow.
3. **morph[] contract** → cross-step identity + the circle→circle rule enforced
   centrally, not left to each worker.
4. **Stitcher owns the stage/transition** → workers can't disagree on canvas size
   or transitions (the bug that caused the earlier stretch/overflow).

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Cross-slide style drift | planner tokens + boxes; workers may not invent layout |
| id collisions on merge | stitcher namespaces non-morph ids |
| morph breaks across independent slides | `morph[]` whitelist of shared ids + per-step geometry |
| provider rate limits | concurrency pool + queue + retry/backoff |
| higher token cost | smaller per-slide prompts; net tokens ~similar, latency much lower |
| one slide fails | failure isolation + placeholder + loss entry; deck still compiles |

---

## 10. Incremental rollout

1. **Planner + parallel workers + stitcher** behind a flag; keep current monolithic
   path as fallback for single-slide decks.
2. **Parallel per-slide lint + auto-fix.**
3. **Parallel cards UI.**
4. **Speculative variants** for flagged-hard slides.

Stages 1–2 are the bulk of the latency + "feel" win; 3 is the perceived-parallelism
win; 4 is optional quality insurance.
