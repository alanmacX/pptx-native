# Web Motion Parity — Design

Status: proposed (accepted pending owner review) · 2026-07-26
Provenance: 9-agent design study — 3 research tracks (web vocabulary, OOXML
`p:timing` deep-dive, Morph/media/escape-hatch facts, all source-cited), 3
independent architecture proposals (sampling compiler / morph-chain engine /
native-vocabulary ladder), 3 judging lenses (fidelity, PowerPoint-reality,
implementability). All three judges independently converged on the same hybrid;
this document is that synthesis.

## 1. Problem and contract

The skill's authoring surface is real HTML/CSS because that is where the model's
design ability lives. But the animation pipeline only compiles what it can
statically prove from keyframe endpoints; everything else — multi-waypoint
keyframes, real easing curves, springs, translate paths, blur, clip-path,
per-char text, WAAPI/framer-motion output — is neutralized. The web ability and
the PPT output fight each other, and animation is where the fight is lost.

The contract this design targets: **no discount** (不打任何折扣). Every motion
the author expresses in the browser must land in the deck at full visual
fidelity, or descend an explicit, reported ladder whose every rung is a real
landing zone — reporting a loss is a last resort, never a substitute for
landing. Corollaries, in priority order:

1. Fidelity is measured against desktop PowerPoint playback (2019+/365).
2. Editability is the product's core value: prefer output a human can read and
   edit in the Animation Pane.
3. Silent loss is a contract violation — structurally impossible, not
   policy-discouraged.
4. No templates, no fencing: the ceiling is the native vocabulary itself.

## 2. What the research changed

The capability atlas (source-cited: MS-OE376/MS-OI29500, ECMA-376 §19.5,
LibreOffice oox import mapping, ONLYOFFICE sdkjs, Microsoft Morph docs, MVP
literature) invalidated the assumption that PPT's animation model is small.
Most of the "impossible" web vocabulary is an *emission gap*, not a format
ceiling:

**Native mechanisms the writer has never used**

- `p:anim` generic tween — attrName vocabulary includes `ppt_x/y/w/h`, `r`,
  `style.opacity`, `style.fontSize`, `imageData.crop*`, 3D rotations,
  `drawProgress`. One attrName per behavior; sibling behaviors compose.
