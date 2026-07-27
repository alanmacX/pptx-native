# Creative Direction

Use this reference when creating a deck from scratch or when the user asks for
stronger visual design. It separates reliable output constraints from optional
design inspiration so the Skill improves judgment without imposing a house
style.

## Three layers

### 1. Quality gates

Treat only objective delivery failures as hard blockers:

- clipped, overflowing, unreadable, or unintentionally overlapping content;
- insufficient contrast at the final projected size;
- broken crops, distorted or low-resolution images, watermarks, and embedded
  text that should be native;
- unsupported or lost native objects;
- a chart whose evidence claim is absent or whose data contradicts its title;
- animation that breaks object continuity, separates a semantic cluster, or
  conflicts with Morph.

Fix these before delivery. A design rationale does not waive a broken output.

### 2. Design heuristics

Treat composition repetition, palette restraint, negative space, image style,
surface effects, and tonal rhythm as review prompts. They are not correctness
rules. The Agent may combine, ignore, or deliberately break them when the
content or visual concept benefits.

When breaking a heuristic, record a concise reason in the Visual Score. Add
`data-ppt-design-rationale="<reason>"` to the affected slide when a lint
advisory would otherwise keep firing. Put the attribute on `<html>` or `<body>`
only for a deliberate deck-wide system. A reason must name the visual or
narrative purpose; “looks better” is not enough.

Examples:

```html
<section class="ppt-slide"
  data-ppt-layout="custom"
  data-ppt-design-rationale="Repeated centered titles create a calm chapter ritual">
</section>
```

```html
<body
  data-ppt-creative-direction="archival editorial collage"
  data-ppt-design-rationale="A strict six-cell catalog grid is the subject of the deck">
```

### 3. Inspiration library

Use the following as a vocabulary of possible moves, never as required
components or a preset theme.

| Dimension | Possible moves |
|---|---|
| Scale | oversized type, one dominant number, tiny contextual annotation |
| Space | protected clear field, edge tension, dense-to-open chapter rhythm |
| Type | display/text role contrast, language-aware tracking, numeric face |
| Image | full bleed, studio cutout, documentary crop, macro detail, collage |
| Surface | flat canvas, subtle tonal field, restrained gradient, soft depth |
| Composition | centered monument, asymmetric editorial split, cropped object, off-axis focal point |
| Contrast | light/dark chapter turn, color isolation, image-versus-type |
| Continuity | repeated anchor, expanding crop, persistent object, tonal bridge |

These moves are combinable. Do not label the result “Apple style” unless the
user explicitly requests that reference.

## Style Score

Write one deck-level Style Score before the Copy Plan:

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

Store recurring visual values as deck-local CSS variables. Tokens create
coherence; they must not import a fixed palette, font, radius, shadow, or
spacing scale from an inspiration source.

## Typography guidance

- Select Office-safe display and text stacks for the deck language.
- Judge weight optically after rendering. Do not require fixed 800/900 CJK
  weights or force Latin display fonts onto Chinese copy.
- Use tight display leading and more generous prose leading when appropriate.
- Keep the number of active size and weight levels small enough for hierarchy
  to remain legible, but allow deliberate typographic compositions.
- Inspect mixed-script baselines, punctuation, number width, and title wraps.

Typography floors in `layout-presets.md` remain quality defaults. A supplied
template or an intentional large-type composition may define another system,
provided the final render is readable.

## Image direction

Plan the crop before sourcing or generating an image:

```text
asset
- role: <evidence | setting | identity | emotion>
- frame: <full-bleed | portrait | landscape | cutout | custom>
- subject seat: <left | center | right | custom>
- copy-safe area: <left | right | top | bottom | none>
- crop priority: <face | product | action | environment>
- color temperature: <warm | neutral | cool | mixed>
```

Review every image for:

- useful information or emotional force;
- clean focal separation rather than background clutter;
- adequate resolution after the actual crop;
- natural or deliberately art-directed lighting;
- absence of watermarks, stock-photo clichés, and accidental embedded copy;
- color and treatment consistency with its chapter.

Do not require a photograph on every slide or on the cover. Data-, type-,
diagram-, and material-led decks may deliberately use no photography.

## Surface and tonal guidance

- Use radius only when an object is genuinely a container, crop, or material.
- Use shadow to express depth, not to upgrade every rectangle.
- Avoid simulating buttons, hover cards, pills, badges, tabs, or navigation.
- Let a gradient, texture, glow, or reflection have one clear visual job.
- Change lightness or density at a narrative turn, not on a mechanical
  white-gray-black rotation.
- Preserve a shared anchor across a tonal or chapter change when continuity
  matters.

These are heuristics. Experimental decks may intentionally use repetition,
grids, maximalism, hard shadows, or unusual crops when the rationale is
specific and the rendered result passes the quality gates.

## Copy boundary

Do not import brand copy formulas, slogan patterns, rhetorical questions,
superlatives, forced fragments, rhyme, 对仗, or 四字格 from a visual reference.
Copy follows the audience, evidence, and narrative rules in
`prompt-orchestration.md` and `design-and-motion.md`.

Visual design may change how copy is paced or positioned, but it must not force
the content into an imitation brand voice.
