# PPT-Native HTML Contract

This is the contract any agent (including ones with **no visual capability**)
follows when writing HTML that the pipeline compiles into editable native PPTX.

The rule is simple: **HTML is the design surface, not a screenshot source.** Write
HTML in the subset below and every element has a deterministic native PowerPoint
target. Anything outside the subset is an explicit loss, reported — never
silently faked.

Authoritative companions:
- `capabilities.json` — machine-readable list of what compiles (query it first).
- `references/native-surface-inventory.md` — carrier/property matrix; check it
  before putting an effect or animation on an object type.
- `docs/ppt-native-catalog.md` — the full OOXML ground truth.
- `docs/animation.md` — animation writer details.

---

## 1. Canvas

- One fixed-size stage per slide (e.g. `1280×720` → 16:9). Use absolute layout
  with deterministic bounding boxes.
- Multiple slides = multiple `<section class="slide" data-slide="N">`, or
  `window.goToStep(n)` states for HTML step flows.
- **Banned**: scroll-dependent layout, `100vh` flow, anything whose box is not
  determinable from a settled render.

## 2. Element whitelist (each maps to a native object)

The reader is **class-driven and declarative**: classification comes from the
`.ppt-*` component class, geometry from the settled box, and styling from the
*declared* tokens — never from a computed-style heuristic. An element with no
component class is an explicit loss, not a guess.

| HTML | native | how to mark |
|---|---|---|
| `.ppt-textbox` (text, inline `<span>` runs) | TextBox (rich runs) | class |
| `.ppt-shape data-shape="<preset>"` | preset shape | `data-shape` = **any** OOXML preset (165; see `capabilities.json` `components.shape.presets`) |
| `.ppt-line` / `<svg><line>`/`<polyline>` stroked | connector/line | class / automatic; `data-arrow="end"` or `marker-end` → arrow |
| filled `<svg><path>`/`<polygon>` | freeform (`custGeom`) | automatic from sampled points |
| `.ppt-picture` / `<img>` (`data:image`, `file://`, local path) | Picture | class / automatic |
| `.ppt-media` / `<video>` / `<audio>` | Media poster picture + embedded video/audio | class / automatic; `data-media-type="audio|video"`, optional poster |

Components are **design tokens**: the class carries no default fill/color/radius/
font — you supply every value via standard CSS (`background`, `color`, `border`,
`border-radius`, `font-*`) or a theme slot. Styling that compiles: color, opacity,
border, radius, font/size/weight/align, linear-gradient, `box-shadow` → shadow,
**glow** (DSL below), solid fill/stroke with alpha, static rotation via
`data-ppt-rotation`. A fill/stroke value may name a theme slot (`accent1`).

Native objects HTML cannot express — **theme, native table, native chart, speaker
notes** — are authored via the native-intent scene JSON, not HTML. See
`docs/native-authoring.md`. (Still HTML gaps: grouped objects, SmartArt.)

**Banned / loss-reported**: `backdrop-filter`, complex CSS `filter`,
`mix-blend-mode`, Canvas/WebGL, pseudo-elements carrying key content, conic/radial
gradients, arbitrary `clip-path`, and CSS transform used for layout/scale/skew.

## 3. Text rule

A run of continuous text must be **one** text-flow box with inline runs — never a
dozen absolutely-positioned `<div>`s faking one sentence (that compiles to
overlapping uneditable boxes).

## 4. Animation — declarative `data-ppt-*` only

Do **not** hand-write `@keyframes` for key motion. Declare intent; the same
attributes drive both the browser preview runtime and the OOXML compiler.
The normalizer can repair a small subset of simple CSS keyframes (opacity,
rotate, scale/pulse) into `data-ppt-anim`, but agents should still author the
intent directly.

### Slide-level motion contract
```
<section class="ppt-slide"
  data-ppt-motion-preset="elegant"
  data-ppt-motion-intent="timeline">
```
- `data-ppt-motion-preset`: `elegant` by default. Other accepted values are
  `neutral`, `technical`, `expressive`, and `none`. The elegant preset favors
  compose, sequence, motif choreography, Morph, fade, and line/spine wipes; it
  treats decorative gallery reveals and repeated flourishes as hygiene issues.
- `data-ppt-motion-intent`: the choreography goal for the slide. Use
  `hierarchy`, `flow`, `sequence`, `timeline`, `comparison`, `layers`,
  `metricCluster`, `hubSpoke`, `stateChange`, `gallery`, `mediaReveal`, or
  `ambient`.
