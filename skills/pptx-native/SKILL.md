---
name: pptx-native
description: >-
  Compile standard HTML + CSS into a native, fully-editable PowerPoint deck
  (.pptx). Use whenever the user wants to create, build, design, or generate a
  PowerPoint deck, slide presentation, pitch deck, or .pptx — especially when
  they care how it looks or moves: visual polish, gradients (linear or radial),
  glows, shadows, reflections, blur, color themes; any animation or motion
  (entrance, emphasis, exit, cascade, stagger, loop) or slide transitions
  (morph, push, wipe, fade); turning an outline or topic into a deck; or
  multi-slide decks (e.g. a 5-slide pitch deck or product-launch PPT). Works in
  any language (做PPT / 演示文稿 / 幻灯片, 渐变, 入场动画, morph转场, 好看的PPT,
  带动画的幻灯片). Prefer over plain python-pptx for design- or animation-heavy
  work. Do NOT trigger for converting, merging, or extracting text from existing
  decks, or non-slide documents (Word, Excel, PDF, Google Slides).
---

# pptx-native — a compiler from HTML/CSS to native PowerPoint

This is a **tool, not a template library.** You author a slide deck the way you
would author a web page — standard HTML for structure, standard CSS for looks and
motion — and the tool compiles it to a **native, fully-editable .pptx**: real
shapes, text, gradients, effects, and PowerPoint animation timing. Every object
maps to native OOXML, so the user can open the deck and edit anything.

**There are no canned effect presets to pick from.** You express what you want in
ordinary CSS; the compiler maps each property and animation to its native
PowerPoint equivalent. Anything PowerPoint cannot represent is reported as an
**explicit loss** (never silently dropped), so you can see it and adjust. Write
whatever you'd write for a beautiful web slide — the ceiling is PowerPoint's
native capability, not a fixed menu.

## Workflow

1. **Author** an HTML file (see contract below).
2. **Compile**: `scripts/build.sh <input.html> <output.pptx>` — runs
   `normalize → lint → html2scene → pptx_native create → validate → pack` and
   prints a JSON report.
3. **Read the report, self-correct.** `ok` (lint+validate passed),
   `lint.violations` (each with a fix suggestion), `losses` (CSS the engine
   couldn't map natively — accept it or rephrase), `validate.errors` (should be
   empty). Iterate until `ok:true` with no unintended losses.
4. **Show it.** Render the HTML at 1280×720 and screenshot each `.ppt-slide`
   (see Previewing) — the HTML is a faithful blueprint.

Design is not this tool's job. Layout, color, typography, density, motion choices —
all of that is decided by you (the model) reading the user's request, the same way
you'd design any web page. This file describes only the **mechanics**: how to author
and what compiles to native PowerPoint. It deliberately holds no opinion about what
looks good; don't expect (or impose) a house style.

For design-heavy, animation-heavy, property-heavy, or "make it not AI-looking"
tasks, read `references/native-surface-inventory.md` first, then
`references/design-and-motion.md`. The surface inventory explains which native
PowerPoint carrier can hold each property/effect/animation; design-and-motion
explains style-neutral component choice, motion grammar, sequence choreography,
and copy hygiene. Neither file is a template or house style.

## The authoring contract — just write normal HTML/CSS

Author a slide the way you'd build a 1280×720 web page. The tool renders it in a
real browser and reads each element's **computed box**, so **any CSS layout works**
— flexbox, grid, normal flow, `%`, padding/margin, `gap` — you do **not** need
absolute positioning or px math. Use whatever you'd normally write.

### Structure
- Slide: each top-level `<section>` (sized 1280×720) is one slide, in order.
  (`class="ppt-slide"` is also accepted but not required.) **ids globally unique.**
- Elements are auto-recognized by what they are — **no special classes needed**:
  - Text (`<h1>`–`<h6>`, `<p>`, `<li>`, `<span>`, a `<div>` with text…) → native textbox.
  - A painted box (`<div>`/`<section>` with a background, gradient, or border) → native shape.
  - `<img>` → native picture. `<svg>` primitives → native shapes/lines.
- **Optional precision overrides** (when you want exact control): `class="ppt-shape"
  data-shape="GEOM"` forces a specific PowerPoint geometry (`roundRect ellipse
  rightArrow hexagon star5 callout*` …); `ppt-textbox` / `ppt-line` force a role.

### Layout — any CSS, resolved by the browser
flex / grid / normal flow / `%` / `margin:auto` / `gap` all work — the engine reads
the resulting computed pixel box. (Absolute px positioning also works if you prefer
it.) The only thing that must end up 1280×720 is the slide `<section>`.

### Look — plain CSS, compiled to native
- Fill: `background:#hex`; `linear-gradient(135deg,#a,#b 60%)` (angle + stops
  honored); `radial-gradient(circle,#a,#b)` → native radial fill.
