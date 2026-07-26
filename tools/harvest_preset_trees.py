#!/usr/bin/env python3
"""Harvest PowerPoint-authored animation effect trees into a template library.

Usage:
  python3 tools/harvest_preset_trees.py <corpus-done.pptx> \
      [--out pptx_native/preset_trees.json] [--merge]

The corpus deck is authored by a human in the PowerPoint UI (one effect per
shape; see outputs/harvest-corpus.pptx). This script extracts every effect
<p:par> subtree from the slides' p:timing, keyed by
"<presetClass>:<presetID>:<presetSubtype>", with ids/spids/group-ids/the
effect delay replaced by placeholders so the writer can instantiate them.

"Never guess a tree": these subtrees are exactly what PowerPoint wrote, so
re-emitting them (plus the label triple) gives named, Animation-Pane-editable
effects with guaranteed playback.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
}

# Friendly names from the verified interop tables (docs/web-motion-parity-design.md).
ENTR_NAMES = {
    1: "appear", 2: "fly-in", 3: "blinds", 4: "box", 5: "checkerboard", 6: "circle",
    7: "crawl-in", 8: "diamond", 9: "dissolve-in", 10: "fade", 11: "flash-once",
    12: "peek-in", 13: "plus", 14: "random-bars", 15: "spiral-in", 16: "split",
    17: "stretch", 18: "strips", 19: "swivel(classic)", 20: "wedge", 21: "wheel",
    22: "wipe", 23: "zoom(classic)", 25: "boomerang", 26: "bounce", 30: "float",
    31: "grow-and-turn", 34: "rise-up", 37: "thread", 38: "falling-in", 40: "unfold",
    41: "whip", 42: "ascend/float-in", 45: "swivel", 47: "descend", 53: "zoom",
}
EMPH_NAMES = {
    1: "fill-color", 3: "font-color", 6: "grow-shrink", 8: "spin", 9: "transparency",
    19: "object-color", 21: "complementary-color", 24: "darken", 25: "desaturate",
    26: "pulse", 27: "color-pulse", 30: "lighten", 32: "teeter", 34: "wave",
    35: "blink", 36: "shimmer",
}


def q(tag: str) -> str:
    pre, local = tag.split(":")
    return f"{{{NS[pre]}}}{local}"


def effect_pars(timing_xml: str):
    """Yield raw XML strings of every <p:par> whose cTn carries presetClass."""
    # Regex over raw text keeps the subtree byte-faithful (ET would reorder
    # namespaces). Match balanced <p:par>...</p:par> by scanning.
    for m in re.finditer(r"<p:par>\s*<p:cTn [^>]*presetClass=", timing_xml):
        start = m.start()
        depth = 0
        i = start
        while i < len(timing_xml):
            nxt_open = timing_xml.find("<p:par>", i)
            nxt_close = timing_xml.find("</p:par>", i)
            if nxt_close < 0:
                break
            if 0 <= nxt_open < nxt_close:
                depth += 1
                i = nxt_open + 7
            else:
                depth -= 1
                i = nxt_close + 8
                if depth == 0:
                    yield timing_xml[start:i]
                    break


def template_tree(par_xml: str) -> tuple[str, dict]:
    """Replace volatile attributes with placeholders; return (template, meta)."""
    # Attribute order varies between writers: locate the head tag, then pull
    # each attribute independently (an optional group inside one big regex
    # gets swallowed by the adjacent [^>]* and silently reads subtype as 0).
    head_tag = re.search(r'<p:cTn [^>]*presetClass="[^"]*"[^>]*>', par_xml)
    if not head_tag:
        return "", {}
    tag = head_tag.group(0)
    pid_m = re.search(r'presetID="(-?\d+)"', tag)
    cls_m = re.search(r'presetClass="(\w+)"', tag)
    sub_m = re.search(r'presetSubtype="(-?\d+)"', tag)
    if not pid_m or not cls_m:
        return "", {}
    pid, cls, sub = pid_m.group(1), cls_m.group(1), (sub_m.group(1) if sub_m else "0")

    spids = sorted(set(re.findall(r'spid="(\d+)"', par_xml)), key=int)
    meta = {
        "presetClass": cls,
        "presetID": int(pid),
        "presetSubtype": int(sub),
        "targetSpids": spids,
        "multiTarget": len(spids) > 1,
    }
    out = par_xml
    # ids -> sequential placeholders (writer renumbers on instantiation)
    ids = re.findall(r'\bid="(\d+)"', out)
    for n, raw_id in enumerate(dict.fromkeys(ids)):
        out = re.sub(rf'\bid="{raw_id}"', f'id="{{ID{n}}}"', out)
    out = re.sub(r'spid="\d+"', 'spid="{SPID}"', out)
    out = re.sub(r'grpId="\d+"', 'grpId="{GRPID}"', out)
    # the OUTER effect delay (first stCondLst cond of the head cTn) -> {DELAY};
    # inner behavior delays are part of the choreography and must stay.
    out = re.sub(r'(<p:stCondLst><p:cond delay=")(\d+)("/></p:stCondLst>)',
                 r"\g<1>{DELAY}\g<3>", out, count=1)
    return out, meta


def shape_name_map(slide_xml: str) -> dict[str, str]:
    return {sid: name for sid, name in re.findall(r'<p:cNvPr id="(\d+)" name="([^"]*)"', slide_xml)}


def friendly(cls: str, pid: int) -> str:
    if cls == "entr":
        return ENTR_NAMES.get(pid, f"entr-{pid}")
    if cls == "exit":
        return ENTR_NAMES.get(pid, f"exit-{pid}")
    if cls == "emph":
        return EMPH_NAMES.get(pid, f"emph-{pid}")
    if cls == "path":
        return f"motion-path-{pid}"
    return f"{cls}-{pid}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pptx")
    ap.add_argument("--out", default="pptx_native/preset_trees.json")
    ap.add_argument("--merge", action="store_true",
                    help="merge into an existing preset_trees.json instead of replacing")
    args = ap.parse_args()

    src = Path(args.pptx)
    if not src.exists():
        print(json.dumps({"ok": False, "error": f"not found: {src}"}))
        return 1

    trees: dict[str, dict] = {}
    duplicates: list[str] = []
    harvested: list[dict] = []
    unanimated_labels: list[str] = []

    with zipfile.ZipFile(src) as z:
        slide_files = sorted(
            (n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
            key=lambda n: int(re.search(r"(\d+)", n).group(1)))
        for sf in slide_files:
            xml = z.read(sf).decode("utf-8")
            names = shape_name_map(xml)
            animated_spids: set[str] = set()
            for par in effect_pars(xml):
                tpl, meta = template_tree(par)
                if not tpl:
                    continue
                key = f'{meta["presetClass"]}:{meta["presetID"]}:{meta["presetSubtype"]}'
                animated_spids.update(meta["targetSpids"])
                label = names.get(meta["targetSpids"][0], "") if meta["targetSpids"] else ""
                row = {
                    "key": key,
                    "name": friendly(meta["presetClass"], meta["presetID"]),
                    "slide": sf,
                    "shape": label,
                }
                harvested.append(row)
                if key in trees:
                    duplicates.append(key)
                    continue
                trees[key] = {
                    **meta,
                    "name": row["name"],
                    "sourceSlide": sf,
                    "sourceShape": label,
                    "template": tpl,
                }
            # labeled chips (our corpus names contain "#e-/#m-/#x-/#p-") with no animation
            for sid, nm in names.items():
                if re.search(r"#(e|m|x|p)-", nm) and sid not in animated_spids:
                    unanimated_labels.append(f"{sf}:{nm}")

    out_path = Path(args.out)
    existing: dict = {}
    if args.merge and out_path.exists():
        existing = json.loads(out_path.read_text(encoding="utf-8")).get("trees", {})
    existing.update(trees)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        "version": 1,
        "source": str(src),
        "discipline": "never guess a tree: templates are byte-faithful PowerPoint emissions",
        "trees": existing,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({
        "ok": True,
        "out": str(out_path),
        "harvestedKeys": sorted(trees),
        "named": {k: v["name"] for k, v in sorted(trees.items())},
        "count": len(trees),
        "duplicates": sorted(set(duplicates)),
        "labeledShapesWithoutAnimation": unanimated_labels,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
