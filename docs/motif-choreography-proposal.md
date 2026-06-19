# Motif Choreography (`data-ppt-motif`)

Status: **landed.** `timeline`, `layers`, `comparison`, and `metricCluster` are
implemented. `hubSpoke` remains spec-only (needs connector-draw semantics).

Decisions taken (were the open questions):
1. **Roles** — support both explicit `data-ppt-role` and inference.
2. **timeline pairing** — order strictly by axis center; a card sits just left
   of its node so the pair reads as arriving together. No special pairing pass.
3. **Unknown motif** — reported, not silent: `motifsFor` records it in the
   slide's `unsupported`, and `ppt_html_lint.cjs` emits a `MOTIF_UNKNOWN`
   warning (visible in the build report).
4. **Gallery** — `examples/motif-timeline-smoke.html` + `examples/motif-gallery-smoke.html`.

## Problem

Today every animation is hand-authored per element (`data-ppt-anim`) or per
container (`data-ppt-sequence`). There is **no semantic layer** that knows "this
group of objects *is* a timeline / a layer stack / a comparison" and therefore
how it *should* move. Consequences seen in real decks:

- A timeline's nodes each `fade` independently instead of resolving along the
  axis after the spine draws.
- Adjacent-slide objects that should glide (Morph) get a hard `entrance` instead.
- Authors over-specify: every card needs its own `compose` string, and small
  inconsistencies (mixed triggers, motion fighting the layout axis) read as
  "random" motion.

This is **not** a request for a template/style library. Motifs carry *no* visual
style — they only map an information structure to a choreography built from the
**existing** native primitives.

## Design in one sentence

Declare *what a group is* on its container; the compiler looks up a
**choreography function** that expands it into the same animation rows
`data-ppt-sequence` already produces — reusing `compose`, staggered timing, and
(later) Morph. **Zero new OOXML writers.**

```html
<div data-ppt-motif="timeline; axis:x; from:left">
  <div class="ppt-line"  data-ppt-role="spine" ...></div>
  <div class="ppt-shape" data-ppt-role="node"  ...></div>
  <div class="ppt-shape" data-ppt-role="card"  ...></div>
  ...
</div>
```

## Where it plugs in (the seam)

It mirrors `data-ppt-sequence` exactly, at three points in `tools/html2scene.cjs`:

| Stage | `data-ppt-sequence` | `data-ppt-motif` (new) |
|---|---|---|
| In-browser collect | `sequencesFor(active)` → `slide.sequences` | `motifsFor(active)` → `slide.motifs` |
| Node expand | `declaredPptSequences(slide, elements)` | `declaredPptMotifs(slide, elements)` |
| Merge | `slideAnimationsFor()` spreads it in | same array, spread alongside |

Both emit the identical row shape consumed downstream:

```js
{ ...intent, target: <sourceKey>, trigger: "afterPrev"|"withPrevious", delayMs }
```

So everything after the merge (dedupe, OOXML timing writer, the preview runtime)
is untouched.

## Data structures

### 1. Browser-collected motif record (`slide.motifs[]`)

```js
{
  name: "timeline",                 // first bare token of the attribute
  raw:  "timeline; axis:x; from:left",
  params: { axis:"x", from:"left", dur:520, gap:140, overlap:120, ... },
  spine: { key, cx, cy, w, h } | null,   // the axis/connector, if any
  items: [ { key, role, cx, cy, w, h }, ... ]  // ordered later, by axis
}
```

`key` is `animationTargetKeyFor(el)` — the same source key sequences use, so
`animationTargetExists()` validates motif rows for free.

### 2. The registry (node side)

```js
const MOTIF_REGISTRY = {
  timeline:   timelineMotif,     // implemented
  layers:     layersMotif,       // spec only
  comparison: comparisonMotif,   // spec only
  hubSpoke:   hubSpokeMotif,     // spec only
  metricCluster: metricClusterMotif, // spec only
};

function declaredPptMotifs(slide, elements) {
  const rows = [];
  for (const motif of slide.motifs || []) {
    const fn = MOTIF_REGISTRY[motif.name];
    if (!fn) continue;            // unknown motif -> (future) reported loss
    rows.push(...fn(motif, elements));
  }
  return rows.filter(r => r.target && animationTargetExists(elements, r.target));
}
```

A choreography function is pure: `(motifRecord, elements) -> rows[]`. It only
calls existing helpers (`pptAnimToIntent`, `numberOr`, `firstDefined`,
`normalizePptTrigger`). That is the whole contract — adding a motif = adding one
function + one table entry + one gallery example.

