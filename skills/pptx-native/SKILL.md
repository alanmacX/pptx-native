---
name: pptx-native
description: >-
  Compile standard HTML + CSS into a native, fully-editable PowerPoint deck
  (.pptx). Use whenever the user wants to create, build, design, or generate a
  PowerPoint deck, slide presentation, pitch deck, or .pptx — especially when
  they care how it looks or moves: visual polish, gradients, glows, shadows,
  reflections, blur, color themes; any animation or motion (entrance, emphasis,
  exit, cascade, stagger, loop) or slide transitions (morph, push, wipe, fade);
  turning an outline or topic into a deck; or multi-slide decks. Works in any
  language (做PPT / 演示文稿 / 幻灯片, 渐变, 入场动画, morph转场, 好看的PPT, 带动画的幻灯片).
  Prefer over plain python-pptx for design- or animation-heavy work. Do NOT
  trigger for converting, merging, or extracting text from existing decks, or
  non-slide documents (Word, Excel, PDF, Google Slides).
---

# pptx-native

This is a compiler, not a template library: author HTML/CSS or scene JSON, then
compile to editable native PowerPoint objects. No full-slide screenshots as final
slides. Unsupported native gaps must be reported as losses, never silently faked.

## Required Workflow

1. Pick the authoring surface:
   - HTML/CSS for visual layout and browser preview.
   - Scene JSON for native-only objects such as editable tables/charts/theme/notes.
2. Query the native surface before using uncertain properties:
   - `node tools/ppt_surface_audit.cjs --check <carrier> <property>`
   - `node tools/ppt_surface_audit.cjs --carrier picture`
3. Convert the user's request into an internal PPT orchestration brief before
   authoring. For vague prompts, infer a complete brief and keep moving instead
   of asking for review unless content is genuinely missing. Use
   `references/prompt-orchestration.md` for the brief shape.
4. Plan before authoring — when building a deck from scratch this stage is
   mandatory, not optional: write the STYLE SCORE (deck-level visual thesis,
   tokens, image language, effects policy, tonal rhythm, and protected creative
   freedoms), the COPY PLAN (the final words of every title/block/note, checked
   against the density budget and copy hygiene), the VISUAL SCORE
   (communication job, one anchor + one `data-ppt-layout` silhouette per slide,
   optional inspirations, and any deliberately broken heuristic), and the
   MOTION SCORE (per-slide grammar + hero moment + build order, plus the
   cross-slide transition row with Morph pairs named), then run the Plan Gate —
   all in `references/prompt-orchestration.md`. HTML comes after the plans pass,
   never before.
5. Author the deck.
   - Import `assets/ppt-components.css` and use the guided composition registry in
     `references/layout-presets.md`. Presets provide region geometry only; adapt
     them to the content and keep palette/type/assets deck-specific.
   - Declare `data-ppt-layout="<preset|custom>"` on every from-scratch slide and
     `data-ppt-region="<role>"` on preset-governed regions.
   - For animated slides, declare the choreography contract on the slide:
     `data-ppt-motion-preset="elegant"` plus `data-ppt-motion-intent="<intent>"`.
     The normalizer can infer these, but explicit intent makes the output steadier.
6. Compile:
   `skills/pptx-native/scripts/build.sh <input.html> <output.pptx>`
7. Read the JSON report. Iterate until `ok:true`, validation errors are empty,
   and there are no unintended losses. Then read the lint `violations`: resolve
   every `LAYOUT_*` warning too. These flag silent misalignment (content spilling
   out of its card/panel, text running off-slide) that a clean compile does NOT
   catch — do not ship a deck that still has them.
   Read every `AI_*` and `DESIGN_*` finding, but use its reported `kind`:
   `quality` and `contract` findings are blockers; `advisory` findings are
   design-review prompts, not correctness rules. Fix an advisory or keep the
   design with a specific Visual Score rationale. Add
   `data-ppt-design-rationale="<purpose>"` when an intentional exception should
   be machine-reviewable. Never use a rationale to waive clipping, illegibility,
   data/evidence problems, native loss, or broken motion continuity. The full
   three-layer contract is in `references/creative-direction.md`; anti-AI tells
   and fixes live in `references/design-and-motion.md`.
   Run the automated gates directly; do not stop to ask the user for PPTX
   conversion/animation-review permission. If a local PowerPoint visual export is
   unavailable because of app permissions, keep the text gates moving and report
   that visual QA was unavailable.
8. Verify the layout for real — this is mandatory, not optional. When
   re-exporting after a rebuild, `pkill -x "Microsoft PowerPoint"` first —
   an open stale document silently re-exports the OLD deck. `ok:true` and
   `0 losses` validate the COMPILE, not the layout: a deck can compile perfectly
   and still be visibly misaligned. Render the slides and actually look at them
   (`visual_qa.cjs`, or export+rasterize), checking specifically:
   - every overlay (label/number/text/icon) sits INSIDE the card/panel it belongs
     to — nothing pokes out an edge;
   - no text is clipped at the slide edge or overflows its box (PowerPoint wraps
     CJK wider than the browser, so leave width/height headroom);
   - elements that should align (columns, rows, grids) actually line up.
   A frequent cause of "everything is shifted by a constant": content authored in
   a `.ppt-stagger`/`.ppt-group`'s local frame while its overlay siblings were
   authored in the slide frame. Keep a card and its overlays in the SAME
   container, or add the container's offset to the siblings.

