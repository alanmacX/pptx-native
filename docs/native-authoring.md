# Native Intent Authoring (scene JSON)

There are two authoring surfaces over one capability model. **Query
`capabilities.json` first** — it is the single source of truth, reflected from the
compiler, and every field below has a `status` (`compiles` vs `declared-gap`).

| surface | for | how |
|---|---|---|
| **HTML / component library** | visual layout, composition, live preview | `web/ppt-components.css` + `data-ppt-*`; see `docs/ppt-html-contract.md` |
| **Native intent (this doc)** | pptx-native objects HTML can't express | write a **scene JSON** and `python -m pptx_native create scene.json` |

The native surface exists because PowerPoint's own vocabulary — themes, native
charts/tables, speaker notes, morph — is richer *for presentation* than HTML. Do
not reverse-engineer these from a DOM; author the intent directly.

## Scene shape

```json
{
  "size": { "cx": 12192000, "cy": 6858000, "pxWidth": 1280, "pxHeight": 720 },
  "title": "Deck title",
  "theme": { ... },
  "slides": [ { "name": "...", "notes": "...", "transition": ..., "animations": ..., "elements": [ ... ] } ]
}
```
Element geometry is in px (`x,y,w,h`); the compiler scales to EMU via `size`.

## Design tokens, not presets

Every visual value is author-supplied. Colors are concrete hex (`"2563EB"`) **or a
theme slot name** (`"accent1"`, `"scheme:accent2"`) — a slot reference emits
`schemeClr`, so one theme swap restyles the whole deck.

### theme  (`native.theme`, compiles)
```json
"theme": {
  "name": "Brand",
  "colors": { "accent1": "#FF5722", "accent2": "#00BCD4", "dk2": "#222", "hlink": "#FF5722" },
  "fonts":  { "majorLatin": "Georgia", "minorLatin": "Helvetica Neue" }
}
```
Slots: `accent1..6, dk2, lt2, hlink, folHlink` (+ `bg1/tx1/bg2/tx2/dk1/lt1` usable in element fills).

## Elements

### shape  (`components.shape`, compiles)
```json
{ "type": "shape", "shape": "hexagon", "x": 80, "y": 80, "w": 200, "h": 160,
  "fill": "accent1", "fillGradient": null, "line": { "fill": "accent2", "width": 3, "dash": "dash" },
  "rotation": 0, "shadow": {...}, "glow": {...} }
```
`shape` = **any** OOXML preset (165 of them — see `components.shape.presets`): rect,
roundRect, ellipse, triangle, hexagon, star5, chevron, cloud, flowChart*, callout*…
Not artificially limited.

### text  (`components.textbox`, compiles)
```json
{ "type": "text", "x": 80, "y": 300, "w": 700, "h": 80, "text": "Hello",
  "fontSize": 32, "color": "111111", "align": "left", "bold": false,
  "runs": [ { "text": "Hello ", "bold": true }, { "text": "world", "color": "accent1" } ] }
```
`runs` overrides `text` for mixed inline styling.

### line / freeform / image / media
`{ "type":"line", "x1","y1","x2","y2", "line":{...}, "arrow":"triangle" }` ·
`{ "type":"freeform", "points":[[x,y]...], "closed":true, "fill":"..." }` ·
`{ "type":"image", "src":"data:image/png;base64,...|file:///...|/local/path", "x","y","w","h" }`

`{ "type":"media", "mediaType":"video|audio", "src":"data:video/mp4;base64,...|file:///...|/local/path", "poster":"file:///poster.jpg?", "x","y","w","h" }`

Target the media object with `{ "effect":"mediaPlay" }`,
`{ "effect":"mediaPause" }`, or `{ "effect":"mediaStop" }` in slide
`animations.effects`.

### table  (`components.table`, compiles)
```json
{ "type": "table", "x": 120, "y": 120, "w": 1040, "h": 360,
  "columns": [360, 340, 340], "fontSize": 18,
  "headerFill": "accent1", "headerColor": "FFFFFF", "rowFill": "F1F5F9", "borderColor": "CBD5E1",
  "rows": [
    ["Quarter", "Revenue", "Growth"],
    ["Q1", "$1.2M", { "text": "+8%", "color": "16A34A", "bold": true, "align": "right" }]
  ] }
```
A real editable table. Cell = string or `{text,fill,color,bold,align,valign,fontSize}`.
Merged cells (colspan/rowspan) not yet supported.

