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
  "motionPreset": "elegant",
  "motionIntent": "hierarchy",
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

`motionPreset` and `motionIntent` are orchestration metadata. They do not create
visual style by themselves; they let normalize/lint/guards keep the timing tree
coherent. `elegant` is the default profile for generated decks and clamps
decorative reveal effects, excessive emphasis, long non-motion durations, and
unbounded repeats before writing OOXML.

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

- match objects that persist across adjacent slides by explicit stable identity
  first, then unique text/image signature,
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
  (`p:animScale` with `scale` percent), `pulse` (scale + `autoRev`), and
  `transparency` (aliases `dim`/`opacity`: partial-opacity tween a→b via
  `p:anim style.opacity` + `tavLst`, Animation Pane "Transparency"; DSL
  `emphasis:dim; to:0.35`, optional `from:`).
- HARVESTED NAMED PRESETS (T0: byte-faithful PowerPoint trees from
  `pptx_native/preset_trees.json`; the Animation Pane shows the real named,
  human-editable effect). Entrances: `flyin` (+`from:bottom|left|right|top|…`),
  `floatin`/`floatdown`, `zoom` (object center; `zoomslide` = slide center),
  `bounce`, `swivel`, `growturn`, `split`. Emphasis: `teeter`, `colorpulse`,
  `desaturate`, `darken`, `objectcolor`, `complementary`. Exits: `exit:flyout`,
  `exit:floatout`, `exit:zoom`, `exit:shrinkturn`, `exit:split`, `exit:fade`.
  `dur:` rescales the whole tree proportionally (PowerPoint's own duration
  semantics). Playback-verified via the movie lane (fly-in travels, bounce
  bounces).
- exact easing beyond accel/decel: an animation row may carry `tmFilter`
  ("0,0; 0.25,0.07; …; 1,1") — a piecewise-linear time remap on the effect
  node, the compile target for arbitrary `cubic-bezier()`/`linear()` curves.
- per-letter/word text cascade: `byLetter[:ms]` / `byWord[:ms]` on any
  `data-ppt-anim` declaration emits `p:iterate` on the effect node (Animation
  Pane "Animate text: By letter/word"). Playback-verified via the movie QA
  lane: glyphs genuinely cascade in exported video.
- object-click interactive triggers: `trigger:click(#hotspot)` compiles to a
  native interactive sequence (`nodeType="interactiveSeq"`, sibling of
  mainSeq). Emission uses PowerPoint's exact shape — `nextAc="seek"` +
  `endSync` + `nextCondLst` are all REQUIRED (`nextAc="none"` triggers repair;
  gate-bisected 2026-07-26). Unresolvable trigger targets demote to onClick
  with an ANIM_CLICK_TRIGGER_NOT_FOUND loss.
- motion QA lane: AppleScript `save as save as movie` (async — wait for the
  file to fill) + `swift tools/ppt_movie_frames.swift deck.mov outdir [fps]`
  extracts exact-time frames for playback verification. Click-triggered
  sequences correctly do NOT fire in exported video.
- auto-advance: `advance:N` in `data-ppt-transition` emits `advTm` on the
  slide (hands-free chains; `type:none; advance:N` gives a timer with no
  visual transition). Movie-lane verified: chain cadence is consistent, BUT in
  exported video advTm does NOT wait for running animations — set advance ≥
  the slide's animation end time.
- native 3D: CSS `transform: perspective(p) rotateY(deg)` / `rotateX(deg)` on
  shapes/pictures converts to a native `a:scene3d` camera (normalize extracts
  the euler angles, flattens the CSS so geometry reads the flat box, and
  reports the conversion; sign mapping browser≡PowerPoint verified). Morph
  tweens camera rotation, so two slides with different angles are a native 3D
  card flip — playback-verified via the movie lane.
- native picture crop + ken-burns: `object-fit:cover` and overflow:hidden
  container clipping compile to `a:srcRect` (composable; element geometry
  becomes the visible intersection). Morph TWEENS srcRect (gate-verified), so
  two slides with the same `data-morph` image at different zoom/pan states are
  a native ken-burns — playback-verified via the movie lane. Morph also tweens
  preset-geometry adj values (corner radius) and font size; gradients
  cross-blend smoothly but do not parameter-interpolate.
- browser-sampled motion: CSS animations the normalizer cannot statically map
  are no longer dropped — they are tagged `data-ppt-motion-sampled`, scrubbed
  in-session via the Web Animations API (`tools/motion_sampler.cjs`), and
  lowered onto the row surface above (compose / motionPath / fade / spin /
  pulse / transparency, with fitted ease or exact `tmFilter`). Tracks that
  cannot land are reported in the build report under `stats.sampledMotion`
  — never silently lost.
- `motionPath` when a raw PowerPoint `pptPath`/`path` is supplied.
- `compose` for one concurrent native timing group combining visibility/fade,
  motion path, scale, rotation, and fill-color change. This is the bridge from
  richer HTML keyframes to editable PowerPoint: a single CSS entrance can become
  `p:set` + `p:animEffect` + `p:animMotion` + `p:animScale` + `p:animRot` +
  `p:animClr` children under one timing node.
- media commands: `mediaPlay`, `mediaPause`, and `mediaStop` compile to native
  `p:cmd` timing on embedded video/audio carriers.
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
| media playback | `media:play` or scene `effect:"mediaPlay"` | `p:cmd type="call" cmd="playFrom(0.0)"` |
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

---

Engine verification procedure, animation inventory baselines, and the
compiler roadmap live in `docs/animation-engine-notes.md` (maintainer
material — not needed for authoring).
