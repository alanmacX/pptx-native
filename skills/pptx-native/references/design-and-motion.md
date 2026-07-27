# Design And Motion Contract

This reference keeps the skill's original intent: HTML/CSS is the design surface;
PowerPoint is the native editable output. Do not turn this into a style template
library. Components and motion grammars are structural contracts only.

## Native Component Coverage

Use the native object with the strongest editable meaning:

| Need | Native target | Authoring surface | Notes |
|---|---|---|---|
| Text, labels, headings | `p:sp` textbox | `.ppt-textbox` | Keep a phrase or paragraph in one text box; use rich inline spans instead of many fake text fragments. |
| Shapes, cards, badges | `p:sp` preset geometry | `.ppt-shape data-shape="<preset>"` | Any OOXML preset can pass through. Shape choice is semantic; visual style comes from CSS tokens. |
| Freeform marks | `p:sp` custom geometry | SVG path/polygon | Use for bespoke diagrams, not for ordinary rectangles/cards. |
| Connectors, arrows | `p:cxnSp`/line | `.ppt-line`, SVG line/polyline | Prefer native lines for editable workflows and diagrams. |
| Pictures | `p:pic` | `.ppt-picture` / `img` data URI or local file | Use only when an actual image asset is needed; never full-slide screenshots as final slides. |
| Media | `p:pic` + `p14:media` | `.ppt-media` / `video` / `audio` | Embed local/data video/audio; choreograph the media poster with native timing. |
| Groups | grouped/native sibling objects | `.ppt-group` as structure | Grouping is structural; children still carry their own object identity and tokens. |
| Tables/charts/notes | native scene JSON bridge | native authoring reference | Use semantic native objects when workbook/editable data matters. Shape-drawn charts are acceptable only when the HTML path is requested and the report says so. |
| Timing/transitions | `p:timing` / `p:transition` | `data-ppt-anim`, `data-ppt-sequence`, `data-ppt-transition`, `data-morph` | Prefer composed native primitives over video/GIF/raster fallbacks. |

## Style-Neutral Components

Component classes define object boundaries, not visual taste.

- Do not bake colors, fonts, border radii, shadows, or spacing into a reusable
  class unless they are explicitly supplied as deck-local CSS variables.
- Use names like `.ppt-flow`, `.ppt-roadmap`, `.ppt-metric-cluster` only to
  express information relationships. They must inherit tokens from the deck.
- Prefer semantic layout diversity: process, evidence stack, comparison, matrix,
  progression, map, funnel, timeline, and operating loop. Do not default every
  slide to three equal cards.

## Motion Grammar

Use animation to carry attention and continuity.

- Start with a slide-level contract, not an effect list:
  `data-ppt-motion-preset="elegant"` and
  `data-ppt-motion-intent="hierarchy|flow|timeline|comparison|layers|metricCluster|hubSpoke|stateChange|gallery|mediaReveal|ambient"`.
  The normalizer backfills missing values, but explicit intent keeps the
  choreography stable across retries.
- `compose` = one object, concurrent native primitives:
  fade + motion + scale + rotation + fill color.
- `data-ppt-sequence` = one container, multiple child targets expanded into
  staggered/overlapped native animations.
- `data-ppt-motif` = one semantic group, expanded into a role-aware choreography
  (timeline spine/items, layers stack, comparison columns, metric cluster,
  hub-spoke center/connectors/satellites).
- `data-ppt-ambient` = low-salience background/environment motion, expanded into
  native looping compose/motionPath/rotation/recolor/media commands. It must sit
  behind foreground content and support the mood or subject, not become the show.
- `data-morph` + Morph transition = continuity between adjacent slides. Morph
  owns the object's movement; same-slide entrances belong on sibling labels or
  supporting objects.

Sequence example:

```html
<div data-ppt-sequence="stagger; selector:.card; gap:90; overlap:160; y:24; scaleFrom:.96; scaleTo:1; dur:540; ease:out">
  <div class="ppt-shape card" id="a" data-shape="roundRect"></div>
  <div class="ppt-shape card" id="b" data-shape="roundRect"></div>
</div>
```

Rules:

- Keep velocity continuous: if one motion exits right, the next visual action
  should continue, settle, or intentionally counter it.
- Overlap related entrances by roughly 80-160ms. Pure serial queues feel robotic.
- Use one primary motion focus at a time; secondary elements should be softer.
- Pair large movement with a short settle: a slight scale or opacity finish.
- Avoid mixing Morph and same-slide timing on the same slide.
- Prefer concrete motion direction from layout logic: flow arrows move along the
  process; KPI clusters rise softly; evidence reveals from source to conclusion.

### Elegant preset

Use `data-ppt-motion-preset="elegant"` by default. It is a restraint profile, not
a visual style: color, type, layout, and content still come from the deck.

- Prefer `compose`, `sequence`, motif choreography, Morph, fade, and line/spine
  wipes.