- If a slide has several moving objects, declare the intent first, then choose
  one grammar: `compose` for one focus, `data-ppt-sequence` for a group,
  `data-ppt-motif` for semantic structures, or Morph for cross-slide state.

### `data-ppt-anim`
```
data-ppt-anim="entrance:fade; trigger:afterPrev; dur:450; delay:0"
```
- `entrance:` ∈ capabilities `animation.within.entrance`
  (fade, wipe, blinds, box, checkerboard, circle, diamond, dissolve, plus,
  randombars, wedge, wheel) or `appear`.
- `exit:` same set (compiles to `exit-<effect>`).
- `emphasis:` ∈ spin / grow / shrink / pulse.
  - spin extras: `spins`, `byDeg`. scale extras: `scale` (percent).
- `motion:` with `path:"M 0 0 L 0.2 0"` (PowerPoint relative path units).
- `compose` for one native timing group made from concurrent primitives:
  `data-ppt-anim="compose; opacity:in; x:-90; y:24; scaleFrom:.92; scaleTo:1; rotateFrom:-4; rotateTo:0; dur:650"`.
  Use it for polished web-style entrances where fade, settle, zoom, turn, and
  color shift happen together. It compiles to native `animEffect`, `animMotion`,
  `animScale`, `animRot`, and `animClr` children.
- `trigger:` ∈ onClick / withPrev / afterPrev / auto. **Banned triggers**: scroll,
  hover, infinite loop (PowerPoint cannot store them).
- Media commands on `.ppt-media`: `data-ppt-anim="media:play"`,
  `media:pause`, or `media:stop` compile to native `p:cmd` timing.

### `data-ppt-build` (per-paragraph text reveal)
```
data-ppt-build="byParagraph; trigger:onClick; effect:wipe"
```
Compiles to native `bldP build="p"` — one reveal per paragraph.

### `data-ppt-sequence` (container choreography)
```
data-ppt-sequence="stagger; selector:.card; gap:90; overlap:160; y:24; scaleFrom:.96; scaleTo:1; dur:540; ease:out"
```
Put this on a structural container. It expands child native objects into a
staggered sequence of native timing effects. The sequence does not carry visual
style; children still get their own CSS tokens. Use it for cascades, handoffs,
and grouped reveals where timing continuity matters.

> **Coordinate-frame trap.** A positioned container (`.ppt-stagger`/`.ppt-group`
> at some `left/top`) establishes a local frame: its children's `left/top` are
> relative to the container. If you then place *overlay* siblings — a number,
> label, icon, or caption meant to sit on a child card — as direct children of
> the slide, those use the slide frame, and they will land shifted by the
> container's offset (e.g. a card grid offset 92px right while its labels start
> at the slide's left edge → every label pokes out the left of its card). Keep a
> card and the content that sits on it in the **same** container (so they share
> one frame), or add the container's `left/top` to each overlay sibling. The
> linter flags this as `LAYOUT_PANEL_OVERFLOW`.

### `data-ppt-ambient` (background/environment motion)
```
data-ppt-ambient="drift; selector:.bg-orb; x:18; y:-10; dur:9000; repeat:infinite; alt; ease:inout"
```
Put this on a background container or a native target. It expands to native
looping timing rows and is meant for low-salience environmental movement, not
foreground builds. Modes: `drift`/`float`/`pan` (compose motion),
`breathe`/`pulse` (compose scale), `shimmer`/`sweep` (one-way overlay drift),
`recolor` (native `animClr`), `path`/`orbit` (raw PowerPoint motion path),
`rotate` (native rotation), and `media`/`play` (native media command on
`.ppt-media`). Ambient rows are marked `ambient:true`, so the elegant preset does
not clamp intentional background loops.

### `data-ppt-motif` (semantic choreography)
```
data-ppt-motif="timeline; axis:x; from:left; dur:520; gap:140; overlap:120"
```
Declare *what a group is* on its container and the compiler expands it into the
same staggered native timing `data-ppt-sequence` produces — no per-child
animation strings. Motifs carry no visual style. Mark children with
`data-ppt-role` (`spine`/`node`/`card`/`left`/`right`/`center`/`item`) or let
inference classify them. Known motifs: `timeline`, `layers`, `comparison`,
`metricCluster`, `hubSpoke` (an unknown name is reported, not silently ignored). See
`docs/motif-choreography-proposal.md`.

### `data-ppt-morph` (slide-to-slide 平滑)
- Mark the same object on adjacent slides with the same `data-morph` key and the
  compiler can morph it. PowerPoint only compares adjacent slides; a page cannot
  morph from a non-adjacent earlier page unless the same-key object is carried or
  seeded on the immediately previous page. For HTML step flows, use
  `data-ppt-transition="type:morph; auto:true"` on the destination slide; scene
  JSON may also set `autoMorph:true`. Matching is automatic by explicit stable
  identity (`data-morph`, source id, or non-generated source key), then by
  unique identical text or image source — no per-object marking needed.
