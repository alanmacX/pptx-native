# Prompt Orchestration

Use this when the user's request is broad, terse, or taste-sensitive. Before
writing HTML, turn the request into an internal implementation brief, then two
concrete plans — the COPY PLAN (every word that will appear on a slide) and the
MOTION SCORE (every entrance, build, and transition). Do not ask the user to
review these unless required facts are missing; the point is to make rough
prompts compile into deliberate decks.

Order is mandatory when building from scratch:
brief → copy plan → motion score → plan gate → author HTML → compile.
Writing HTML first and patching copy/motion afterwards is how decks end up
with filler text and per-element fade piles.

## Internal Brief

Write a compact brief with these fields:

```text
Audience / language:
Deck job:
Narrative arc:
Slide plan:
- slide: claim, content role, layout motif, native carriers, motion intent,
  ambient layer, visual assets, validation risks
Motion preset:
Appearance system:
Asset strategy:
Validation plan:
```

## Copy Plan (write the actual words before any HTML)

For every slide, write the final on-slide text — not placeholders, not "TBD":

```text
- slide N — title: <verdict-first, ≤20 CJK chars, carries a number or stance>
  blocks: <each on-slide text block, verbatim, within the density budget>
  notes: <the prose/evidence that stays OFF the slide, verbatim or outline>
  visual: <the one number / image / diagram this slide is built around>
```

Check the whole plan at once before moving on: titles read in order must tell
the complete argument (the horizontal test); every block obeys the density
budget below; copy hygiene rules from design-and-motion.md apply here, at
plan time — de-jargon, specifics over abstractions, no banned scaffolds.
Fixing words in the plan costs one line; fixing them after authoring costs a
recompile cycle.

## Motion Score (choreograph before authoring, one line per slide)

```text
- slide N — grammar: <compose | sequence | motif:<name> | ambient | none>
  hero: <the ONE moment this slide is allowed to spend motion on, or "none">
  build order: <reading order of units; what clusters together as one body>
  in-transition: <from previous slide: morph (name persisting objects) |
                  push/wipe/fade | cut>
```

Then read the score column by column, not slide by slide:

- **Transitions row**: mark every adjacent pair where ≥1 object persists —
  those are Morph candidates (name the `data-morph` keys now). A deck-long
  chain of `fade` is a planning failure, and so is Morph everywhere.
- **Hero row**: one hero per slide, and not the same hero move every slide.
  Slides may (should) have "none" — a deck where everything animates reads
  louder than one where the right thing does.
- **Build-order row**: order = reading order. Anything entering together must
  be planned as a cluster here (card + its text = one body), so the HTML gets
  wrappers or motifs instead of loose absolute siblings.

## Narrative Arc

Pick ONE arc for the deck and let it order the slides; a deck without an arc
reads as a folder of slides:

- **状况→冲突→解答 (SCQA)** — briefings, investigations, proposals.
- **结论先行→证据展开 (BLUF)** — executive updates; slide 2 carries the whole
  answer, everything after is support.
- **时间线/历程** — retrospectives, roadmaps.
- **对比→取舍→决定** — option evaluations.
- **问题清单→逐个击破** — audits, reviews.

State the arc in the brief and check the slide plan against it: every slide
must advance the arc or be cut.

## Content Density

- One idea per slide. If a slide's claim needs "and", split it.
- Body text budget: ≤ 45 CJK chars (≈ 90 Latin chars) per text block, ≤ 4
  blocks per slide. A metric card is number + label + one qualifier, nothing
  more. Footnotes: one line, muted.
- A slide that is one strong number, one quote, or one image with a caption is
  GOOD — resist filling the space.
- Speaker-notes carry the full prose; slides carry the skeleton. When the
  source is a dense document, move evidence chains into notes, keep verdicts
  on the slide.

## Table vs Chart vs Diagram

- **Chart** when the POINT is a comparison/trend of numbers (≤ 2 series ≤ 8
  categories on a slide; more belongs in an appendix table). Use the native
  chart carrier when available; else shape-drawn with honest axis labeling.
- **Table** when individual values must be read/looked up (specs, feature
  matrices, 口径). ≤ 5×5 on a slide; larger → split or appendix.
- **Diagram** (shapes + connectors) when the point is STRUCTURE: flows,
  hub-spoke, layers, timelines. Never screenshot a diagram — build it from
  native shapes so it stays editable.
- **Plain claim + big number** beats all three when only one value matters.

## Slide Planning Rules

- Make each slide title a claim, decision, or useful label, not a generic
  section name.
- Assign one information architecture per slide: hierarchy, process, timeline,
  comparison, evidence stack, metric cluster, hub-spoke, map, matrix, gallery,
  or state change.
- Assign one motion grammar per slide:
  - `compose` for one focal object.
  - `data-ppt-sequence` for grouped children.
  - `data-ppt-motif` for semantic structures.
  - Morph for adjacent state change.
  - `data-ppt-ambient` only for low-salience background/environment motion.
- Plan native carriers before styling: textbox, shape, connector/freeform,
  picture, media, table, chart, transition/timing.
- Decide appearance controls in the brief: shape presets, gradients, shadow,
  glow, blur/reflection, line arrows/dashes, text hierarchy, and image/media
  treatment.

## Plan Gate (run before authoring)

Do not start HTML until every line passes:

1. Titles-only read-through tells the whole argument, in order.
2. Every block in the copy plan is inside the density budget (≤4 blocks,
   ≤45 CJK-equivalent chars) — the `AI_TEXT_WALL` lint will enforce this
   later, but catching it in the plan is one edit instead of a re-author.
3. Title placement varies across the deck; no English eyebrows on a CJK deck;
   footnotes only where a source needs citing (`AI_TITLE_LOCKUP_MONOTONY` /
   `AI_EN_EYEBROW` / `AI_FOOTNOTE_FURNITURE`).
4. Each slide has exactly one motion grammar and at most one hero moment.
5. Every Morph candidate pair has its persisting objects named; every cluster
   in the build order maps to a wrapper/motif in the HTML you are about to
   write.
6. Layout silhouettes vary (not the same card grid every slide —
   `AI_CARD_GRID_MONOTONY`), and the deck has its images/diagrams decided
   (`AI_IMAGE_SCARCITY`): concrete topic → 1–2 real sourced images; abstract
   topic → diagrams/type, as a deliberate choice.

## Implementation Prompt

After the plans pass the gate, internally restate the build task in direct
implementation language:

```text
Build a native-editable PPTX using pptx-native. Author HTML with explicit
data-ppt-motion-preset and data-ppt-motion-intent per animated slide. Use
ambient/motif/sequence/Morph where the brief calls for them. Compile and iterate
until ok:true, validate ok, no unintended losses, and layout warnings resolved.
```

Then implement. Do not preserve the brief as a deck slide unless the user asks
for methodology/process content.
