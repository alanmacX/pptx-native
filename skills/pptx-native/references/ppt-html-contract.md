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
| `.ppt-picture` / `<img>` (data:image) | Picture | class / automatic |

Components are **design tokens**: the class carries no default fill/color/radius/
font — you supply every value via standard CSS (`background`, `color`, `border`,
`border-radius`, `font-*`) or a theme slot. Styling that compiles: color, opacity,
border, radius, font/size/weight/align, linear-gradient, `box-shadow` → shadow,
**glow** (DSL below), solid fill/stroke with alpha, static rotation via
`data-ppt-rotation`. A fill/stroke value may name a theme slot (`accent1`).

Native objects HTML cannot express — **theme, native table, native chart, speaker
notes** — are authored via the native-intent scene JSON, not HTML. See
`docs/native-authoring.md`. (Still HTML gaps: grouped objects, SmartArt, media.)

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

### `data-ppt-morph` (slide-to-slide 平滑)
- Mark the same object on adjacent slides with the same `data-morph` key and the
  compiler can morph it. PowerPoint only compares adjacent slides; a page cannot
  morph from a non-adjacent earlier page unless the same-key object is carried or
  seeded on the immediately previous page. For HTML step flows, set
  `autoMorph:true` on the scene and matching is automatic by `source.key` — no
  per-object marking needed.
- Options: byObject / byWord / byChar.

### Effects
```
data-ppt-glow="color:#A78BFA; radius:18; alpha:0.8"
```

## 5. Enforcement (no-vision feedback loop)

Three text-only gates give an agent everything it needs to self-correct:

1. **normalize** (`tools/ppt_html_normalize.cjs`): runs the page in a browser and
   deterministically fixes common authoring drift before lint/extract:
   unitless native geometry, `inset` shorthand, scrollable overflow, banned
   gradients/filters/transforms, nested native objects, and simple static
   rotation into `data-ppt-rotation`. This avoids slow LLM repair calls for
   mistakes that have an obvious structural fix.
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
