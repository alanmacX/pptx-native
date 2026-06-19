"""Machine-readable capability manifest.

This is the contract surface for any agentic LLM (including ones with no visual
capability): it enumerates exactly what the compiler can turn into native
PowerPoint, so an agent can query support *before* generating a scene instead of
discovering losses after the fact.

The manifest is derived from the live implementation tables wherever possible so
it cannot drift from what the compiler actually emits.
"""
from __future__ import annotations

from typing import Any

from . import author

SCHEMA_VERSION = "2.0"

# Status vocabulary for every capability entry:
#   "compiles"     -> writer exists, passes validate + PowerPoint-open smoke.
#   "declared-gap" -> PowerPoint supports it natively and the agent may author
#                     the intent, but the writer is not landed yet, so the
#                     compiler emits an explicit loss instead of silent degrade.
COMPILES = "compiles"
GAP = "declared-gap"


def build_capabilities() -> dict[str, Any]:
    # filter_entrance = single-preset reveals (also usable as exit / text build).
    # entrance also exposes the modern combined fade+slide(+zoom) motion presets.
    filter_entrance = sorted(author._ANIM_EFFECT_FILTERS.keys())
    entrance = sorted(set(filter_entrance) | set(author._MOTION_ENTRANCES.keys()))
    emphasis = sorted(author._EMPHASIS_EFFECTS)
    presets = sorted(author._SHAPE_PRESETS)
    arrow_ends = sorted(author._ARROW_ENDS)
    transitions = sorted(author._TRANSITION_TYPES)
    morph_options = list(author._MORPH_OPTIONS)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "engine": "pptx_native",
        "note": (
            "Single source of truth for the agent. status=compiles entries pass "
            "validate + PowerPoint-open smoke. status=declared-gap entries are "
            "native PowerPoint capabilities the agent may author as intent; the "
            "compiler emits an explicit loss until the writer lands. Anything not "
            "listed at all is an undeclared loss and a bug. Vocab is reflected "
            "from author.py tables so it cannot drift from the compiler."
        ),
        "components": {
            "textbox": {
                "status": COMPILES,
                "ooxmlTarget": "p:sp / a:txBody",
                "richRuns": True, "bullets": "partial", "fields": False, "rotation": True,
                "authorIRShape": {"type": "text", "text": "str|runs[]", "x": "px", "y": "px",
                                  "w": "px", "h": "px", "rotation": "deg?"},
            },
            "shape": {
                "status": COMPILES,
                "ooxmlTarget": "p:sp / a:prstGeom",
                "presets": presets,
                "fill": ["solid", "gradient", "none"],
                "stroke": {"width": True, "dash": sorted(author._DASH_STYLES), "alpha": True},
                "radiusFromCss": True,
                "rotation": True,
                "authorIRShape": {"type": "shape", "shape": "<preset>", "x": "px", "y": "px",
                                  "w": "px", "h": "px", "fill": "hex?", "fillGradient": "obj?",
                                  "line": "obj?", "rotation": "deg?"},
            },
            "freeform": {
                "status": COMPILES,
                "ooxmlTarget": "p:sp / a:custGeom",
                "closedFilled": True, "fromSampledPoints": True, "bezier": "partial",
                "authorIRShape": {"type": "freeform", "points": "[[x,y]...]", "closed": "bool",
                                  "fill": "hex?"},
            },
            "connector": {
                "status": COMPILES,
                "ooxmlTarget": "p:cxnSp / a:ln",
                "straight": True, "arrowEnds": arrow_ends, "bentOrCurved": False,
                "authorIRShape": {"type": "line", "x1": "px", "y1": "px", "x2": "px", "y2": "px",
                                  "arrow": "bool|end-name"},
            },
            "picture": {
                "status": COMPILES,
                "ooxmlTarget": "p:pic / a:blip",
                "dataImage": True, "crop": False, "rotation": True,
                "authorIRShape": {"type": "image", "src": "data:image/*", "x": "px", "y": "px",
                                  "w": "px", "h": "px"},
            },
            "table": {
                "status": COMPILES,
                "ooxmlTarget": "p:graphicFrame / a:tbl",
                "authorIRShape": {"type": "table", "x": "px", "y": "px", "w": "px", "h": "px",
                                  "columns": "[px]?", "fontSize": "pt?", "headerFill": "hex|slot?",
                                  "headerColor": "hex?", "rowFill": "hex|slot?", "borderColor": "hex|slot?",
                                  "rows": "[[cell|{text,fill,color,bold,align,valign,fontSize}...]...]"},
                "note": "Native editable table. Cell fills/colors accept theme slots. "
                        "Merged cells (colspan/rowspan) not yet supported.",
            },
            "group": {"status": GAP, "ooxmlTarget": "p:grpSp",
                      "note": "Decompose into sibling shapes until the writer lands."},
            "chart": {
                "status": COMPILES,
                "ooxmlTarget": "p:graphicFrame / c:chart (+ embedded xlsx)",
                "chartTypes": ["bar", "column", "barh", "line", "pie"],
                "authorIRShape": {"type": "chart", "chartType": "bar|line|pie", "x": "px", "y": "px",
                                  "w": "px", "h": "px", "title": "str?", "legend": "bool?",
                                  "categories": "[str]",
                                  "series": "[{name, values:[num], color:hex|slot?}]"},
                "note": "Native data-driven chart with an embedded editable workbook (PPT 'Edit "
                        "Data' opens the xlsx). Series colors accept theme slots. Cached values "
                        "render without recalculation.",
            },
            "smartArt": {"status": GAP, "ooxmlTarget": "p:graphicFrame / dgm:*"},
            "media": {"status": GAP, "ooxmlTarget": "p:pic / p:nvPr/a:videoFile"},
        },
        "effects": {
            "shadow": {"status": COMPILES, "ooxmlTarget": "a:effectLst/a:outerShdw",
                       "params": ["color", "blur", "distance", "direction", "alpha"]},
            "glow": {"status": COMPILES, "ooxmlTarget": "a:effectLst/a:glow",
                     "params": ["color", "radius", "alpha"]},
            "softEdge": {"status": GAP, "ooxmlTarget": "a:effectLst/a:softEdge"},
            "reflection": {"status": GAP, "ooxmlTarget": "a:effectLst/a:reflection"},
        },
        "animation": {
            "within": {
                "entrance": entrance,
                "appear": True,
                "exit": ["exit-" + e for e in filter_entrance],
                "emphasis": emphasis,
                "recolor": {"status": COMPILES, "attr": "fill color (animClr)"},
                "loop": {"repeat": "<n> | infinite", "alternate": True, "status": COMPILES},
                "chain": {"syntax": "data-ppt-anim segments joined by '|', or a CSS animation list",
                          "status": COMPILES},
                "motionPath": {"requires": ["pptPath"], "status": COMPILES,
                               "namedPresets": GAP},
                "textBuild": {
                    "effect": "build",
                    "by": "paragraph",
                    "buildEffect": filter_entrance,
                },
                "triggers": ["onClick", "withPrevious", "afterPrevious", "auto"],
            },
            "between": {
                "transitions": transitions,
                "morph": {
                    "options": morph_options,
                    "explicitIdentity": "morphKey",
                    "autoInference": "autoMorph",
                    "choreography": GAP,
                },
            },
        },
        # Native PowerPoint vocabulary the agent should know exists. theme/master
        # are currently emitted as a single blank stub (status=stub): structurally
        # valid but not yet parametrized for one-click restyling or placeholders.
        "native": {
            "theme": {
                "status": COMPILES,
                "ooxmlTarget": "ppt/theme/theme1.xml",
                "authorIRShape": {"theme": {"name": "str?", "colors": "{accent1..6,dk2,lt2,hlink,folHlink: hex}",
                                            "fonts": "{majorLatin,majorEa,minorLatin,minorEa: str}"}},
                "colorSlots": sorted(author._SCHEME_TOKENS),
                "note": ("Deck-level palette + fonts. Any element fill/stroke/gradient "
                         "stop may reference a slot by name (e.g. fill:'accent1' or "
                         "'scheme:accent1') so one theme swap restyles the whole deck."),
            },
            "master": {"status": "stub", "ooxmlTarget": "ppt/slideMasters/*",
                       "note": "Single blank master/layout; no placeholder system yet."},
            "layout": {"status": "stub", "ooxmlTarget": "ppt/slideLayouts/*",
                       "placeholders": GAP},
            "notes": {"status": COMPILES, "ooxmlTarget": "ppt/notesSlides/*",
                      "authorIRShape": {"slide": {"notes": "str (speaker notes, \\n = paragraphs)"}},
                      "note": "Per-slide speaker notes (presenter view). A shared notesMaster is "
                              "emitted automatically when any slide has notes."},
            "section": {"status": GAP, "ooxmlTarget": "p:sectionLst (ext)"},
        },
        "targeting": {
            "animationTargetKeys": ["shapeId", "spid", "target", "targetKey", "sourceKey", "name", "id"],
            "stableHtmlKey": "source.key",
        },
    }
