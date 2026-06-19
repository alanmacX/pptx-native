# Design And Motion Contract

This reference keeps the skill's original intent: HTML/CSS is the design surface;
PowerPoint is the native editable output. Do not turn this into a style template
library. Components and motion grammars are structural contracts only.

## Native Component Coverage

Use the native object with the strongest editable meaning:

| Need | Native target | Authoring surface | Notes |
|---|---|---|---|
| Text, labels, headings | `p:sp` textbox | `.ppt-textbox` | Keep a phrase or paragraph in one text box; use rich inline spans instead of many fake text fragments. |
| Shapes, cards, badges | `p:sp` preset geometry | `.ppt-shape data-shape="<preset>"` | Any OOXML preset can pass through. Shape choice is semantic; visual style comes from CSS tokens. |
| Freeform marks | `p:sp` custom geometry | SVG path/polygon | Use for bespoke diagrams, not for ordinary rectangles/cards. |
| Connectors, arrows | `p:cxnSp`/line | `.ppt-line`, SVG line/polyline | Prefer native lines for editable workflows and diagrams. |
| Pictures | `p:pic` | `.ppt-picture` / `img` data URI | Use only when an actual image asset is needed; never full-slide screenshots as final slides. |
| Groups | grouped/native sibling objects | `.ppt-group` as structure | Grouping is structural; children still carry their own object identity and tokens. |
| Tables/charts/notes | native scene JSON bridge | native authoring reference | Use semantic native objects when workbook/editable data matters. Shape-drawn charts are acceptable only when the HTML path is requested and the report says so. |
| Timing/transitions | `p:timing` / `p:transition` | `data-ppt-anim`, `data-ppt-sequence`, `data-ppt-transition`, `data-morph` | Prefer composed native primitives over video/GIF/raster fallbacks. |

## Style-Neutral Components

Component classes define object boundaries, not visual taste.

- Do not bake colors, fonts, border radii, shadows, or spacing into a reusable
  class unless they are explicitly supplied as deck-local CSS variables.
- Use names like `.ppt-flow`, `.ppt-roadmap`, `.ppt-metric-cluster` only to
  express information relationships. They must inherit tokens from the deck.
- Prefer semantic layout diversity: process, evidence stack, comparison, matrix,
  progression, map, funnel, timeline, and operating loop. Do not default every
  slide to three equal cards.

## Motion Grammar

Use animation to carry attention and continuity.

- `compose` = one object, concurrent native primitives:
  fade + motion + scale + rotation + fill color.
- `data-ppt-sequence` = one container, multiple child targets expanded into
  staggered/overlapped native animations.
- `data-morph` + Morph transition = continuity between adjacent slides. Morph
  owns the object's movement; same-slide entrances belong on sibling labels or
  supporting objects.

Sequence example:

```html
<div data-ppt-sequence="stagger; selector:.card; gap:90; overlap:160; y:24; scaleFrom:.96; scaleTo:1; dur:540; ease:out">
  <div class="ppt-shape card" id="a" data-shape="roundRect"></div>
  <div class="ppt-shape card" id="b" data-shape="roundRect"></div>
</div>
```

Rules:

- Keep velocity continuous: if one motion exits right, the next visual action
  should continue, settle, or intentionally counter it.
- Overlap related entrances by roughly 80-160ms. Pure serial queues feel robotic.
- Use one primary motion focus at a time; secondary elements should be softer.
- Pair large movement with a short settle: a slight scale or opacity finish.
- Avoid mixing Morph and same-slide timing on the same slide.
- Prefer concrete motion direction from layout logic: flow arrows move along the
  process; KPI clusters rise softly; evidence reveals from source to conclusion.

## Copy And Preset Hygiene

Avoid AI-smelling output:

- Do not add meaningless English eyebrows in Chinese decks. Use Chinese context
  labels only when they help scanning.
- Titles should be claims or decisions, not generic section names.
- Avoid empty verbs: "empower", "unlock", "transform", "reimagine", unless the
  user supplied that brand voice.
- Avoid identical slide skeletons. Vary information architecture according to
  content, not decoration.
- Use Chinese-friendly Office-safe typography for Chinese decks. Do not force
  awkward Latin-only font choices.
- Never use a preset phrase just because a component exists. Components are
  native object scaffolds; the deck's content decides the wording.
