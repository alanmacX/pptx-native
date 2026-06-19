# HTML to Native PPTX

`html2pptx` treats a frontend page as an executable structural design spec, not
as a screenshot source and not as an image reference.

```text
HTML/CSS/JS running in Playwright
  -> browser-derived IR with DOM, CSS, SVG, layout boxes, and animation structure
  -> author scene JSON
  -> native PPTX package directory
  -> validate/index/PowerPoint-open
```

Screenshots may be emitted for human QA, but they are never compiler input. The
compiler must not rasterize the HTML, trace screenshots, or use image references
to hide unsupported native coverage.

Visual comparison is an agent-side QA loop, not a compiler dependency:

```text
HTML QA screenshot + real PowerPoint render
  -> visual mismatch/contact report
  -> agent identifies missing structural semantics
  -> deterministic DOM/CSS/SVG/OOXML compiler rule
```

In other words, visual capability is used to inspect and prioritize pipeline
fixes. The pipeline itself should remain structural and reproducible.

The important product rule is that every loss must be explicit. If an element is
not compiled into native PPTX yet, it should remain in the IR and be counted in
the report. Silent degradation is a bug.

## Structural Alignment Contract

The core assumption is that both sides are structured:

- HTML preview has a DOM tree, CSS computed styles, layout boxes, SVG nodes, and
  JavaScript state transitions.
- PPTX has an OOXML package graph, slide parts, shape trees, text runs,
  relationships, media parts, and timing trees.

The generator should therefore align structures, not pixels:

```text
HTML component / DOM node / CSS property
  -> extracted structural IR
  -> PPT-native object and property path
  -> OOXML patch or author operation
  -> PowerPoint validation and preview
```

For new decks, the agent can write high-quality HTML for live preview, but the
HTML should be constrained to a PPT-native component subset. Every component
should have a known native target such as `TextBox`, `Shape`, `Group`, `Table`,
`Chart`, `Picture`, `Connector`, `Freeform`, `MotionPreset`, or `MorphState`.

## Current Extractor

Run:

```bash
NODE_PATH="/Users/macalan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules" \
"/Users/macalan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
  tools/html2scene.cjs input.html \
  --steps 0-21 \
  --out work/html-derived.scene.json \
  --ir work/html-derived.ir.json \
  --report work/html-derived.report.json \
  --screenshots preview/html
```

By default the extractor writes a `noImageReference` contract into both IR and
scene JSON. `--screenshots` only creates QA artifacts.

The extractor currently captures:

- slide states by calling `window.goToStep(step)` when available.
- finite CSS animations/transitions at their settled structural state by default.
- infinite animations paused at a stable sample point by default.
- visible DOM boxes in browser coordinates.
- parent-chain opacity/visibility, so hidden state panels do not leak visible
  child SVG/text into the PPTX scene.
- SVG thin-line visibility using stroke width, so horizontal/vertical SVG
  `<line>` elements with zero browser bbox height/width are not dropped.
- SVG `url(#gradient)` paint references as representative native solid colors
  when a true gradient stroke writer is not available yet.
- nearest CSS clipping ancestor metadata for overflow-hidden rounded/circular
  containers.
- ancestor id/class source metadata, so a visible child can still be targeted as
  part of an HTML component such as `#kp1`, `#ax0`, or `#ac1`.
- direct text nodes via DOM Range bounding boxes and browser line boxes.
- CSS color, opacity, border, radius, font, weight, alignment, and transitions.
- CSS `box-shadow` as a native shadow candidate with PowerPoint-calibrated
  alpha/distance attenuation.
- CSS gradient backgrounds as native fill candidates.
- CSS `background-clip:text` as text paint instead of shape background paint.
- active slide background gradients as bottom native shapes.
- browser stacking-context paths for PPT shape-tree ordering.
- rich text lines by merging adjacent visual text runs.
- mixed inline text blocks as single text-flow boxes with native runs, so direct
  text and inline emphasis do not become overlapping independent text boxes.
- real `data:image/*` slide-content assets as native image candidates.
- unsupported SVG primitives, external raster references, CSS-only effects, and
  keyframes into the IR.
- optional per-step screenshots for human visual comparison only.
- declarative `data-ppt-*` animation DSL on DOM nodes, parsed into native scene
  animations (see `docs/ppt-html-contract.md`):
  - `data-ppt-anim="entrance:wipe; trigger:afterPrev; dur:450"` → entrance / exit
    (`exit:`) / emphasis (`emphasis:` + `spins`/`scale`) / `motion:`+`path:` /
    `appear` intents.
  - `data-ppt-build="byParagraph; trigger:onClick; effect:fade"` → native `bldP`
    per-paragraph text build.
  - `data-ppt-glow="color:#A78BFA; radius:18; alpha:0.8"` → native glow on the
    matching element.

The author compiler currently emits native:

- editable text boxes, including mixed-style rich text runs.
- editable basic shapes: rectangles, rounded rectangles, ellipses, lines, and
  polylines.
- rounded-rectangle radius adjustment from CSS/SVG radius instead of PowerPoint
  defaults.
- native gradient fills for supported shape backgrounds.
- native outer shadows for supported CSS `box-shadow` cases.
- active slide gradient/background rectangles.
- native picture/media parts for real data-image slide content.
- native SVG primitive coverage for rect, circle, line, polyline, polygon, sampled
  path, star-like filled paths, and SVG text.
- sampled SVG line/path draw candidates as independently targetable native line
  segments.
- solid fills and strokes with alpha.
- slide transitions.
- `p:timing` animation trees when the scene supplies explicit animation IR,
  including automatic slide-start groups for `withPrevious` / `auto`.
- a first concrete PPT-compatible HTML animation rule for the eldercare chart:
  `#axis-line`, `#curve-glow`, and `#curve` compile to staggered native segment
  reveal effects, while chart milestones fade at their HTML timing thresholds.
- Morph-friendly `morphKey` object identities for HTML-derived elements.
- Morph transitions for non-initial HTML step slides, with fade fallback.

## Known Gaps

These are not acceptable final losses; they are the next compiler targets:

- arbitrary SVG markers, filters, masks, and complex clipping beyond the current
  primitive/path-sampling coverage.
- filled arbitrary SVG paths/polygons are now compiled to native closed
  freeforms (`custGeom`) from sampled points (`type:"freeform"`). True bezier
  curve fidelity (vs. polyline sampling) and open filled subpaths remain partial.
- external/local raster asset embedding only when the asset is real slide
  content, never as an HTML screenshot fallback.
- CSS transforms beyond settled bounding boxes, pseudo-elements, filters, and
  backdrop blur.
- automatic same-slide PowerPoint animation timing from general CSS keyframes.
- richer step-diff classification that chooses between Morph, explicit timing,
  or no animation.
- semantic visual diff classification, not only aggregate pixel mismatch.

## Baseline Example

The eldercare HTML baseline is generated under:

```text
outputs/manual-20260604-html2pptx-animated-curvefix/presentations/eldercare-animated-curvefix/
```

The final deck path is:

```text
outputs/manual-20260604-html2pptx-animated-curvefix/presentations/eldercare-animated-curvefix/output/ai-eldercare-animated-curvefix-native.pptx
```

The current baseline validates cleanly, opens/renders through PowerPoint as 22
slides, and gives slide 2 a native same-slide timing tree for the curve chart.
Its report still counts unsupported SVG freeform fills and general CSS
keyframes, so it remains a compiler baseline rather than a finished
product-quality renderer.