- Shadow: CSS `box-shadow`. Blur: CSS `filter:blur(8px)` → native `<a:blur>`.
- Flip/rotate: CSS `transform:scaleX(-1)/scaleY(-1)/rotate(Ndeg)` → native
  flip/rotation. (Non-unit scale, skew, translate as static layout → loss.)
- Color, font-size, font-weight, text-align, border, opacity, border-radius → native.

### Motion — plain CSS `@keyframes` + `animation`
Write animation as you would on the web; the compiler maps it to native PowerPoint
timing. Supported, read straight from your CSS:
- `opacity` + `transform` `translateX/Y`, `scale`, `rotate` — together (a fade that
  also rises/slides/zooms/turns is one native composite timing group).
- `animation-duration`, `animation-delay`, `animation-timing-function`
  (`ease`/`ease-in`/`ease-out`/`ease-in-out`/`linear`/`cubic-bezier()` → mapped).
- `animation-iteration-count` (`N`/`infinite`) + `animation-direction:alternate`
  → native looping (repeatCount / autoReverse).
- `background-color` keyframes → native fill-color animation.
- **Multiple animations on one element** (CSS `animation:` list) play in sequence —
  `animation: riseIn .5s, pulse .5s 1s, fadeOut .4s 2s` rises in, pulses, then exits.
- **Multi-step `@keyframes`** that move an element (translate at 0/30/60/100%) are
  traced into one native motion path — bounces, wiggles, zig-zags.
- **Composite motion** maps to concurrent native behaviors. A single CSS keyframe
  with opacity + translate + scale + rotate + fill color becomes one `compose`
  effect made of PowerPoint `animEffect`, `animMotion`, `animScale`, `animRot`,
  and `animClr`, not a raster/video fallback.

Example:
```html
<style>
@keyframes in { from{opacity:0; transform:translateY(24px)} to{opacity:1} }
#title { animation: in .5s ease-out both }
</style>
<div class="ppt-textbox" id="title" style="position:absolute;left:96px;top:300px;width:800px;font-size:60px;color:#fff">…</div>
```
No native target (e.g. animating `filter`/`clip-path`, exotic timing) → explicit loss.

### pptx-native concepts CSS has no syntax for (small hooks, not presets)
A few PowerPoint-native capabilities have no CSS equivalent, so they're declared
with a minimal `data-*` attribute:
- **Cross-slide morph:** `data-morph="key"` on the SAME logical object in two
  **adjacent** slides (ids differ, key matches); the receiving slide carries
  `data-ppt-transition="morph; option:byObject; dur:1500"`. A morph object must not
  also carry an entrance/exit, and a morph slide must not carry other animation.
  Keep geometry type + aspect ratio across the pair (circle → bigger circle).
- **Slide transition:** `data-ppt-transition="fade|push|wipe|split|morph"` on a section.
- **Soft glow:** `data-ppt-glow="color:#A78BFA; radius:18; alpha:0.9"` (CSS has no glow).
- **Per-paragraph text reveal:** `data-ppt-build="byParagraph; effect:fade"`.
- **Native composite animation:** `data-ppt-anim="compose; opacity:in; x:-90; y:24;
  scaleFrom:.92; scaleTo:1; rotateFrom:-4; rotateTo:0; dur:650; ease:out"`.
- **Staggered choreography:** put `data-ppt-sequence` on a container to expand
  child native objects into overlapped timing: `data-ppt-sequence="stagger;
  selector:.card; gap:90; overlap:160; y:24; scaleFrom:.96; scaleTo:1; dur:540"`.

(There is also a terse `data-ppt-anim` shorthand for the CSS animations above; it
maps to the exact same native behaviors, so reach for plain CSS unless you want the
shorthand. See `references/animation.md`.)

### Not representable (reported as loss, not silently dropped)
conic-gradient (flattens to a flat color), backdrop-filter, canvas/WebGL,
mix-blend-mode, scrollable overflow as content, hover/scroll triggers. Don't nest
`.ppt-shape`/`.ppt-textbox` inside another `.ppt-shape`.

## Previewing (no PowerPoint needed)
The HTML is a faithful blueprint, so a browser render is a good proxy:
```js
const { chromium } = require("playwright");
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1280,height:720} });
await p.goto("file://" + require("path").resolve("deck.html"));
for (const id of ["s1","s2"]) (await p.$("#"+id)).screenshot({ path:`${id}.png` });
await b.close();
```
`data-shape` geometries (arrows, stars) render as plain rectangles in the browser
but are real preset geometry in the .pptx — mention this when showing a preview.

## Dependencies
`scripts/build.sh` needs Node, Python 3, and Playwright's Chromium (reads computed
styles). One-time: `scripts/setup.sh`. Override binaries via `PPT_NODE_BIN`,
`PPT_NODE_PATH`, `PPT_PYTHON`. `references/capabilities.json` is the machine-readable
source of truth for exactly what compiles.
