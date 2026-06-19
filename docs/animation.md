# Native Animation IR

PowerPoint animation support should be structural from the first hop:

```text
HTML / component state
  -> animation intent IR
  -> target resolution against native shape ids
  -> p:timing writer
  -> validate/index/PowerPoint-open smoke
```

Screenshots and visual comparison can diagnose whether the animation feels
right, but they are not compiler input.

## Scene Format

Each slide can declare native animation effects:

```json
{
  "name": "example",
  "elements": [
    {
      "type": "text",
      "name": "title",
      "text": "Hello",
      "source": { "key": "#title" }
    }
  ],
  "animations": [
    {
      "target": "#title",
      "effect": "fade",
      "trigger": "onClick",
      "delayMs": 0,
      "durationMs": 450
    }
  ]
}
```

Target lookup supports `shapeId`, `spid`, `target`, `targetKey`, `sourceKey`,
`name`, and `id`. For HTML-derived scenes, the stable path is usually
`source.key`. If one DOM node emits multiple native shapes, a source-key target
currently expands to all of those shapes.

For slide-to-slide Morph, give related objects the same `morphKey` on adjacent
slides. PowerPoint Morph compares only the immediately previous slide, so a
slide 9 closing morph cannot pull a source object directly from slide 1; place a
same-key seed object on slide 8, or carry the object through intermediate
slides.

```json
{
  "type": "shape",
  "morphKey": "hero-card",
  "x": 120,
  "y": 160,
  "w": 300,
  "h": 180
}
```

The author compiler turns that into a native PowerPoint object name prefixed
with `!!`, which is PowerPoint's explicit Morph matching convention. The name is
not visible on the slide, but it lets PowerPoint know these are the same object
across slides even if ordering changes.

### Automatic Morph inference

For HTML step flows, you usually do not want to hand-assign `morphKey`. Set
`autoMorph: true` at the scene level (or `autoMorph: true` on an individual
slide), and the compiler will:

- match objects that persist across adjacent slides by stable identity
  (`source.key` first, then `name`/`id`),
- give each matched pair a shared `morphKey` of the form `auto:<identity>`, and
- set a Morph transition on the later slide when at least one object matches and
  the slide has no explicit transition.

Explicit `morphKey`/`transition` values are never overwritten, and scenes
without the flag are left untouched. This is the bridge from "same DOM node moved
between two HTML steps" to a native PowerPoint smooth transition.

## Supported Writer Surface

The author compiler now emits native `p:timing` for:

- `fade`, `fade-in`, `entrance-fade`, and `opacity` as PowerPoint entrance fade.
- the entrance `animEffect` filter family: `fade`, `blinds`, `box`,
  `checkerboard`, `circle`, `diamond`, `dissolve`, `plus`, `randomBars`, `wedge`,
  `wheel`, `wipe` (each with its native `presetID`/filter, see
  `docs/ppt-native-catalog.md`).
- `appear` as a native instant `p:set` entrance (presetID 1).
- exit reveals via `exit-<effect>` / `fade-out` (same filters, `transition="out"`,
  `presetClass="exit"`).
- `build` for per-paragraph text reveal: emits one entrance node per paragraph
  (targeted via `spTgt/txEl/pRg`) plus a native `<p:bldP build="p">` build entry
  with its own `grpId`. The per-paragraph reveal effect defaults to `fade` and is
  overridable with `buildEffect` (any supported entrance filter).
- emphasis effects: `spin` (`p:animRot`, `spins`/`byDeg`), `grow`/`shrink`
  (`p:animScale` with `scale` percent), and `pulse` (scale + `autoRev`).
- `motionPath` when a raw PowerPoint `pptPath`/`path` is supplied.
- `compose` for one concurrent native timing group combining visibility/fade,
  motion path, scale, rotation, and fill-color change. This is the bridge from
  richer HTML keyframes to editable PowerPoint: a single CSS entrance can become
  `p:set` + `p:animEffect` + `p:animMotion` + `p:animScale` + `p:animRot` +
  `p:animClr` children under one timing node.
- `data-ppt-sequence` for style-neutral choreography: one container declaration
  expands child native objects into a staggered/overlapped set of effects with
  deterministic delays.

Note: an empty `<p:bldLst/>` is schema-invalid, so the writer omits it on slides
whose animations are emphasis/motion only (no entrance/build).

It also emits native Morph slide transitions:

```json
{
  "transition": {
    "type": "morph",
    "option": "byObject",
    "durationMs": 1200,
    "speed": "slow"
  }
}
```

Morph compiles to `mc:AlternateContent`: a `p159:morph` choice for modern
PowerPoint and a fade fallback for older readers. Supported Morph options are
`byObject`, `byWord`, and `byChar`.

Trigger handling is grouped into PowerPoint click sequences:

- `onClick` starts a new click group.
- `withPrevious`, `afterPrevious`, and `auto` join the current group with their
  own delay.

