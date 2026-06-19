# PowerPoint Native Catalog (Ground Truth)

This is the authoritative inventory of what native PowerPoint (OOXML /
PresentationML + DrawingML) can express. The HTML contract, the
`capabilities.json` manifest, and every compiler target are **projections of this
list**. If something is not here, the compiler must not pretend to support it.

Legend: ✅ implemented in this engine · 🟡 partial · ❌ not yet (gap to fill).

---

## 1. Object Model (component library)

### 1.1 Shapes & graphics
| OOXML | Meaning | Authoring (track B) |
|---|---|---|
| `p:sp` + `a:prstGeom` | preset geometry (187 shapes: rect, roundRect, ellipse, triangle, arc, star, arrows, callouts…) | ✅ rect/roundRect/ellipse/line/polyline |
| `p:sp` + `a:custGeom` | freeform / custom path (bezier `a:path`) | ✅ closed filled freeform from sampled points (`type:"freeform"`); bezier curves 🟡 |
| `p:cxnSp` | connectors (straight/bent/curved, with arrowheads) | ✅ straight + head/tail arrows (triangle/stealth/arrow/diamond/oval); bent/curved ❌ |
| `p:pic` | picture (crop, duotone, artistic effects) | 🟡 real data-image only |
| `p:graphicFrame` → `a:tbl` | table | 🟡 basic |
| `p:graphicFrame` → `c:chart` | chart | ❌ |
| `p:graphicFrame` → `dgm` | SmartArt | ❌ |
| `p:graphicFrame` → OLE | embedded object | ❌ |
| `p:grpSp` | group | 🟡 |
| `p:pic` + `a:videoFile`/`a:audioFile` | media | ❌ |
| `model3D` (office ext) | 3D model | ❌ |

