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
