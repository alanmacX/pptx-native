# Prompt Orchestration

For pptx-native generation, broad user prompts should first become an internal
implementation brief, then HTML/scene authoring. This makes the skill behave
like a presentation director instead of a raw HTML generator.

Brief fields:

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

Rules:

- One information architecture per slide: hierarchy, process, timeline,
  comparison, evidence stack, metric cluster, hub-spoke, map, matrix, gallery,
  or state change.
- One motion grammar per slide: `compose`, `data-ppt-sequence`,
  `data-ppt-motif`, Morph, or `data-ppt-ambient`.
- Plan native carriers before styling.
- Use explicit slide-level `data-ppt-motion-preset` and
  `data-ppt-motion-intent`.
- Treat the brief as internal scaffolding, not deck content.
