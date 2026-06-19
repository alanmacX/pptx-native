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
3. Author the deck.
4. Compile:
   `skills/pptx-native/scripts/build.sh <input.html> <output.pptx>`
5. Read the JSON report. Iterate until `ok:true`, validation errors are empty,
   and there are no unintended losses. Then read the lint `violations`: resolve
   every `LAYOUT_*` warning too. These flag silent misalignment (content spilling
   out of its card/panel, text running off-slide) that a clean compile does NOT
   catch — do not ship a deck that still has them.
6. Verify the layout for real — this is mandatory, not optional. `ok:true` and
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
  better and stock photos only add noise. Let content decide the count, never a
  per-slide quota; a deck can correctly have zero images. When you do source,
  download with provenance first and embed local/data files — never hotlink. See
  `references/asset-search-and-media.md` for the full when-to-search rubric.
- Use `compose` for one object with concurrent fade/motion/scale/rotation/color.
- Use `data-ppt-sequence` for overlapped child choreography.
- Use Morph only across adjacent slides; do not mix Morph slides with same-slide
  timing.
- Keep visual style user/content-driven. Do not introduce templates, house style,
  meaningless English subtitles, or rigid repeated card layouts.

## Useful Commands

```bash
node tools/ppt_surface_audit.cjs --check picture blur
node tools/ppt_asset_search.cjs --query "solar panel closeup" --type image --download --out outputs/assets/solar
node tools/ppt_asset_import.cjs --src ./clip.mp4 --type video --out outputs/assets/clip
node tools/ppt_surface_smoke.cjs --out outputs/native-surface-smoke
skills/pptx-native/scripts/build.sh examples/animation-compose-smoke.html outputs/smoke.pptx
python3 -m pptx_native capabilities > capabilities.json
```