- Avoid decorative PowerPoint gallery reveals (`blinds`, `box`, `checkerboard`,
  `circle`, `diamond`, `dissolve`, `plus`, `randombars`, `wedge`, `wheel`) on
  content objects. They may be remapped to fade/wipe by the unattended guard.
- Avoid spin by default. Use it only for a real rotating object (dial, clock,
  loader, wheel) and mark that purpose; otherwise the guard softens it.
- Do not use repeated pulses as texture. One purposeful emphasis per slide is
  enough; repeated/looping effects are clamped unless the slide intent is
  explicitly ambient.
- If four or more objects animate, use a container (`data-ppt-sequence`) or a
  semantic motif. Independent fades on every object are treated as weak
  choreography.
- Ambient background loops are allowed when declared with `data-ppt-ambient` or
  `data-ppt-motion-purpose="ambient"`. Keep them slow, subtle, and independent
  of foreground build timing.

## Appearance Control

Treat element styling as editable native controls:

- Shapes: use semantic preset geometry, CSS fills/gradients/borders, shadow,
  glow, blur, reflection, rotation, and flip.
- Text: keep real text in `.ppt-textbox`; vary hierarchy with size, weight,
  color, alignment, line height, and paragraph builds.
- Lines/freeforms: use connector lines, arrows, dash patterns, SVG polylines, or
  sampled paths for editable diagrams.
- Pictures/media: use local/data assets with native poster geometry and effects;
  animate the carrier or poster with compose/ambient/media commands.
- Animated blur/filter/3D/skew are not native controls. Decompose into layers,
  Morph states, media, or explicit motion paths.

## Motion Combo Library (premium defaults, research-grounded)

Professionals compose primitives; bare single-property motion reads cheap.
The engine's choreography (motifs, sequences, bare-fade upgrade) already
enforces the first three; reach for the rest deliberately:

| Combo | Recipe | Use for |
|---|---|---|
| Fade-Up (workhorse) | opacity + rise 16–24px, 250ms, decelerate | cards, text blocks, images |
| Fade-Up-Settle (hero) | Fade-Up + ~2% overshoot-return, 350–450ms | hero cards, key metrics, section titles — never body text |
| Scale-From-Origin Pop | scale .8→1 + fade, 200–300ms, origin = semantic parent anchor | badges, nodes, satellites |
| Spine-Draw → Node-Bloom | spine wipes 450–600ms, then each milestone grows OUT OF its spine anchor (engine does this) | timeline motif |
| Hub-Emanate | hub scales in, satellites travel from hub toward seat + fade + scale .6→1 (engine does this) | hubSpoke motif |
| Fade-Through Swap | out fast 75–90ms accelerate, THEN in 150–210ms decelerate (+ 92→100% scale) | replacing unrelated content |
| Shared-Axis Step | in slides ~30px one axis + fade; out slides same axis | sequential steps |
| Mask-Wipe + Counter-Drift | wipe reveal 400–600ms while content drifts 2–4% opposite + settles 1.05→1.00 | image/panel reveals |
| Hero Glyph Cascade | `byLetter:12-25`, glyphs rise ~8px, total <600ms | ONE headline per section, never paragraphs |
| Container-Transform | Morph the container's geometry; new content fades in AFTER the morph settles | cross-slide zoom/recontextualization |

Hard rules that make the combos read premium:

- **Clusters are atomic.** A card and everything on it enters as ONE body —
  identical delay, direction, easing. The engine enforces this on BOTH motif
  pages and plain `data-ppt-sequence` pages: targets sharing a wrapper (or
  sitting ≥60% inside a card-sized host, ≤25% of the stage) collapse into one
  delay slot. A full-width panel never swallows the bullet build on top of it,
  so list builds keep their stagger. A micro-cascade inside a unit is ≤60ms
  and inherits the unit's direction. Regression guard:
  `node tools/ppt_motion_gates.cjs`.
- **Origin continuity.** New elements grow FROM their semantic parent (spine
  anchor, hub, trigger) — never from screen edges or their own center when a
  parent exists. Travel for ordinary entrances is 2–3% of slide height;
  off-screen fly-in needs a spatial story.
- **Easing is asymmetric.** Entrances decelerate; exits accelerate at ~65% of
  the entrance duration; linear positional motion is banned. Named curves:
  `ease:out` (default), or exact via `tmFilter`.
- **Stagger 20–80ms** between peer units, one shared easing/duration family —
  never a >100ms roll-call, never everything at once.
- **One hero motion per slide** (a draw-on, a byLetter title, a morph zoom);
  everything else gets quiet 150–300ms entrances. Duration scale: micro 90–150,
  standard 200–300, hero 400–500, hard cap 700ms.
- **Morph is for continuity of the SAME subject** (zoom into a point, re-sort,
  reframe). Prefer it over rebuilding a slide's worth of entrances when ≥1
  object persists across the cut. Use builds within a slide, Morph between.

## Anti-AI Layout Tells (from owner review — treat as blockers)

