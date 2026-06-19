# PPTX Native

This repo starts a small PPTX-as-code engine for native PowerPoint files. It treats a `.pptx` as an OpenXML package, then gives agents a safer workflow:

```text
create/unpack -> index/explore -> structured patch -> validate -> pack
```

The roadmap has two linked goals:

- absolute native control over existing decks, including all controls,
  properties, relationships, transitions, and animation timing.
- frontend-like authoring from scratch, where agents discuss layout and motion
  naturally while the engine compiles to editable native PPTX.

For agents (including no-vision LLMs), the contract surface is:

- `capabilities.json` — the **single source of truth**, reflected from the compiler
  so it cannot drift. Every component/effect/animation/native feature has a
  `status`: `compiles` (passes validate + PowerPoint-open) or `declared-gap`
  (PowerPoint supports it, writer not landed → explicit loss, never silent degrade).
  Query it *first*. Regenerate with `python -m pptx_native capabilities --out capabilities.json`.
- [docs/native-authoring.md](docs/native-authoring.md) — the **native-intent scene
  JSON** surface: theme tokens (one-click restyle), the full 165-preset shape set,
  native editable tables and data-driven charts (with embedded workbook), speaker
  notes. These are pptx-native objects HTML can't express — author them directly.
- [docs/ppt-html-contract.md](docs/ppt-html-contract.md) — the PPT-native HTML
  component library (design tokens, not presets) and `data-ppt-*` animation DSL,
  for visual layout with live preview.
- [docs/ppt-native-catalog.md](docs/ppt-native-catalog.md) — full OOXML ground truth.
- [docs/ppt-native-survey.md](docs/ppt-native-survey.md) — PowerPoint's real native
  library vs current coverage.

Two authoring surfaces, one capability model and compiler: write HTML for visual
layout, or native-intent scene JSON for pptx-native objects. Neither reverse-
engineers a DOM — both map declared intent to native OOXML, with explicit losses.

The current MVP is intentionally narrow:

- `unpack`: extract a `.pptx` into a package directory.
- `create`: compile an editable JSON scene spec into a native PPTX package
  directory.
- `index`: build an agent-readable scene graph with slides, shapes, text, boxes, relationships, media, transitions, and timing targets.
- `explore`: build an exhaustive native control/property map for agent discovery.
- `validate`: check required parts, relationship targets, content types, XML relationship refs, and animation timing `spid` targets.
- `patch`: apply source-preserving structured operations such as `setText`,
  `setTextRun`, `moveShape`, `resizeShape`/`setBounds`, `setAttrByPath`,
  `setSlideAttrByPath`, `setTimingAttr`, and `replaceImage`.
- `pack`: zip the package directory back into a native `.pptx`.

Patch operations are source-preserving where practical: the engine parses XML to
identify objects and validate the package, but writes only the specific text,
transform, blip relationship, or relationship entry touched by the operation.
Unknown XML and untouched namespace declarations are left in place.

Run it with Python:

```bash
python -m pptx_native unpack "Project 2.pptx" --out outputs/dev/deck --force
python -m pptx_native create examples/create.sample.json --out outputs/dev/new-deck --force
python -m pptx_native index outputs/dev/deck --out outputs/dev/deck.index.json
python -m pptx_native explore outputs/dev/deck --out outputs/dev/deck.explore.json
python -m pptx_native validate outputs/dev/deck
python -m pptx_native patch outputs/dev/deck patch.json
python -m pptx_native pack outputs/dev/deck --out outputs/dev/edited.pptx
```

Example patch:

```json
[
  { "op": "setText", "slide": 1, "shapeId": 2, "text": "What is Native PPTX-as-Code?" },
  { "op": "moveShape", "slide": 9, "shapeId": 23, "x": 0, "y": 0 },
  { "op": "resizeShape", "slide": 9, "shapeId": 23, "cx": 12192000, "cy": 6858000 }
]
```

Path-based native-control patch:

```json
[
  {
    "op": "setAttrByPath",
    "slide": 1,
    "shapeId": 5,
    "path": "sp/txBody[1]/p[1]/r[1]/rPr[1]",
    "attr": "sz",
    "value": "3200"
  },
  {
    "op": "setTimingAttr",
    "slide": 9,
    "path": "timing/tnLst[1]/par[1]/cTn[1]",
    "attr": "restart",
    "value": "never"
  }
]
```

Use `explore` to discover valid control and timing paths before patching.

The engine does not try to rebuild PowerPoint files from scratch. Unknown XML is kept unless a patch touches that specific part.

For frontend-derived decks, use `tools/html2scene.cjs` to extract a browser
render into an auditable IR and author scene before compiling with `create`.
This path uses DOM/CSS/SVG structure, not image references. Screenshots are
optional QA evidence only; the PPTX output must be native editable objects where
the compiler has coverage. See [docs/html2pptx.md](docs/html2pptx.md).

See [docs/architecture.md](docs/architecture.md) for the two-track build plan.
