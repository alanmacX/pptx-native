# Scene Guards — deterministic conflict rules

`tools/ppt_guards.cjs` is the single place where **syntactically valid but
semantically conflicting extracted scene** patterns are corrected before
compilation. Raw HTML authoring drift is handled earlier by
`tools/ppt_html_normalize.cjs`. No LLM, no vision: each known bad pattern is one
pure rule, so the pipeline gets steadier over time and a fixed bug never
re-triggers from the same HTML.

`applyGuards(scene)` runs on the assembled scene (after extraction, before
compile), mutates it in place, and records every correction in `scene.guards`,
which surfaces in the pipeline report (`guards auto-fixed: N` in the app).

## Why a guard layer exists

The HTML→PPTX half is a faithful, literal compiler — it translates exactly what
the HTML says, including contradictions. The LLM (the only fuzzy step) can emit
valid-but-conflicting HTML. Rather than hope the LLM remembers PowerPoint
semantics, we encode each conflict as a deterministic rule here.

## Current rules

| rule | trigger | correction | why |
|---|---|---|---|
| `morph-vs-entrance` | element has `data-morph` AND a within-slide entrance/exit (`data-ppt-anim`) | drop the entrance/exit on that object | Morph owns the object's motion across slides; a competing entrance/exit breaks **backward navigation** in PowerPoint and hides the object on return |
| `morph-slide-timing` | slide has a Morph transition and any same-slide animation timing | drop all same-slide animations on that Morph slide | PowerPoint for Mac can get stuck on backward navigation when Morph and a `p:timing` tree coexist on the same slide; put builds on a non-Morph slide |
| `drop-phantom` | non-line element with width≤1 or height≤1 | remove it | stage/wrapper containers (e.g. `#s1`) get captured as invisible 0×0 shapes — noise |
| `clip-offcanvas` | non-morph element fully outside the 1280×720 canvas | remove it | a common layout/overflow mistake; morph "engulf" objects are exempt (they exceed the canvas on purpose) |

## Adding a rule

When a new "valid but wrong" pattern is found (heavy-debug sessions are the main
source), add a `rule*(scene, corrections)` function to `ppt_guards.cjs` and append
it to `RULES`. Each rule:
- is pure and deterministic (same scene → same result),
- pushes `{ rule, slide, target, message }` per correction,
- prefers correcting over failing (the deck still compiles).

The matching authoring rule should also go into the LLM system prompt and, where
checkable on raw HTML, into `tools/ppt_html_normalize.cjs` / `tools/ppt_html_lint.cjs`
— four layers: prompt/spec pack (prevent), normalize (mechanically repair), lint
(block/report), guard (correct extracted scene conflicts deterministically).