If the first item in a group is `onClick`, that group waits for a click and the
first node is emitted as `clickEffect`. If the first item is `withPrevious`,
`afterPrevious`, or `auto`, the group starts when the slide opens and all nodes
are emitted as `withEffect`.

## PPT-Compatible HTML Animation Contract

HTML can preview richer motion than PowerPoint can store natively, so the
authoring subset needs explicit intent. The compiler should only promise
animations that can land in OOXML timing or Morph:

- `fade` / `appear` for opacity-only reveals.
- `motionPath` for objects moving along a known PowerPoint path.
- `morph` for slide-to-slide object continuity.
- `segmentReveal` for line/path draw effects, compiled as many native line
  segments with staggered `appear` timing.
- `sequence` / `stagger` for groups whose children enter at deterministic
  delays.

Free-form JavaScript animation is allowed in the HTML preview, but it must be
reduced to one of those intents before PPTX authoring. The preferred future
surface is declarative metadata such as `data-ppt-anim`, plus component-level
helpers like `PptLineDraw`, `PptStaggerGroup`, and `PptMorphObject`.

## CSS Keyframes To PPT Timing

The preferred authoring surface is still `data-ppt-anim`. As a repair/export
bridge, `tools/ppt_html_normalize.cjs` can now convert simple CSS keyframes into
the same declarative DSL before lint/extract:

| CSS keyframes | normalized intent | native PPT writer |
|---|---|---|
| `opacity:0 -> 1` | `entrance:fade` | `p:animEffect filter="fade"` |
| `opacity:1 -> 0` | `exit:fade` | exit `p:animEffect` |
| `transform:rotate(a) -> rotate(b)` | `emphasis:spin; byDeg:b-a` | `p:animRot` |
| `transform:scale(a) -> scale(b)` | `emphasis:grow/shrink; scale:b*100` | `p:animScale` |
| `scale(1) -> scale(n) -> scale(1)` | `emphasis:pulse; scale:n*100` | `p:animScale autoRev` |
| `opacity + translate + scale + rotate + fill` | `compose; opacity:in; x; y; scaleFrom; scaleTo; rotateFrom; rotateTo; recolor` | concurrent native behavior children |
| container cascade | `data-ppt-sequence="stagger; selector:.card; gap:90; overlap:160; ..."` | multiple target effects with calculated delays |

The normalizer only converts effects it can prove from the keyframe endpoints.
Unsupported CSS animation/transition is neutralized and reported as a
correction, so the compiler never silently promises browser-only motion.
Translation, complex multi-property keyframes, physics/easing curves, hover,
scroll, infinite loops, blur/filter animation, and 3D perspective remain outside
the native subset unless a component reduces them to `motionPath`, Morph, or a
sequence of native effects.

The current concrete pipeline rule recognizes the eldercare slide-2 SVG chart:
`#axis-line`, `#curve-glow`, and `#curve` are sampled into native line segments,
then given staggered `appear` timing; `#ax*`, `#kp*`, and `#ac*` components fade
in at the same milestones as the HTML `drawCurve()` routine.

## Verification

The writer must pass three layers before being trusted:

```bash
python3 -m compileall -q pptx_native tools
python3 -m pptx_native validate outputs/animation-smoke/deck
python3 -m pptx_native index outputs/animation-smoke/deck --out outputs/animation-smoke/index.json
```

For Office compatibility, the smoke deck was also opened by Microsoft
PowerPoint through AppleScript and closed without repair.

The Morph smoke deck is:

```text
outputs/morph-smoke/morph-smoke.pptx
```

It validates cleanly, opens in PowerPoint, and indexes slide 2 as a Morph
transition with `option="byObject"`.

## Native Animation Inventory

`index` and `explore` now expose transition variants and all timing nodes. The
compact index includes:

- transition `kind`, `variants`, and Morph options.
- slides with timing, transitions, and Morph.
- timing target shapes.
- timing tag counts.
- action/effect records for `set`, `animEffect`, `animMotion`, `anim`,
  `animRot`, `animScale`, `cmd`, `audio`, and `video`.
- nearest `cTn` preset metadata for each action/effect record.

The current real-deck inventory baseline is:

```text
outputs/animation-inventory/summary.json
```

On `outputs/mvp-clean/deck`, it finds Morph transitions, entrance presets,
motion paths, emphasis rotation, generic animation nodes, and media playback
commands.

## Next Compiler Targets

- Convert frontend step diffs into native Morph-friendly object identity or
  explicit `p:timing`, depending on whether the interaction is slide-to-slide or
  within-slide.
- Add CSS/keyframe translation for simple `translate(...)` into native
  `motionPath`, with clear loss reporting when the browser path cannot be
  reduced to a PowerPoint relative path.
- Add native writers for fly-in and richer line/path draw variants.
- Preserve/edit existing timing trees through patch operations without
  normalizing away unknown Office XML.
