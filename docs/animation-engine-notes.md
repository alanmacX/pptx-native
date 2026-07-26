# Animation Engine Notes (maintainer)

Split out of the authoring reference (references/animation.md): verification
procedure, native-animation inventory baselines, and compiler roadmap.

## Verification

The writer must pass three layers before being trusted:

```bash
python3 -m compileall -q pptx_native tools
python3 -m pptx_native validate outputs/animation-smoke/deck
python3 -m pptx_native index outputs/animation-smoke/deck --out outputs/animation-smoke/index.json
```

For Office compatibility, the smoke deck was also opened by Microsoft
PowerPoint through AppleScript and closed without repair.

The Morph smoke deck is:

```text
outputs/morph-smoke/morph-smoke.pptx
```

It validates cleanly, opens in PowerPoint, and indexes slide 2 as a Morph
transition with `option="byObject"`.

## Native Animation Inventory

`index` and `explore` now expose transition variants and all timing nodes. The
compact index includes:

- transition `kind`, `variants`, and Morph options.
- slides with timing, transitions, and Morph.
- timing target shapes.
- timing tag counts.
- action/effect records for `set`, `animEffect`, `animMotion`, `anim`,
  `animRot`, `animScale`, `cmd`, `audio`, and `video`.
- nearest `cTn` preset metadata for each action/effect record.

The current real-deck inventory baseline is:

```text
outputs/animation-inventory/summary.json
```

On `outputs/mvp-clean/deck`, it finds Morph transitions, entrance presets,
motion paths, emphasis rotation, generic animation nodes, and media playback
commands.

## Next Compiler Targets

- Convert frontend step diffs into native Morph-friendly object identity or
  explicit `p:timing`, depending on whether the interaction is slide-to-slide or
  within-slide.
- Add CSS/keyframe translation for simple `translate(...)` into native
  `motionPath`, with clear loss reporting when the browser path cannot be
  reduced to a PowerPoint relative path.
- Add native writers for fly-in and richer line/path draw variants.
- Preserve/edit existing timing trees through patch operations without
  normalizing away unknown Office XML.
