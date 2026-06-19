# Native Surface Inventory

This is the working map for choosing the right native PowerPoint carrier before
writing HTML, scene JSON, or animation. It exists because many failures come from
putting the right property on the wrong object.

Rule: choose the native carrier first, then check the property matrix, then
compose animation. If a property is not listed on that carrier, decompose the
design into supported sibling carriers instead of hoping PowerPoint will infer it.

## Carrier Map

| Need | Native carrier | Authoring surface | Strong properties | Current gaps |
|---|---|---|---|---|
| Plain text | `p:sp` + `a:txBody` | text node / `.ppt-textbox` / scene `type:"text"` | geometry, font, rich runs, color, align, rotation, paragraph build | text shadow/glow, fields, hyperlinks |
| Effect-bearing text box | `p:sp` + `a:prstGeom` + text | `.ppt-shape` with text / scene `type:"shape", text` | fill, stroke, gradient, shadow, glow, blur, reflection, rotation, text | text-specific effects are still shape effects |
| Card, panel, badge, icon shape | `p:sp` + `a:prstGeom` | `.ppt-shape data-shape` / scene `type:"shape"` | full preset geometry set, solid/gradient fill, stroke, dash, shadow, glow, blur, reflection, flip | pattern fill, picture fill, soft edge, 3D |
| Freeform / custom mark | `p:sp` + `a:custGeom` | SVG path/polygon / scene `type:"freeform"` | sampled points, fill, stroke, shadow, glow, blur, reflection | true bezier authoring, edit-point semantics |
| Connector / arrow line | `p:cxnSp` | `.ppt-line` / SVG line/polyline / scene `type:"line"` | endpoints, stroke, dash, arrow end, animation target | bent/curved connector, line effects |
| Photo / raster asset | `p:pic` + `a:blip` | `img` / `.ppt-picture` / scene `type:"image"` | data image, geometry, rotation, shadow, glow, blur, reflection, animation target | crop, transparency, duotone, artistic effects |
| Table | `p:graphicFrame` + `a:tbl` | scene JSON only | editable rows/cells, cell fill/color, borders | merged cells, HTML extraction, table effects |
| Chart | `p:graphicFrame` + `c:chart` + xlsx | scene JSON only | editable workbook, bar/column/barh/line/pie, series color | combo/scatter/area, detailed axes, HTML extraction |
| Group | `p:grpSp` | declared gap | none yet | group writer, group effects, group animation |
| Slide transition | `p:transition` | `data-ppt-transition` / scene `transition` | fade, push, wipe, split, Morph | larger transition gallery, sound/advance controls |
| Timing tree | `p:timing` | `data-ppt-anim`, `data-ppt-sequence`, scene `animations` | set, filter reveal, motion, scale, rotation, color, paragraph build | named motion presets, media commands, arbitrary property tweens |

## Property Matrix

| Property | Compiles on | Do not put on | Notes |
|---|---|---|---|
| solid fill | shape, freeform, table cell | picture, connector, chart | Use theme slots or hex. |
| linear/radial gradient | shape, freeform | table cell, picture, connector, chart | Conic is a loss. |
| stroke/dash | shape, freeform, connector | picture, chart | Connector is best for real arrows. |
| text/rich runs | textbox, shape text, table cell | chart labels | Text effects require shape-text carrier today. |
| shadow | shape, freeform, picture | bare textbox, connector, table, chart | For text shadow, put text inside a shape carrier. |
| glow | shape, freeform, picture | bare textbox, connector, table, chart | Use a thin shape for glowing scan lines. |
| blur | shape, freeform, picture | bare textbox, connector, table, chart | Static native blur only; animated blur must be decomposed. |
| reflection | shape, freeform, picture | bare textbox, connector, table, chart | Native `a:reflection`. |
| crop | none yet | picture | Pre-crop externally or split into multiple pictures. |
| transparency/opacity | shape fill/text color | picture | Picture alpha is not a writer surface yet. |
| animation target | textbox, shape, freeform, connector, picture, table, chart | group | Any emitted native object with a shape id can be targeted. |
| paragraph build | textbox | shape text, table cell | Uses `bldP` + `spTgt/txEl/pRg`. |

## Animation Atoms

| Native atom | Current authoring | Good for | Notes |
|---|---|---|---|
| `p:set` | `appear`, compose visibility | instant visible/hidden state | Used with compose entrances. |
| `p:animEffect` | fade/wipe/blinds/box/checkerboard/circle/diamond/dissolve/plus/randombars/wedge/wheel | native filter reveal in/out | Not a CSS filter engine. |
| `p:animMotion` | `motionPath`, compose `x/y/path` | linear or eased movement | Use relative paths for component moves. |
| `p:animScale` | grow/shrink/pulse, compose scale | scale and settle | Pair with fade/motion for premium entrances. |
| `p:animRot` | spin, compose rotation | rotation | Works in compose with motion/scale. |
| `p:animClr` | recolor, compose recolor | fill-color change | Shape fill only. |
| `p:bldP` | `data-ppt-build` | paragraph reveal | Textbox only today. |
| `p:cmd` / media | gap | play/pause/stop | Needed when media writer lands. |

## Selection Rules

Use these before authoring:

1. If the user asks for a native editable visual, never start with a screenshot.
2. If the visual is geometric, use `shape`, `freeform`, or `connector`.
3. If the visual is photographic, use `picture`; if only part of it changes,
   split it into multiple pictures.
4. If an effect must progress across a region, PowerPoint usually cannot animate
   the effect parameter itself. Decompose the region into native slices and
   stagger/overlap their entrances.
5. If text needs a box effect, author it as a shape with text rather than a bare
   textbox.
6. If an animation should feel continuous, use one primary `compose` or a
   `data-ppt-sequence` with overlap; avoid serial one-by-one queues.
7. If an object must move across slides, prefer Morph with a stable `morphKey`;
   if it moves within a slide, use timing.
8. When a desired property is not in the matrix, either pre-compose only that
   asset region or add a writer gap. Do not silently drop it.

## Validation

Run the carrier smoke whenever this matrix or a writer branch changes:

```bash
node tools/ppt_surface_smoke.cjs --out outputs/native-surface-smoke
```

The smoke creates a native PPTX that exercises textbox, shape, freeform, picture,
connector, table, chart, effects, timing, and Morph, then unpacks the PPTX and
checks for the expected OOXML nodes.

## Blur-Scan Lesson

The photo demo exposed the exact carrier issue this file is meant to prevent:

- A single `p:pic` can carry static `a:blur`.
- PowerPoint does not give us a native "animate blur radius over a moving mask"
  primitive.
- The correct native construction is: sharp base picture + multiple blurred
  picture slices + a glowing shape scan line + overlapped native timing.
- Therefore the model must choose `picture` slices as carriers, not try to put an
  animated filter on one picture.

That is the standard repair pattern for progressive image effects: split the
changing region into native objects, then choreograph them.

## Gap Queue

High-value gaps that would reduce future carrier guesswork:

1. Picture crop (`a:srcRect`) so we can use one source image and native crop
   windows instead of pre-cropped assets.
2. Picture transparency and recolor/artistic effects.
3. Connector effects and bent/curved connectors.
4. Group writer (`p:grpSp`) and group-level timing.
5. Hyperlinks/actions (`a:hlinkClick`).
6. Table merged cells.
7. Named motion-path presets.
8. Media writer plus `p:cmd` timing.