### 1.2 Text (`a:txBody`)
- paragraphs `a:p`, runs `a:r`, line breaks `a:br`, fields `a:fld` (page#, date).
- run props: font, size, bold/italic/underline/strike, color, highlight, spacing,
  super/subscript, hyperlink.
- paragraph props: alignment, indent, line spacing, space before/after, bullets
  (char / numbered / picture), multi-level lists.
- Status: ✅ rich runs; 🟡 bullets/lists; ❌ fields.

### 1.3 Visual style (fill / stroke / effects — common to most objects)
- fill: solid ✅ / gradient (linear ✅, radial/path ❌) / pattern ❌ / picture ❌ / none ✅
- stroke `a:ln`: width ✅, dash 🟡, caps/joins 🟡, gradient stroke ❌, arrows ❌
- effects `a:effectLst`: outer shadow ✅, glow ✅ (`glow:{color,radius,alpha}`),
  inner shadow ❌, soft edge ❌, reflection ❌, 3D bevel/rotation ❌
- theme color refs `a:schemeClr` (follow theme) 🟡

### 1.4 Structure layer (drives editability/reuse)
- `slideMaster` → `slideLayout` → `slide`; placeholders `p:ph` (inherit styles).
- `theme` (color/font/effect scheme), `p:sldSection`, notes, comments.
- Status: ✅ read (track A); 🟡 authoring (placeholders/inheritance ❌).

---

## 2. Animation Catalog

Animations are `(presetClass, presetID, presetSubtype)` triples plus behavior
nodes inside `p:timing`.

### 2.1 Within-slide (`p:timing`)

**Categories**
| Class | `presetClass` | Examples |
|---|---|---|
| Entrance | `entr` | appear, fade, fly-in, float-in, split, wipe, wheel, blinds, checkerboard, circle, diamond, dissolve, wedge, box, plus, random-bars, grow&turn, zoom, swivel, bounce |
| Emphasis | `emph` | pulse, color-pulse, teeter, spin, grow/shrink, desaturate, transparency, fill-color, line-color, font color |
| Exit | `exit` | mirror of entrance (fade out, fly out, shrink&turn…) |
| Motion path | `path` | line, arc, turn, shape, custom bezier |

**Behavior primitives (XML atoms)**
- `p:set` — instant value set (appear). ✅
- `p:animEffect transition="in|out" filter="…"` — filter reveal (fade/wipe/blinds/
  checkerboard/circle/diamond/dissolve/wedge/wheel/box/plus/randombar). 🟡→ expanding
- `p:anim` — generic property tween (by/from/to; ppt_x, ppt_y, style props). 🟡
- `p:animMotion` — path. ✅
- `p:animRot` — rotation (spin). ✅
- `p:animScale` — scale (grow/shrink, pulse). ✅
- `p:cmd` — media play/pause/stop. ❌

**Orchestration**
- `mainSeq` → `seq` → nested `par`/`cTn`.
- triggers: `onClick` (click group) / `withPrevious` / `afterPrevious` / timed `auto`. ✅
- `prevCondLst` / `nextCondLst`: click forward/back conditions. ✅
- **text build `bldP`/`bldLst`**: body reveal by paragraph / level / char. ✅
  per-paragraph (`build="p"`, per-paragraph `spTgt/txEl/pRg`, own `grpId`); by
  level / by char 🟡
- `repeatCount`, `rev`, accel/decel curves. ❌

**animEffect entrance filter map** (structurally identical to existing fade; low risk):
| effect | presetID | filter |
|---|---|---|
| fade | 10 | `fade` |
| blinds | 3 | `blinds(horizontal)` |
| box | 4 | `box(in)` |
| checkerboard | 5 | `checkerboard(across)` |
| circle | 6 | `circle` |
| diamond | 7 | `diamond` |
| dissolve | 9 | `dissolve` |
| plus | 12 | `plus` |
| randomBars | 13 | `randombar(horizontal)` |
| wedge | 18 | `wedge` |
| wheel | 21 | `wheel(4)` |
| wipe | 22 | `wipe(up)` |
| appear | 1 | (uses `p:set`, no filter) |

Exit = same filters with `transition="out"`, `presetClass="exit"`.

### 2.2 Slide-to-slide (transitions + Morph)

**Plain transitions `p:transition`**: cut, fade, push, wipe, split, reveal, cover,
uncover, flash, plus 3D (cube/flip/gallery/honeycomb…, office ext). Attrs:
direction, speed `spd`, precise `p14:dur`, auto-advance `advTm`, sound. ✅ (fade/push/wipe/split)

**Morph (平滑) — the key one**
- namespace `p159:morph` (PowerPoint 2019+), wrapped in `mc:AlternateContent`,
  old readers fall back to fade. ✅
- **`option`**: `byObject` (default, whole-object) / `byWord` / `byChar`. ✅
- **matching**: adjacent slides morph "the same object" by identity:
  - default automatic match (position/shape similarity).
  - **explicit match**: object name prefixed `!!` forces PowerPoint to treat two
    slides' objects as identical even if order/content changed. ✅ (`morphKey`)
- **what morph interpolates**: position, size, rotation, scale, fill color,
  opacity, text (byWord/byChar), even 3D. This is exactly "diff of the same object
  across two slides, auto-tweened" — the natural target for HTML step diffs.
- ✅ automatic `morphKey` inference from adjacent slides via `autoMorph` flag
  (matches by `source.key`/`name`/`id`, assigns shared `auto:<id>` names, sets the
  Morph transition on the later slide).

---

## 3. Gap Map (what to build next)

Priority order (highest ROI first):
1. **Entrance preset table** (animEffect filter family) — ✅ 12 effects.
2. **Per-paragraph text build `bldP`** — ✅ via `effect:"build"` + `buildEffect`.
3. **Exit fade family** — ✅ via `exit-<effect>` (same filters, `transition="out"`).
4. **Emphasis**: spin (`animRot`), grow/shrink (`animScale`), pulse. ✅
5. **Auto morphKey inference** from HTML step diffs. ✅ via `autoMorph` flag.
6. Filled freeform ✅, connector arrowheads ✅, glow ✅. Charts / SmartArt /
   media / bent connectors / soft-edge still ❌.
</content>
</invoke>
