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
| Pictures | `p:pic` | `.ppt-picture` / `img` data URI or local file | Use only when an actual image asset is needed; never full-slide screenshots as final slides. |
| Media | `p:pic` + `p14:media` | `.ppt-media` / `video` / `audio` | Embed local/data video/audio; choreograph the media poster with native timing. |
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

- Start with a slide-level contract, not an effect list:
  `data-ppt-motion-preset="elegant"` and
  `data-ppt-motion-intent="hierarchy|flow|timeline|comparison|layers|metricCluster|hubSpoke|stateChange|gallery|mediaReveal|ambient"`.
  The normalizer backfills missing values, but explicit intent keeps the
  choreography stable across retries.
- `compose` = one object, concurrent native primitives:
  fade + motion + scale + rotation + fill color.
- `data-ppt-sequence` = one container, multiple child targets expanded into
  staggered/overlapped native animations.
- `data-ppt-motif` = one semantic group, expanded into a role-aware choreography
  (timeline spine/items, layers stack, comparison columns, metric cluster,
  hub-spoke center/connectors/satellites).
- `data-ppt-ambient` = low-salience background/environment motion, expanded into
  native looping compose/motionPath/rotation/recolor/media commands. It must sit
  behind foreground content and support the mood or subject, not become the show.
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

### Elegant preset

Use `data-ppt-motion-preset="elegant"` by default. It is a restraint profile, not
a visual style: color, type, layout, and content still come from the deck.

- Prefer `compose`, `sequence`, motif choreography, Morph, fade, and line/spine
  wipes.
- Avoid decorative PowerPoint gallery reveals (`blinds`, `box`, `checkerboard`,
  `circle`, `diamond`, `dissolve`, `plus`, `randombars`, `wedge`, `wheel`) on
  content objects. They may be remapped to fade/wipe by the unattended guard.
- Avoid spin by default. Use it only for a real rotating object (dial, clock,
  loader, wheel) and mark that purpose; otherwise the guard softens it.
- Do not use repeated pulses as texture. One purposeful emphasis per slide is
  enough; repeated/looping effects are clamped unless the slide intent is
  explicitly ambient.
- If four or more objects animate, use a container (`data-ppt-sequence`) or a
  semantic motif. Independent fades on every object are treated as weak
  choreography.
- Ambient background loops are allowed when declared with `data-ppt-ambient` or
  `data-ppt-motion-purpose="ambient"`. Keep them slow, subtle, and independent
  of foreground build timing.

## Appearance Control

Treat element styling as editable native controls:

- Shapes: use semantic preset geometry, CSS fills/gradients/borders, shadow,
  glow, blur, reflection, rotation, and flip.
- Text: keep real text in `.ppt-textbox`; vary hierarchy with size, weight,
  color, alignment, line height, and paragraph builds.
- Lines/freeforms: use connector lines, arrows, dash patterns, SVG polylines, or
  sampled paths for editable diagrams.
- Pictures/media: use local/data assets with native poster geometry and effects;
  animate the carrier or poster with compose/ambient/media commands.
- Animated blur/filter/3D/skew are not native controls. Decompose into layers,
  Morph states, media, or explicit motion paths.

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
