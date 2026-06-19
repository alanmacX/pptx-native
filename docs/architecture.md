# PPTX Native Architecture

The product has two large goals that share one engine.

## Goal A: Absolute Native Control

Agents must be able to discover, address, edit, validate, and preview every
native PowerPoint element without flattening the deck into screenshots.

This track is an exploration and patching system:

```text
pptx package
  -> part graph
  -> object/control graph
  -> property-path inventory
  -> animation/timing graph
  -> safe patch compiler
  -> package and visual validators
```

The key rule is source preservation. The engine can parse XML to understand the
deck, but patch operations should touch the smallest possible source span. This
keeps unknown Office XML, extension lists, animation trees, media metadata,
fallback content, and vendor-specific details intact.

The control surface should eventually cover:

- shapes, groups, connectors, placeholders, pictures, videos, 3D models, charts,
  tables, SmartArt, notes, comments, sections, masters, layouts, themes, and
  web extensions.
- transforms, fills, strokes, shadows, effects, crop, text runs, bullets,
  paragraph styles, fonts, hyperlinks, alt text, locks, and non-visual props.
- transitions, `p:timing`, click sequences, media playback, Morph identity, and
  animation targets.

`index` is the compact scene graph. `explore` is the exhaustive native map.

## Goal B: Frontend-Like Authoring

Agents should be able to build a deck from scratch with an interaction style
similar to frontend work:

```text
user intent
  -> live HTML/PPT-native component preview
  -> structural extraction or shared component scene graph
  -> layout/component plan
  -> native PPTX object compiler
  -> validate
  -> render/preview feedback
  -> iterative patch
```

This should not be HTML-to-image. The output must be editable PowerPoint:
native text boxes, shapes, groups, images, charts, tables, notes, media, and
animations.

The authoring side should use a PPT-native component model that can render to
HTML for preview and compile to OOXML for output:

- `Slide`
- `TextBox`
- `Shape`
- `Picture`
- `Group`
- `Line`
- `Table`
- `Chart`
- `Video`
- `Model3D`
- `MotionPreset`
- `MorphState`

The frontend-like layer handles layout intent, visual hierarchy, spacing,
component composition, and preview feedback. The PPTX-native engine handles
OpenXML generation, relationships, content types, timing, native pack integrity,
and PowerPoint compatibility. Screenshots and image references are allowed only
as QA evidence, never as a compiler fallback.

## Build Order

1. Build `explore` until it can map all native controls and animation targets in
   real decks.
2. Expand patch ops from text/move/resize/image into style, crop, grouping,
   ordering, duplication, notes, and media operations.
3. Add native render feedback so visual regressions become machine-visible.
4. Build a blank-deck compiler from the same object model.
5. Add motion presets and Morph state generation.

Current authoring support has started with an explicit animation IR, a native
`p:timing` writer for entrance fade plus raw motion paths, and Morph transition
generation with stable object identity via `morphKey`/PowerPoint `!!` names. See
`docs/animation.md` for the active contract.

The first track makes edits safe. The second track makes creation feel natural.
