# Prompt Orchestration

Use this when the user's request is broad, terse, or taste-sensitive. Before
writing HTML, turn the request into an internal implementation brief. Do not ask
the user to review this brief unless required facts are missing; the point is to
make rough prompts compile into deliberate decks.

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

## Implementation Prompt

After the brief, internally restate the build task in direct implementation
language:

```text
Build a native-editable PPTX using pptx-native. Author HTML with explicit
data-ppt-motion-preset and data-ppt-motion-intent per animated slide. Use
ambient/motif/sequence/Morph where the brief calls for them. Compile and iterate
until ok:true, validate ok, no unintended losses, and layout warnings resolved.
```

Then implement. Do not preserve the brief as a deck slide unless the user asks
for methodology/process content.