- `p:tavLst` keyframe value lists (`tm` = 0–100000 % of duration) with
  `calcmode` lin/discrete/**fmla** — a full formula grammar (`+ - * / % ^`,
  20 functions incl. `sin/cos/exp`, `$` = progress, `#attr` = base value).
  Springs are natively expressible: `#ppt_y + exp(-4*$)*sin(6*pi*$)*0.05`.
  PowerPoint's own presets materialize as these trees (ISO's Fly In example:
  tav strVal `1+#ppt_h/2` → `#ppt_y`).
- `tmFilter` — piecewise-linear time remap on ANY `cTn`
  (`"0,0; 0.25,0.07; …; 1,1"`). The cheapest exact bridge for arbitrary
  `cubic-bezier()`/`linear()` easing: sample 8–16 pairs, done.
- `accel/decel` are per-`cTn`, so per-behavior easing variation is legal
  (each compose child owns its cTn).
- `p:iterate` on any `cTn` (`type=el|lt|wd`, `tmAbs`/`tmPct`) — per-letter /
  per-word cascades are one element away; this is the Animation Pane's
  "Animate text: By letter".
- Interactive sequences: a sibling `p:seq` with `nodeType="interactiveSeq"` +
  `stCondLst/cond@evt="onClick"` + `tgtEl/spTgt@spid` — object-click triggers
  (tabs, hotspots) are pure OOXML.
- `animEffect` supports **39** filter(subtype) variants (slide/barn/strips/
  stretch families missing from our 12).
- The full entrance/emphasis/exit/path presetID tables are now pinned
  (entrance 1–58; presetID == VBA MsoAnimEffect only for 1–24; ribbon
  Float In=42, Zoom=53, Swivel=45, Grow&Turn=31, Bounce=26). presetID triples
  are *labels*; playback comes from materialized behavior children — emit
  PowerPoint-identical trees + correct triple and the pane shows named,
  editable effects.
- Structural contract (MS-OE376): `tnLst` has exactly ONE child (tmRoot);
  behavior nodes live at depth 5 (tmRoot→seq→clickPar→withGroup→effect-par→
  behaviors). Our writer already conforms; keep it.

**Morph is a second interpolator, wider than `p:timing`**

Verified interpolation coverage: position/size/rotation/flip, color and
formatting, shadow/bevel, text font/size/color (byWord/byChar), **image crop**
and pan/zoom, edit-point geometry (same point count, same winding, ≤1 hole),
**3D rotation**. Charts never morph (cross-fade). Matching: auto-match needs a
shared object across exactly two adjacent slides; `!!name` forces a 1:1
same-class match. Hands-free chains (Morph + Advance After) are a documented
professional pattern; the After-timer starts when the slide's last animation
finishes. Known trap: source-side objects carrying entrance animations can
silently break matching — entrances belong on the slide *before* the morph.
Interior keyframe slides cannot be hidden (hidden slides are skipped in the
show and printed by default) — packaging must use sections, slide naming, and
a `custShow` for print/handout exclusion.

**Escape-hatch reality**

- Transparent video is dead on Windows slideshow (alpha MOV/WebM render black).
  Do not build on it.
- Animated GIF is the community-standard transparent-motion carrier (256
  colors, 1-bit alpha — bands on gradients; acceptable for small organic
  loops only). Loop count is baked in the file.
- Native flipbook (N shapes, staggered appear/disappear) is XML-cheap
  (~1–5 KB/frame for shapes); UI timing granularity is 10 ms; editor UX
  degrades with many animations per slide — hard-cap frames.

**Player matrix**

Desktop PowerPoint 2019+/365 is the fidelity target. PowerPoint for the web
preserves and *plays* desktop-authored effects (editing is subset-limited).
WPS is explicitly OUT OF SCOPE (owner decision 2026-07-26) — no WPS gates, no
WPS-driven degradations. Keynote import is best-effort, outside the contract.

## 3. Architecture (the hybrid)

**Spine = ladder compiler. Measurement = browser sampling. Morph chain = one
rung, not the architecture.**

```
normalize (DOM hygiene only; stops neutralizing animation CSS)
  → lint
  → html2scene
      ├─ geometry/style extraction (unchanged)
      ├─ MOTION SAMPLER (new, in the existing Playwright session)
      └─ choreography producers (motifs/sequence/ambient — unchanged semantics)
  → Motion IR (one IR, two producers, one consumer)
  → SCHEDULER (pure constraint solver → absolute delays)
  → LOWERING LADDER (T0…T6, recorded rejections)
  → author.py emitters (harvested preset trees + behavior compilers)
  → validate (+ disposition-completeness + timing-tree assertions)
  → pack
  → MOTION QA (structural resimulation every build; video lane nightly/opt-in)
```

### 3.1 Measurement: browser as ground truth

In html2scene's existing Chromium session (`settleAnimations` already calls
`document.getAnimations({subtree:true})` — this extends, not introduces, the
dependency):

- Enumerate CSS animations, CSS transitions, and WAAPI (framer-motion) per
  slide; `effect.getComputedTiming()` resolves `calc(var())` delays;
  `effect.getKeyframes()` yields *resolved* keyframe values.
- `pause()` all, then scrub `Animation.currentTime` — sampling is a pure
  function of local time: deterministic, no wall clock.
- Prefer analytic knots (getKeyframes + parsed `cubic-bezier`/`linear()`/
  `steps()`) and sample only to verify / to capture what parsing can't
  (transform matrices → DOMMatrix decomposition into tx/ty/sx/sy/rot).
- Infinite loops: sample exactly one period; `loop={period, direction,
  count:"infinite"}` is a first-class IR attribute (the infinite-clamp bug
  dies by construction).
- Stagger dedup: identical (keyframes-hash, duration, easing) animations are
  sampled once and re-anchored per element — O(1) in cascade size.
- Double-pass determinism audit: two scrub passes must agree, else the track
  is flagged `NONDETERMINISTIC_MOTION` (rAF/JS-driven motion is detected and
  reported, never silently mis-sampled).
- Channel list includes `stroke-dashoffset`/`drawProgress` (SVG line draw is
  Tier-1 vocabulary).

The static keyframe mapper in normalize (`cssAnimationIntentAt`) is demoted to
a `--legacy-static-map` rollback flag. Normalize keeps DOM hygiene and assigns
stable `data-ppt-motion-id` join keys.

### 3.2 Motion IR (MIR)

Per slide, produced by both the sampler and the choreography layer, consumed by
everything downstream:

```jsonc
{
  "version": 1,
  "slideIndex": 3,
  "tracks": [{
    "id": "t17",
    "target": "kpi-card-2",              // animationTargetKey join
    "class": "entrance|exit|emphasis|ambient|interactive|media|build",
    "producer": "sampled|declared|motif", // provenance
    "channels": [                          // raw keyframes, never pre-collapsed
      { "ch": "opacity", "keys": [{ "t": 0, "v": 0 }, { "t": 1, "v": 1 }] },
      { "ch": "ty", "unit": "px",
        "keys": [{ "t": 0, "v": 18 }, { "t": 0.7, "v": -2 }, { "t": 1, "v": 0 }],
        "easing": { "kind": "bezier", "pts": [0.16, 1, 0.3, 1] } }
    ],
    "loop": null,                          // or {periodMs, direction, count}
    "textRange": null,                     // or {para} | {iterate: "lt|wd", intervalMs}
    "schedule": { "after": "t16", "edge": "end", "offsetMs": -140 },
    "annotations": { "purpose": "content|ambient|flourish",
                     "motif": { "name": "metricCluster", "role": "node", "i": 2 },
                     "morphKey": null },
    "disposition": null                    // filled by the lowerer — REQUIRED
  }]
}
```

Precedence rule: **sampled truth wins**. The DSL/motif layer contributes tracks
only where no CSS motion exists, and annotations (purpose, motif role,
morphKey, ordering hints) never override sampled values. This keeps one
lowering path and kills dual-path drift; the motif/ambient/sequence layer keeps
its exact semantics and defaults (460–640 ms, stagger 60–140, overlap 120–160,
ease-out) as a *producer* of the same IR, with relative schedule constraints
instead of precomputed absolute delays.

### 3.3 Scheduler

A pure function over MIR: solves the constraint graph (`after`/`with`/click
edges + offsets) into absolute `(groupIndex, trigger, delayMs)`. All
`afterPrevious` semantics are resolved HERE to absolute delays; the
`author.py` sibling-delay-0 emission branch is deleted (the bug dies by
construction). Cycles are lint errors, not heuristics.

### 3.4 The lowering ladder

Every track descends in order; the first rung that lands wins; every rejection
is recorded on the track's disposition trail.

| Tier | Mechanism | Fidelity | Editability | Notes |
|---|---|---|---|---|
| T0 | Named preset (harvested materialized tree + correct `(class,id,subtype)` triple) | 1.0 | 1.0 | Pane shows the real named effect |
| T1 | Composed behaviors (compose cTn: set/animEffect/animMotion/animScale/animRot/animClr; per-behavior accel/decel; tmFilter easing; iterate; interactiveSeq) | ~1.0 | 0.8 | Timing/order still editable |
| T2 | `tavLst` keyframes / `fmla` (multi-waypoint, exact springs, partial opacity, ppt_w/h, crop*) | 1.0 | 0.6 | Plays everywhere modern; shows as custom effect |
| T3 | Morph chain (auto-advancing keyframe slides; crop, adj values, gradients†, 3D camera, font-size, layout-with-labels) | keyframe-exact | 0.5 | Packaging: sections + naming + custShow print exclusion; entrances live on pre-chain slide |
| T4 | Native flipbook (≤20 frames, shapes preferred) | sampled | 0.3 | Hard-capped; grouped + named |
| T5 | Embedded media (GIF for small transparent organic loops; video full-bleed only; no alpha video on Windows) | visual only | 0.1 | Opt-in |
| T6 | Reported loss | — | — | Only after T0–T5 rejections are on record |

† gated on empirical smoke tests (§6).

The tier chooser runs an **edit-first cost profile** by default (prefer higher
editability at equal fidelity), and the chosen tier is ALWAYS reported per
track in the build report (`motionReport`: tier, fidelity score, editability
score, rejection trail). "No silent discount" is a validate rule: every track
must carry exactly one disposition or the build fails.

### 3.5 Editability: harvested preset trees

`tools/harvest_preset_trees.py` (new): author a corpus deck in desktop
PowerPoint (one effect per shape, all subtypes), unzip, snapshot each effect
`par` node into `pptx_native/preset_trees.json` keyed by
`(presetClass, presetID, presetSubtype)`, cross-checked against the
LibreOffice/ONLYOFFICE tables. Discipline: **never guess a tree** — T0 is only
available for presets with a harvested template; otherwise the rule lowers to
T1 with a report. This is simultaneously the best fidelity, editability, and
compat strategy: we emit exactly what PowerPoint itself would write.

### 3.6 Channel parity map (Tier-1/2 web vocabulary → landing)

| Web channel / pattern | Landing |
|---|---|
| opacity fade in/out | T0 Fade (entr/exit 10) |
| partial opacity dim (1→0.35) | T0 Transparency (emph 9, `p:anim style.opacity`) |
| rise-and-settle entrance (translate+fade±scale) | T0 Float In/Rise Up when it fits; else T1 compose + tmFilter |
| fly from off-slide | T0 Fly In (entr 2, tav formula `1+#ppt_h/2`) |
| scale/zoom entrance | T0 Zoom (entr 53; subtype 16/272/528) |
| multi-waypoint translate | T1 animMotion polyline/bezier pptPath (relative slide fractions, leading-zero rule, strict arity) |
| arbitrary cubic-bezier / `linear()` easing | tmFilter 8–16 pairs on the effect cTn |
| spring / overshoot | T0 Bounce (entr 26) for playful; T1 two-node travel+settle; T2 fmla `exp·sin` for exact |
| stagger / overlap cascades | scheduler-solved absolute delays (existing motif semantics) |
| per-char / per-word text (typewriter, wave) | T0 `p:iterate type=lt|wd` + tmAbs |
| SVG line draw (`stroke-dashoffset`) | T1 segmentReveal (existing sampler) / `drawProgress` when verified |
| bar/progress grow from zero | T1 wipe(direction) idiom — single editable shape |
| width/height tween (non-zero base) | T2 `ppt_w/ppt_h` tav; with sibling reflow → T3 morph chain |
| clip-path circle()/inset() reveals | T1 circle/box/wipe/split/barn filters; freeform masks → decomposition or T3 |
| color/fill/stroke/font color | T1 animClr (fill/stroke/text targets) |
| infinite ambient loops | repeatCount="indefinite" (+autoRev), ambient class, never clamped |
| ken-burns / crop pan-zoom | T3 morph chain (srcRect states); gate-fail → T2 `imageData.crop*` tav |
| gradient angle/stop animation | T3 gated; gate-fail → duplicate-crossfade decomposition |
| 3D card flip | T3 (sp3d camera states); gate-fail → scaleX collapse illusion (reported approximation) |
| border-radius / shape adj tween | T3 gated (adj values) |
| blur/shadow/glow radius animation | duplicate-crossfade decomposition (N static states, staggered fades) or T4; static blur stays supported |
| count-up numbers | stepped states (T3/T4, 3–5 states) or reported — true ceiling |
| hover states | click idiom (interactiveSeq); `onMouseOver` is schema-legal but unproven — excluded from contract until smoked |
| object-click state machines | T1 interactiveSeq + cond tgtEl |
| scroll-driven | idiom translation (click steps / morph progression / ambient) — adaptation by definition |

### 3.7 Guards become policy over provenance

The elegant guard moves into the lowerer as a *reported policy pass* that reads
track provenance: `purpose:flourish` (dial/clock/loader spins) and
`class:ambient` are exempt by construction; every clamp emits a correction
row. The guard can no longer destroy what the normalizer allowed — the
escape-hatch bug class dies at the architecture level.

### 3.8 Motion QA loop

Layout QA exists (visual_qa); motion QA is new, two lanes:

1. **Structural resimulation (every build, no Office needed)**: a timing-tree
   interpreter (`timing_sim`) reconstructs per-element (time → x/y/scale/rot/
   opacity) from the emitted OOXML and asserts against the sampler's IR
   (bounded error per channel). Calibrated once per mechanism against lane 2.
2. **Ground-truth video (nightly / opt-in)**: PowerPoint Mac AppleScript MP4
   export → frame extraction → per-element track compare vs browser-recorded
   frames. Flaky/licensed, so never the gate for regular builds.

### 3.9 Capability negotiation for the authoring model

The ladder's channel→tier map is reflected INTO `capabilities.json` and
`ppt_surface_audit` so the authoring model can query, at author time, what a
channel costs ("blur animation → T4/decomposition") and design with the grain.
This closes the loop with the skill's orchestration-brief step — the model
chooses vocabulary knowing the landing zones, instead of discovering
discounts at build time.

## 4. Migration plan

Status 2026-07-26: **M0 complete** (all six items, verified by rebuild+render);
**M1 core complete** (sampler + fitting + afterPrev absolute-delay resolution +
sampledMotion disposition ledger; full MIR/constraint-solver re-rooting of the
motif layer still pending); **M2 gates 1–3 passed on desktop PowerPoint Mac**:
(1) tmFilter + p:anim style.opacity + tavLst fmla accepted; (2) p:iterate
accepted AND playback-verified (glyphs cascade in exported video); (3)
interactiveSeq accepted — bisected: `nextAc="seek"` + `endSync` + `nextCondLst`
are all required, `nextAc="none"` triggers repair. Shipped rungs:
`transparency` emphasis, `tmFilter` exact easing, `byLetter/byWord` iterate,
`trigger:click(#target)` interactive sequences. **Motion QA video lane is
live**: AppleScript movie export (async) + `tools/ppt_movie_frames.swift`
frame extraction; verified iterate cascades play and click-gated effects
correctly hold. Open: Morph property gates (now runnable via the movie lane),
full MIR re-rooting, preset-tree harvest, web-player matrix.

- **M0 — bug debt + ledger schema (week one, all user-visible)**:
  four presetID constants (`author.py:1701-1714`: diamond 7→8, plus 12→13,
  randombars 13→14, wedge 18→20); gradient alpha-stops emit `a:alpha` + loss
  record (never `noFill`); resolve afterPrev/withPrev to absolute delays in
  html2scene and delete the author.py afterPrevious branch; purpose-aware
  guard exemptions + mandatory correction rows; `iteration-count:infinite` →
  ambient. Land the disposition-ledger schema over the EXISTING pipeline.
- **M1 — sampler + MIR**: motion_sampler.cjs in the existing session;
  motifs/sequence/ambient re-target to MIR producers; scheduler lands;
  legacy static mapper behind `--legacy-static-map`.
- **M2 — empirical gates + preset harvest**: smoke corpus (§6) on desktop
  Win/Mac and PowerPoint web; harvest preset_trees.json; set compat flags.
- **M3 — ladder T0–T2**: recognizers, tmFilter easing, tavLst/fmla emitters,
  iterate, interactiveSeq, extended 39-filter table, `p:anim` targets
  (opacity/w/h/crop), duplicate-crossfade decomposition.
- **M4 — T3 morph chain**: state splitter, exact-DOM-identity morphKey
  stamping (`mc:<chain>:<key>`), advTm + sections + custShow + slide-naming
  writer furniture, morph/timing mixing lint rules.
- **M5 — QA + negotiation**: timing_sim assertions in validate; video lane;
  capabilities.json tier map + surface_audit answers.

Each milestone ships user-visible value; nothing waits for the whole design.

## 5. Residual true ceilings (honest list)

- Live text reflow during a within-slide tween (no layout engine in playback);
  Morph restructuring across slides is the nearest expression.
- Text-content tweening (count-up odometers) — stepped states only.
- Live backdrop-filter over moving content — static bake is the ceiling.
- mix-blend-mode arithmetic between animated layers.
- Continuous scroll-scrubbing (no scrubber input in a slideshow).
- JS/rAF/canvas/WebGL motion — detected, reported, opt-in video only.
- Uninterruptible playback (a click always skips) — kiosk-grade motion
  integrity cannot be guaranteed in presenter hands.

## 6. Empirical smoke-test gates (run in M2, before any dependent rung ships)

1. Hand-built `tavLst`/`fmla`/`tmFilter`/`calcmode` trees accepted + played by
   desktop Win/Mac; survive PowerPoint-web playback.
2. `p:iterate` on hand-built (presetID 0) trees vs recognized presets.
3. `p:anim` targets: `style.opacity` partial dim, `ppt_w/h`, `imageData.crop*`.
4. `interactiveSeq` click triggers; `onMouseOver` (expected: fail → keep
   excluded).
5. Morph property gates — **RESULTS (2026-07-26, movie-lane frame analysis on
   desktop PowerPoint Mac; test decks outputs/morph-gates.pptx +
   morph-crop2.pptx, frames in outputs/morph-gates-frames/)**:
   - position/size/solid color: TWEENS (control).
   - gradient angle+stops (90°→270°): smooth CROSS-BLEND, not parameter
     interpolation (no 180° pass-through mid-flight). Visually smooth and
     usable; keyframe-exact gradient animation still needs decomposition.
   - preset-geometry adj values (roundRect radius 6→90px): **TWEENS** —
     previously undocumented anywhere; the T3 adj rung is OPEN.
   - font size (28→72px): **TWEENS** (crisp intermediate sizes, no ghosting).
   - picture crop `srcRect` (full→top-left quadrant): **TWEENS** — the native
     ken-burns path is OPEN. Writer gap: author.py never emits srcRect yet.
   - sp3d camera rotation (perspectiveFront lon 0°→50°, hand-injected):
     **TWEENS** — real 3D swivel with consistent lighting; the T3 3D-flip rung
     is OPEN. Writer support SHIPPED: CSS perspective/rotateX/rotateY →
     scene3d camera (euler extraction from the matrix, flattened geometry,
     sign mapping browser≡PowerPoint verified via movie lane).
   Still open: group-children matching; whether source-side entrance
   animations break matching (and which kinds).
6. advTm hands-free chains — **RESULTS (movie lane)**: 3-hop morph chain plays
   at a consistent cadence (advTm + morph duration per hop, ±100ms at frame
   granularity). CAVEAT: in the movie-EXPORT lane, advTm does NOT wait for a
   still-running main sequence (a 2s animation was cut at the 800ms timer) —
   contrary to documented live-slideshow behavior. The T3 splitter must set
   advTm ≥ the slide's animation end time itself (as designed). Live-slideshow
   wait behavior remains unverified (needs screen capture).
6. `advTm` vs still-running main sequence; ms precision drift across a
   10-slide chain; kiosk mode; Presenter View behavior on keyframe chains.
7. Flipbook scheduling precision: 24-step 10ms-class stagger drift, measured
   by high-fps capture.
8. Animation Pane behavior on the four corrected presetIDs (before/after).

## 7. Errata discovered during the study (fix in M0)

- `author.py:1701-1714`: four wrong presetIDs (above).
- `docs/ppt-native-catalog.md`: four wrong presetIDs in §2.1 filter map; stale
  flags (p:anim marked 🟡 but never emitted; "repeatCount/accel/decel ❌" but
  writer emits decel + indefinite repeats; "afterPrevious ✅" overstated);
  omits `p:animClr`; lists 12 of 39 animEffect filters; stray `</content>`
  `</invoke>` trailing lines (corruption).