## Reference Router

Load only what the task needs:

- HTML contract: `references/ppt-html-contract.md`
- Carrier/property/effect questions: `references/native-surface-inventory.md`
- Motion-heavy work: `references/animation.md`
- Design quality, choreography, and de-AI copy: `references/design-and-motion.md`
- Creative direction, Style Score, inspiration, and hard-vs-soft design rules:
  `references/creative-direction.md`
- Guided composition presets and region geometry: `references/layout-presets.md`
- Vague prompt -> implementation brief: `references/prompt-orchestration.md`
- Asset search, local images, video, audio: `references/asset-search-and-media.md`
- Machine manifest: `references/capabilities.json` (prefer query scripts over
  reading the full JSON into context)

For repo-local native scene JSON details, use `docs/native-authoring.md`.

## Hard Rules

- Choose the native carrier first: textbox, shape, freeform, connector, picture,
  table, chart, or transition/timing.
- If a property is not supported on that carrier, decompose into supported
  sibling objects or implement the writer; do not guess.
- Progressive image effects usually require multiple native pictures plus
  staggered/overlapped timing. Static picture blur is supported; animated blur
  radius/masks are not.
- Source real assets *on demand, in moderation*. Before authoring, judge whether
  the topic is concrete and visual (a place, product, person, artwork, animal,
  food, landmark, real event) — if so, one or a few well-chosen real images lift
  it; if it is data, process, or abstract concepts, native shapes/type read
  better and stock photos only add noise. Let content decide the count instead
  of filling every slide mechanically. The lint treats sparse imagery in a 6+
  slide concrete deck as a review signal, while an explicitly declared
  diagram/data/type-led deck can correctly have zero images. When you do source,
  download with provenance first and embed local/data files — never hotlink. See
  `references/asset-search-and-media.md` for the full when-to-search rubric.
- Use `compose` for one object with concurrent fade/motion/scale/rotation/color.
- Use `data-ppt-sequence` for overlapped child choreography.
- Use `data-ppt-motif` for semantic groups (timeline, layers, comparison,
  metricCluster, hubSpoke) instead of assigning independent fades to each child.
- Use `data-ppt-ambient` for background/environment motion (drift, pan, breathe,
  shimmer, path/orbit, rotate, media playback). It expands to native looping
  primitives and is exempt from elegant-repeat clamping when marked ambient.
- The native vocabulary also includes, all fully editable in PowerPoint's
  Animation Pane: named presets (`entrance:flyin/floatin/zoom/bounce/swivel/
  growturn/split`, named exits, `emphasis:teeter/colorpulse/dim/…`), per-glyph
  text cascades (`byLetter`/`byWord`), object-click triggers
  (`trigger:click(#shape)`), hands-free advance (`advance:N` in transitions),
  native 3D tilt (CSS `perspective()+rotateY`), and native picture crop /
  ken-burns (`object-fit:cover`, overflow crop, morph pairs). See
  `references/ppt-html-contract.md` §4 before inventing a workaround — the
  ceiling is higher than the old subset.
- Use Morph only across adjacent slides; do not mix Morph slides with same-slide
  timing.
- Default animated decks to `data-ppt-motion-preset="elegant"`. Under this
  preset, avoid decorative gallery reveals (`blinds`, `checkerboard`, `wedge`,
  `wheel`, etc.), spinning, and repeated pulses unless they have a concrete
  semantic purpose; the guards will remap or clamp them during unattended builds.
- Pick one motion grammar per slide: hierarchy/flow/timeline/comparison/layers/
  metricCluster/hubSpoke/stateChange/gallery/mediaReveal/ambient. If more than
  three objects move together, use one `data-ppt-sequence` or motif, not a pile of
  per-element `data-ppt-anim` declarations.
- Keep visual style user/content-driven. Guided presets are information
  silhouettes, not a house style: they may supply default region geometry but
  never colors, fonts, copy, decorative shapes, or repeated card layouts.
- Treat visual references as ingredients, not identities. Do not import brand
  copy formulas, fixed palettes, mandatory fonts, required photography, or
  signature layout sequences from an inspiration source. Let the Agent invent,
  combine, or deliberately break design heuristics while preserving objective
  quality gates.

## Useful Commands

```bash
node tools/ppt_surface_audit.cjs --check picture blur
node tools/ppt_asset_search.cjs --query "solar panel closeup" --type image --download --out outputs/assets/solar
node tools/ppt_asset_import.cjs --src ./clip.mp4 --type video --out outputs/assets/clip
node tools/ppt_surface_smoke.cjs --out outputs/native-surface-smoke
node tools/ppt_design_gates.cjs
skills/pptx-native/scripts/build.sh examples/animation-compose-smoke.html outputs/smoke.pptx
python3 -m pptx_native capabilities > capabilities.json
```