## Role resolution

Children are classified by, in order:

1. explicit `data-ppt-role="spine|node|card|item|left|right|center"`;
2. inference fallback — a `.ppt-line`/`<svg>`/very-thin-wide shape becomes the
   `spine`; everything else is an `item`.

Explicit roles are recommended in the gallery examples; inference keeps casual
decks working.

## The `timeline` motif (full spec — implemented)

Params: `axis` (`x`|`y`, default `x`), `from` (`left`/`right` or `top`/`bottom`),
`dur` (per-item ms, 520), `gap` (stagger ms, 140), `overlap` (spine→items ms,
120), `delay` (lead-in ms, 0), `trigger` (first trigger, `afterPrev`).

Choreography (the whole group is **one** click step):

1. **Spine** (if present): `entrance:wipe`, direction from `from`, `dur≈max(dur,640)`,
   `trigger = <first trigger>`, `delay = baseDelay`. The axis draws first.
2. **Items**: sorted along the axis by center (`cx` for `axis:x`); reversed for
   `from:right`/`bottom`. Each gets a `compose` entrance — `opacity:in`,
   a small drift *along* the axis toward its resting spot (`x:-24`/`+24` or
   `y:±24`), `scaleFrom:.96 → scaleTo:1`, `dur`. `trigger = withPrevious`,
   `delayMs = baseDelay + spineLead + i*gap`, where
   `spineLead = spine ? max(dur,640) - overlap : 0`.

Net effect: the line wipes in left→right, then nodes/cards resolve in reading
order, each drifting the last few pixels into place and settling — continuous
velocity instead of N independent fades.

### Worked example

Input:

```html
<div data-ppt-motif="timeline; axis:x; from:left; dur:520; gap:150; overlap:140">
  <div class="ppt-line"  data-ppt-role="spine" id="spine" ...></div>
  <div class="ppt-shape" data-ppt-role="node"  id="n1" style="left:200px" ...></div>
  <div class="ppt-shape" data-ppt-role="card"  id="c1" style="left:160px" ...></div>
  <div class="ppt-shape" data-ppt-role="node"  id="n2" style="left:600px" ...></div>
  <div class="ppt-shape" data-ppt-role="card"  id="c2" style="left:560px" ...></div>
</div>
```

Emitted rows (conceptually):

```
spine  entrance:wipe(left)            afterPrev     delay 0      dur 640
c1     compose opacity+x:-24+scale    withPrevious  delay 500   (640-140)
n1     compose opacity+x:-24+scale    withPrevious  delay 650
c2     compose ...                    withPrevious  delay 800
n2     compose ...                    withPrevious  delay 950
```

(ordering by `cx` interleaves node/card by position; pairing node+card at the
same x into a sub-group is a possible refinement — see open questions.)

## Motif table (rollout candidates)

| Motif | Structure | Choreography | Status |
|---|---|---|---|
| `timeline` | axis line + nodes + cards | spine wipes, items resolve along axis | **implemented** |
| `layers` | stacked bands | top→bottom tight cascade (70ms), slight `y` settle | **implemented** |
| `comparison` | left vs right columns | symmetric entrance from both edges, paired by row, center divider last | **implemented** |
| `metricCluster` | KPI tiles | soft rise (`y:18→0`) in reading order, gentle overlap | **implemented** |
| `hubSpoke` | center + satellites + connectors | center grows first, spokes draw outward, satellites pop | spec |

## Params per motif

- `timeline`: `axis` (`x`/`y`), `from`, `dur` (520), `gap` (140), `overlap` (120), `delay`, `trigger`.
- `layers`: `dur` (460), `gap` (70), `delay`, `trigger`.
- `comparison`: `dur` (520), `gap` (120), `delay`, `trigger`; roles `left`/`right`/`center`.
- `metricCluster`: `dur` (520), `gap` (90), `delay`, `trigger`.

## Companion: auto-Morph (separate, smaller follow-up)

Orthogonal to motifs and aimed at "should glide but jumps": default `autoMorph`
on across adjacent slides, matching by `source.key` / identical text, so a
carried title/card glides instead of re-entering. Independent change; do after
`timeline` lands.

## Next

- `hubSpoke`: needs a connector-draw step (spokes as `.ppt-line` wiping outward
  from the hub) before satellites pop — the only motif requiring per-role
  effect *types* rather than one shared compose. Add when needed.
- Auto-Morph follow-up (above) for adjacent-slide gliding.