The linter enforces these as `AI_*` warnings; the build workflow requires
resolving them (or keeping a slide only with a stated reason) before shipping.
Deck-level monotony rules fire once HALF the deck (min 3 slides) shows the
tell — they read as AI well before they hit every page.
Regression guard: `node tools/ppt_taste_gates.cjs`.

- **Title lockup monotony** (`AI_TITLE_LOCKUP_MONOTONY`, `AI_EN_EYEBROW`,
  `AI_FOOTNOTE_FURNITURE`): the big-title-top-left + small-eyebrow + bottom
  footnote lockup repeated across the deck is the #1 tell. Vary title
  placement (centered cover, left-third splits, bottom-anchored image slides,
  an occasional full-bleed statement slide). English eyebrows on Chinese decks
  are banned outright. Footnotes only where a source needs citing — not as
  furniture.
- **Rectangle-grid monotony** (`AI_CARD_GRID_MONOTONY`): repeated same-size
  cards slide after slide reads as template output — three-in-a-row is already
  a grid, and cards built as filled textboxes count. Vary unit sizes by
  importance (hero metric bigger), break grids with a full-width band or a
  diagram, let one slide be a single strong number. Cards are A layout tool,
  not THE layout.
- **Text walls + meaningless charts** (`AI_TEXT_WALL`,
  `AI_CHART_DECORATION`): the density budget is
  ≤4 body blocks per slide, ≤45 CJK-equivalent chars per block
  (prompt-orchestration.md); the lint fires past it. If a chart doesn't prove
  the title, cut it. Mark every shape-drawn chart container
  `data-ppt-role="chart"` and name the claim it proves with
  `data-ppt-evidence="..."`. Slides carry verdicts; notes carry prose.
- **Image scarcity** (`AI_IMAGE_SCARCITY`): zero or token imagery in a
  multi-slide deck reads text-and-boxes AI. For six or more slides, image-led
  concrete decks should place useful imagery on at least 25% of slides
  (minimum two), not dump one token photo on the cover. Staying image-free is
  legitimate for an abstract/data/type-led deck only as a deliberate, explicit
  strategy: `data-ppt-visual-strategy="diagram-only|data-only|typographic"`.

## Copy And Preset Hygiene (anti-AI writing rules)

Titles:

- Verdict-first: every content-slide title is a complete judgment with a
  number or stance, ≤20 CJK chars (「基础功能等9月，新Siri看2027」not
  「时间线分析」). Banned title shapes: colon-topic (X：机遇与挑战),
  浅析X / X面面观 / "X: A Deep Dive" / "The Power of X", noun-phrase-only.
- The horizontal test: titles read in order must tell the whole argument.

Body:

- Specifics over abstractions: replace 显著提升/深远影响/robust/significant
  with a number, date, name. A weaker concrete claim beats a stronger vague
  one — 「3家试点，2家回本」beats「试点成效显著」.
- Max ONE deliberate parallel triple per deck. Never ≥3 bullets sharing a
  syntactic frame or 四字格 openers; no 不仅…而且 / 不是…而是 stacks.
- Asymmetric rhythm: pair a long specific clause with a 2–4 char fragment
  (「成本，砍半。」). Verb-less fragments are correct slide grammar; uniform
  sentence lengths are a primary tell.
- Kill scaffolding on slides: 首先/其次/最后, 综上所述, 值得注意的是, 此外;
  Additionally/Furthermore/In conclusion. Layout IS the transition.
- Take a position: recommendation slides open with a stance that could be
  wrong (停掉 / 别指望Q3回本 / 几乎不可能). Hedge at most once per deck,
  attached to a named risk.
- One register per deck: 报告体 or 口语体, chosen up front, never mixed.
- De-jargon: 赋能→帮/让…能, 抓手→办法, 闭环→跑通全流程, 打通→连起来,
  沉淀→存下来, 底层逻辑→原因. Empty verbs (empower/unlock/transform) and
  empty intensifiers (极大/全面/深入/seamless/cutting-edge) need a proving
  specific in the same sentence, or they go.
- Named sources or honest silence: figures get 「来源, 年份」footnotes;
  据研究显示/experts argue is banned; unsourced numbers get 内部估算.
- Banned outright: ceremonial 套话 (共创辉煌/砥砺前行/携手共进/谱写新篇章),
  取得圆满成功/反响热烈-class vague achievement, 是一把双刃剑,
  机遇与挑战并存, 随着…的发展 openers, spaced " — " as universal connector,
  **Term**: description as the default bullet shape, closing slides that
  restate the cover with 让我们… exhortations.
- Leave the burr: one-word lines, a sentence starting with 但, a bullet that
  is just a number — structural looseness (never fabricated errors) is what
  human decks have and templates don't.

General:

- Avoid identical slide skeletons. Vary information architecture according to
  content, not decoration.
- Use Chinese-friendly Office-safe typography for Chinese decks. Do not force
  awkward Latin-only font choices.
- Never use a preset phrase just because a component exists. Components are
  native object scaffolds; the deck's content decides the wording.
