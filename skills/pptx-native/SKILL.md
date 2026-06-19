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
   and there are no unintended losses.
6. Preview the HTML and, when motion/effects matter, inspect the packed PPTX with
   `python3 -m pptx_native index` or the relevant smoke tool.

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
- When real assets are needed, search/download them with provenance first and
  embed local/data files. Do not hotlink remote media in the final PPTX.
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
node tools/ppt_surface_smoke.cjs --out outputs/native-surface-smoke
skills/pptx-native/scripts/build.sh examples/animation-compose-smoke.html outputs/smoke.pptx
python3 -m pptx_native capabilities > capabilities.json
```