- Options: byObject / byWord / byChar.

### Effects
```
data-ppt-glow="color:#A78BFA; radius:18; alpha:0.8"
```

### Advanced element control

- Shapes: `data-shape` accepts the OOXML preset set; use CSS fill, border,
  border-radius, linear/radial gradients, shadow, glow, blur, reflection, static
  rotation/flip.
- Text: use one `.ppt-textbox` with inline runs for continuous copy; control
  font, size, weight, color, alignment, vertical alignment, line height, and
  paragraph build.
- Lines/freeforms: use `.ppt-line` or SVG line/polyline/path for editable
  connectors and custom marks; use stroke width/color/dash and arrow ends.
- Pictures/media: use local/data assets; style poster/picture geometry, shadow,
  glow, blur, reflection, rotation, and choreograph with native timing.
- Unsupported animated appearance changes (animated blur radius, arbitrary CSS
  filters, 3D/perspective, skew) must be decomposed into supported sibling
  objects, Morph, media, or explicit motion paths.

## 5. Enforcement (no-vision feedback loop)

Three text-only gates give an agent everything it needs to self-correct:

1. **normalize** (`tools/ppt_html_normalize.cjs`): runs the page in a browser and
   deterministically fixes common authoring drift before lint/extract:
   unitless native geometry, `inset` shorthand, scrollable overflow, banned
   gradients/filters/transforms, nested native objects, missing motion
   preset/intent, decorative animation drift under the elegant preset, and simple
   static rotation into `data-ppt-rotation`. This avoids slow LLM repair calls
   for mistakes that have an obvious structural fix.
2. **lint** (`tools/ppt_html_lint.cjs`): runs the page in a browser and checks
   the subset — banned elements/CSS, undeclared CSS animation, and invalid
   `data-ppt-*` DSL (unknown effect/trigger) — emitting structured
   `{selector, level, rule, message, fix}`. Exit 0 = no errors, 2 = errors.
   ```bash
   node tools/ppt_html_lint.cjs input.html --out lint.json
   ```
   The valid effect/trigger vocab is read from `capabilities.json`, so the linter
   never drifts from the compiler.
3. **compile loss report** + **validate**: `create` returns a `losses[]` array
   instead of crashing on a bad animation. The good parts still compile; each
   problem is a structured, actionable entry:
   ```json
   { "code": "ANIM_EFFECT_UNSUPPORTED", "where": {"slide": 1},
     "target": "#a",
     "message": "Unsupported animation effect: sparkle",
     "suggestion": "Use a supported effect from capabilities.animation.within ..." }
   ```
   Codes today: `ANIM_TARGET_NOT_FOUND`, `ANIM_EFFECT_UNSUPPORTED`,
   `ANIM_MOTION_PATH_MISSING`. An agent reads these and self-corrects with no
   screenshot.

```
write HTML (subset) → normalize → lint → preview → html2scene → create → validate/loss
   → read text report → fix → repeat
```

No screenshot is ever required in this loop. Screenshots are human QA only.

## 6. Why two enforcement layers

The recommended path is the **component library** in `web/ppt-components.css`
(`.ppt-slide`, `.ppt-textbox`, `.ppt-shape`, `.ppt-stagger`, …) that bakes the
subset in so the agent cannot drift. The **linter** is the backstop for when an
agent hand-writes raw HTML and strays outside the subset. Component library =
stay-on-rails; linter = catch the escapes.

## 7. Live preview

Drop `web/ppt-anim-runtime.js` into the preview HTML. It reads the same
`data-ppt-*` attributes the compiler reads and plays them in the browser (click /
ArrowRight / Space to advance, ArrowLeft to restart), so **what the user previews
is what lands in the .pptx**. Preview fidelity is approximate; the OOXML compiler
remains the source of truth. The linter treats `data-ppt-*` elements'
filter/clip-path/transform as runtime-owned, so the preview script does not create
false positives.

End-to-end loop:

```
author with web/ppt-components.css + data-ppt-*  (preview via ppt-anim-runtime.js)
  -> node tools/ppt_html_normalize.cjs       (deterministic authoring cleanup)
  -> node tools/ppt_html_lint.cjs            (structured violations)
  -> node tools/html2scene.cjs               (scene + losses)
  -> python -m pptx_native create|validate|pack   (native editable .pptx)
```
</content>