### chart  (`components.chart`, compiles)
```json
{ "type": "chart", "chartType": "bar", "x": 80, "y": 90, "w": 700, "h": 520,
  "title": "Revenue", "legend": true,
  "categories": ["Q1", "Q2", "Q3", "Q4"],
  "series": [ { "name": "Product A", "values": [12,15,14,19], "color": "accent1" } ] }
```
`chartType` ∈ bar/column/barh/line/pie. Ships with an **embedded .xlsx**, so
PowerPoint's *Edit Data* opens the source. Series colors accept theme slots.

## Per-slide

- `"notes": "speaker text\nsecond paragraph"` → presenter notes (`native.notes`, compiles).
- `"transition": "morph" | "fade" | "push" | "wipe" | "split"` (or `{type, durationMs, option}`).
- `"animations": { "framework": "ppt-compatible-v1", "effects": [ {effect, target, start, delayMs, durationMs} ] }`
  — entrance/exit/emphasis/motionPath/build. See `animation.within` in capabilities and `docs/animation.md`.
- Morph: give the same object a stable `source.key`/`morphKey` on adjacent slides, or set `autoMorph` (see `animation.between.morph`).

## Loop

```
write scene.json → python -m pptx_native create scene.json --out deck --force
  → python -m pptx_native validate deck   (must be ok:true; read losses[])
  → python -m pptx_native pack deck --out out.pptx
```
`create` returns `losses[]` for any unsupported intent — fix and re-run; never ship
a silent degrade. Worked examples: `examples/native-theme.json`,
`examples/native-table.json`, `examples/native-chart.json`.

## Patching existing decks

`python -m pptx_native unpack in.pptx --out deck` → edit via a patch JSON →
`python -m pptx_native patch deck ops.json` → `pack`. The patcher rewrites only
the byte spans it targets — parts and XML it does not touch survive
byte-identical (unknown extensions, vendor namespaces, whitespace included).
Every op appends a machine-readable row to `applied[]` (with a `warnings[]`
list); the patch auto-validates unless `--no-validate`.

| op | args | effect |
|---|---|---|
| `setText` | `slide, shapeId\|name, text` | replace all text in the shape (first run keeps formatting) |
| `setTextRun` | `slide, shapeId\|name, paragraph?, run?, path?, text` | replace one `a:t` run |
| `moveShape` / `resizeShape` | `slide, shapeId\|name, x?,y?,cx?,cy?` (EMU) | rewrite `a:off` / `a:ext` |
| `setAttrByPath` | `slide, shapeId\|name, path, attr, value` | set an attribute inside the shape subtree |
| `setSlideAttrByPath` | `slide, path, attr, value` | set an attribute anywhere in the slide part |
| `setTimingAttr` | `slide, path, attr, value` | set an attribute inside `p:timing` |
| `replaceImage` | `slide, shapeId\|name, file` | new media part + rel, swap first `a:blip` (aspect-guarded) |
| `deleteShape` | `slide, shapeId\|name` | remove the shape span; strip its timing effect nodes (`p:par` whose targets are all this shape), `bldP` entries, and the whole `p:timing` if nothing remains |
| `addTextbox` | `slide, x,y,cx,cy` (EMU)`, text, fontSizePt?, bold?, colorHex?, name?` | insert a minimal `p:sp` textbox before `</p:spTree>`; `\n` splits paragraphs; fresh shape id |
| `addImage` | `slide, path\|dataUri, x,y,cx,cy, name?` | write media part (+content-type default), append slide rel, insert `p:pic` |
| `duplicateSlide` | `slide, after?` (default: after itself) | copy slide part + `.rels` verbatim, register in `sldIdLst`/presentation rels/`[Content_Types].xml`; warns on `!!` morph names and shared notes parts |
| `deleteSlide` | `slide` | remove from `sldIdLst` (+custom shows), presentation rels, content types; delete the part, its `.rels`, and dedicated notesSlide; warns on truly-orphaned parts left behind |
| `reorderSlide` | `slide, before` (`before = count+1` → move to end) | permute `p:sldId` entries in `sldIdLst` only |

Slide numbers are **positions in `sldIdLst`** (1-based, re-evaluated per op), not
part filenames. Shape selectors: `shapeId` (`p:cNvPr@id`), `name`, `creationId`,
`kind`. Worked examples: `examples/patch.sample.json`,
`examples/patch.native-control.json`, `examples/patch.structural.json`.
