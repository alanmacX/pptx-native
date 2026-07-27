# Prompt Orchestration

Use this when the user's request is broad, terse, or taste-sensitive. Before
writing HTML, turn the request into an internal implementation brief, then three
concrete plans plus one deck-level design contract — the STYLE SCORE (the
coherent visual system and the freedoms it protects), the COPY PLAN (every word
that will appear on a slide), the VISUAL SCORE (why each composition looks the
way it does), and the MOTION SCORE (every entrance, build, and transition). Do
not ask the user to
review these unless required facts are missing; the point is to make rough
prompts compile into deliberate decks.

Order is mandatory when building from scratch:
brief → style score → copy plan → visual score → motion score → plan gate →
author HTML → compile.
Writing HTML first and patching copy/motion afterwards is how decks end up
with filler text and per-element fade piles.

## Internal Brief

Write a compact brief with these fields:

```text
Audience / language:
Deck job:
Communication job: By the end, <audience> should <outcome> because <takeaway>.
Narrative arc:
Slide plan:
- slide: claim, content role, layout silhouette, native carriers, motion intent,
  ambient layer, visual assets, validation risks
Motion preset:
Appearance system:
Visual thesis:
Asset strategy:
Validation plan:
```

## Style Score (cohere the deck without choosing its style for it)

Read `creative-direction.md`, then write one deck-level system:

```text
Style Score
- creative direction: <a specific visual thesis, not a brand imitation>
- surface mode: <light | dark | mixed | custom>
- palette roles: <canvas / surface / text / muted / accent / evidence>
- typography: <display stack / text stack / numeric stack / language behavior>
- scale and spacing rhythm: <how hierarchy and breathing room work>
- image language: <studio | documentary | abstract | diagrammatic | collage | none>
- effects policy: <when radius / shadow / gradient / texture have meaning>
- tonal sequence: <where light/dark/density changes support the narrative>
- references used: <visual principles or references, if any>
- freedoms protected: <choices intentionally left open for slide-level invention>
```

The Style Score creates coherence, not a theme preset. Define recurring values
as deck-local tokens, but do not copy a reference brand's fixed palette, fonts,
corner radii, shadows, page sequence, or copy voice. Design references supply
possible moves; the Agent decides whether and how to use them.

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

## Visual Score (design before choosing coordinates)

The Visual Score forces a content-led design decision before a preset is
selected. Read `layout-presets.md`, then write one line per slide:

```text
- slide N — job: <what this slide must make the audience understand/do>
  anchor: <image | number | chart/table | diagram | type | media | none>
  relationship: <assertion | evidence | comparison | sequence | spatial | action>
  silhouette: <cover | statement | split | editorial | hero-media | metric |
               comparison | timeline | process | evidence | gallery | matrix |
               closing | custom>
  focal point: <the first thing the eye should land on>
  contrast: <scale / position / color / density / image-vs-type strategy>
  neighbor difference: <how this silhouette differs from slides N-1 and N+1>
  references used: <optional visual moves, or "none">
  heuristic broken: <optional heuristic + specific visual/narrative reason>
```

Rules:

- Preset selection comes AFTER job, anchor, and relationship. A preset is never
  the reason content exists.
- Presets provide geometry, not visual style. Adapt proportions for the actual
  crop, chart, copy length, and focal hierarchy.
- Prefer one composition over a collection of UI panels. There is no card-grid
  preset by design.
- Use real or generated imagery when it adds evidence, setting, identity, or
  emotional force. Do not use a stock photo merely to satisfy a quota.
- Default typography floor: 48px for cover/statement/closing titles, 34px for
  content titles, 24px for callouts, 16px for prose. Shorten copy or change the
  silhouette before shrinking type.
- Three consecutive slides from the same silhouette family require an adjacent
  Morph sequence, a redesign, or a stated reason for deliberate repetition.
- Inspiration is optional. Never add a gradient, photograph, rounded surface,
  oversized title, or dark field merely because it appears in the reference
  library.
- A deliberate heuristic break is valid. Put its reason in
  `data-ppt-design-rationale` when the linter would otherwise repeat an advisory.
  No rationale can waive clipping, illegibility, broken evidence, native loss,
  or motion discontinuity.

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
- Choose one guided silhouette from `layout-presets.md` after the slide job,
  visual anchor, and information relationship are known. Declare `custom` only
  when a deliberate original composition is better.
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
4. Every slide has a Visual Score: job, anchor, relationship, silhouette,
   focal point, contrast, neighbor difference, optional references, and any
   deliberate heuristic break. Copy fits at the typography floor; changing
   layout comes before shrinking type.
5. The declared `data-ppt-layout` sequence uses at least three silhouettes in a
   6+ slide deck, and no three-slide family repeat survives without a named
   Morph or design rationale (`DESIGN_LAYOUT_VARIETY` /
   `DESIGN_SILHOUETTE_REPEAT`). These are advisories: intentional systematic
   repetition is allowed when its purpose is explicit.
6. Each slide has exactly one motion grammar and at most one hero moment.
7. Every Morph candidate pair has its persisting objects named; every cluster
   in the build order maps to a wrapper/motif in the HTML you are about to
   write.
8. Review layout repetition (including `AI_CARD_GRID_MONOTONY`) without treating
   novelty as an end in itself. A repeated system is valid when comparison,
   cataloging, ritual, or continuity is the point and the Visual Score says so.
   The deck has its images/diagrams decided
   (`AI_IMAGE_SCARCITY`): concrete topic → useful sourced imagery on at least
   25% of slides (minimum two in a 6+ slide deck); abstract topic →
   `data-ppt-visual-strategy="diagram-only|data-only|typographic"` as a
   deliberate choice. Every chart names the claim it proves in
   `data-ppt-evidence`.
9. The Style Score defines roles and a visual thesis but protects slide-level
   invention. It contains no imported copy formula, fixed inspiration-brand
   palette, mandatory font, or required visual element.

## Implementation Prompt

After the plans pass the gate, internally restate the build task in direct
implementation language:

```text
Build a native-editable PPTX using pptx-native. Author HTML with explicit
data-ppt-layout/data-ppt-region composition roles and explicit
data-ppt-motion-preset/data-ppt-motion-intent per animated slide. Use
ambient/motif/sequence/Morph where the brief calls for them. Compile and iterate
until ok:true, validate ok, no unintended losses, and layout warnings resolved.
```

Then implement. Do not preserve the brief as a deck slide unless the user asks
for methodology/process content.
