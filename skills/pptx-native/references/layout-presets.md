# Guided Layout Presets

These presets are **composition grammars**, not templates. They provide a
machine-checkable silhouette and region geometry while leaving typography,
palette, imagery, shape language, spacing nuance, and copy to the Agent.

Use them to prevent blank-canvas drift, not to avoid design judgment.
They are optional starting points: `custom` is a first-class choice, not an
escape hatch or a lower-quality result.

## Decision order

For every slide:

1. State its narrative job and one primary claim.
2. Choose the visual anchor: image, number, chart/table, diagram, type, or media.
3. Choose the information relationship: assertion, evidence, comparison,
   sequence, spatial relation, or action.
4. Select the closest preset **only after** steps 1–3.
5. Adapt proportions and alignment to the actual content. The preset is a
   starting geometry, not a locked template.
6. Name what makes this slide visually distinct from its neighbors.

If no preset fits, author a custom silhouette and set
`data-ppt-layout="custom"`. A custom slide still follows the typography,
density, asset, and QA rules in `design-and-motion.md`.

## Preset selector

| Content need | Start with | Design move |
|---|---|---|
| Opening tension or promise | `cover` | One idea, generous scale, minimal support |
| One decisive claim | `statement` | Let type and negative space carry the page |
| Argument + real visual | `split` | Make one side dominant; avoid mechanical 50/50 |
| Magazine-like story | `editorial` | Asymmetric reading path, one strong image |
| Immersive scene/product/person | `hero-media` | Full-bleed visual, controlled text overlay |
| One number that changes the decision | `metric` | One dominant metric, evidence secondary |
| Two real alternatives or states | `comparison` | Use asymmetry to show the verdict |
| Chronology | `timeline` | One spine; milestones grow from it |
| Causal/operational sequence | `process` | Connected flow with an explicit outcome |
| Proof + meaning | `evidence` | Visual first, interpretation beside it |
| Curated examples | `gallery` | One dominant item, smaller supporting items |
| Two meaningful dimensions | `matrix` | Axes explain placement and decision |
| Decision/action/implication | `closing` | Resolve the opening; do not add new evidence |

There is intentionally no `cards`, `dashboard`, `three-columns`, or `agenda`
preset. Those are common failure modes, not information architectures.

## Authoring contract

Declare the silhouette on the slide and semantic regions on direct native
objects or structural containers:

```html
<section class="ppt-slide" data-ppt-layout="evidence">
  <div class="ppt-textbox" data-ppt-region="title">The pilot paid back in 11 months</div>
  <img class="ppt-picture" data-ppt-region="visual" src="./payback.png">
  <div class="ppt-textbox" data-ppt-region="interpretation">
    Two sites carried the gain; the third should stop.
  </div>
</section>
```

Import `assets/ppt-components.css` from the Skill to use the default 1280×720
region geometry. Repo-local examples may use the compatibility entrypoint
`web/ppt-components.css`.
Standard CSS can override any region. When a native object gets its geometry
from a known `data-ppt-region`, the linter accepts the computed CSS box; inline
geometry is no longer required for that object.

The machine registry is `layout-presets.json`. It owns:

- family and narrative job;
- required/optional regions;
- maximum title lines;
- default motion intent;
- the failure modes the preset must not introduce.

## Typography floor

Unless the user or a supplied template says otherwise:

- cover/statement/closing title: at least 48px;
- content-slide title: at least 34px;
- subheading/callout: at least 24px;
- prose: at least 16px;
- caption/source/axis labels may be smaller when legible.

Shorten copy or change the silhouette before shrinking type. A one-line content
title must remain one line unless the selected preset explicitly permits two.

## Across-slide rhythm

- Adjacent slides should not share the same silhouette by reflex.
- Three consecutive slides from one family trigger the advisory
  `DESIGN_SILHOUETTE_REPEAT` unless the repetition has a declared design
  rationale.
- A 6+ slide deck using fewer than three declared silhouettes triggers
  the advisory `DESIGN_LAYOUT_VARIETY`.
- Repeating a silhouette is legitimate for a deliberate Morph sequence or a
  comparison, catalog, chapter ritual, or experimental system. Put the reason
  in the Visual Score and `data-ppt-design-rationale` when applicable.
- Vary scale and density, not merely background color: pair an evidence-heavy
  page with a statement, media, or metric page when that improves the story.

## Preset adaptation rules

- Change proportions to follow the focal object. A portrait, phone UI, wide
  chart, and human face do not deserve the same media box.
- Crop for the copy position: if text sits left, preserve visual breathing room
  on the left and place the subject toward the right.
- Prefer one dominant composition over a collection of bordered panels.
- Cards are allowed when they represent real independent units, but one must be
  visually primary when importance differs.
- Decorative shapes may support hierarchy; they must not become the primary
  content carrier.
- A chart must name the claim it proves (`data-ppt-evidence`).
- A visual should add evidence, setting, identity, or emotional force. If it
  does none of those, remove it.

## Design gate

Before HTML:

1. The slide job and claim are explicit.
2. The visual anchor is chosen or deliberately absent.
3. The preset follows the information relationship, not habit.
4. Copy fits the region at the typography floor.
5. Adjacent silhouettes differ or form a named Morph sequence.
6. The slide has one focal point and one motion grammar.
7. No preset introduces filler copy, equal-card grids, or decorative charts.

Items 3, 5, and 6 are design-review prompts rather than correctness rules.
Deliberately break them when the visual thesis benefits and record why. See
`creative-direction.md`.

Run the executable regression gate after changing preset CSS, registry, or
design lint:

```bash
node tools/ppt_design_gates.cjs
```
