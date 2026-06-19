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
    all_timing = [
        "appear",
        "entrance",
        "exit",
        "emphasis",
        "motionPath",
        "compose",
        "sequenceTarget",
    ]
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
                "dataImage": True, "localImage": True, "crop": False, "rotation": True,
                "effects": ["shadow", "glow", "blur", "reflection"],
                "authorIRShape": {"type": "image", "src": "data:image/*|file://|local path", "x": "px", "y": "px",
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
            "media": {
                "status": COMPILES,
                "ooxmlTarget": "p:pic / p:nvPr/a:videoFile|a:audioFile + p14:media",
                "supportedMimes": ["video/mp4", "video/quicktime", "video/webm",
                                   "audio/mpeg", "audio/wav", "audio/mp4", "audio/aac", "audio/ogg"],
                "poster": "optional image poster; blank PNG fallback",
                "effects": ["shadow", "glow", "blur", "reflection"],
                "authorIRShape": {"type": "media", "mediaType": "video|audio", "src": "data:*|file://|local path",
                                  "poster": "data:image|file://|local path?", "x": "px", "y": "px",
                                  "w": "px", "h": "px"},
                "note": "Media files are embedded from local/data assets. Search/import tools should download remote assets first; do not hotlink URLs in final PPTX.",
            },
        },
        "effects": {
            "shadow": {"status": COMPILES, "ooxmlTarget": "a:effectLst/a:outerShdw",
                       "params": ["color", "blur", "distance", "direction", "alpha"]},
            "glow": {"status": COMPILES, "ooxmlTarget": "a:effectLst/a:glow",
                     "params": ["color", "radius", "alpha"]},
            "softEdge": {"status": GAP, "ooxmlTarget": "a:effectLst/a:softEdge"},
            "reflection": {"status": COMPILES, "ooxmlTarget": "a:effectLst/a:reflection",
                           "params": ["alpha", "dist", "blur"]},
        },
        "surface": {
            "purpose": (
                "Carrier matrix for choosing the native PowerPoint object before "
                "authoring properties or animation. Query this to avoid putting a "
                "property on an object whose writer cannot emit it."
            ),
            "carriers": {
                "textbox": {
                    "status": COMPILES,
                    "ooxmlTarget": "p:sp / a:txBody",
                    "html": "text node / .ppt-textbox",
                    "sceneType": "text",
                    "properties": ["geometry", "textRuns", "font", "color", "align", "valign", "rotation"],
                    "effects": [],
                    "timing": all_timing + ["textBuild"],
                    "gaps": ["shapeFillBehindText", "textShadow", "textGlow", "hyperlink", "fields"],
                    "note": "For text inside an effect-bearing box, author a shape with text instead of a bare text object.",
                },
                "shape": {
                    "status": COMPILES,
                    "ooxmlTarget": "p:sp / a:prstGeom",
                    "html": ".ppt-shape / painted div",
                    "sceneType": "shape",
                    "properties": ["geometry", "presetGeometry", "solidFill", "linearGradient", "radialGradient",
                                   "stroke", "dash", "alpha", "rotation", "flip", "text"],
                    "effects": ["shadow", "glow", "blur", "reflection"],
                    "timing": all_timing,
                    "gaps": ["patternFill", "pictureFill", "softEdge", "3d"],
                },
                "freeform": {
                    "status": COMPILES,
                    "ooxmlTarget": "p:sp / a:custGeom",
                    "html": "filled SVG path/polygon/polyline",
                    "sceneType": "freeform|polygon|path",
                    "properties": ["points", "closed", "solidFill", "linearGradient", "radialGradient", "stroke"],
                    "effects": ["shadow", "glow", "blur", "reflection"],
                    "timing": all_timing,
                    "gaps": ["trueBezierAuthoring", "editPointsUiHints"],
                },
                "connector": {
                    "status": COMPILES,
                    "ooxmlTarget": "p:cxnSp / a:ln",
                    "html": ".ppt-line / SVG line/polyline",
                    "sceneType": "line|polyline",
                    "properties": ["x1", "y1", "x2", "y2", "stroke", "dash", "arrowEnd"],
                    "effects": [],
                    "timing": all_timing,
                    "gaps": ["bentConnector", "curvedConnector", "connectorGlow", "connectorShadow"],
                },
                "picture": {
                    "status": COMPILES,
                    "ooxmlTarget": "p:pic / a:blip",
                    "html": "img / .ppt-picture",
                    "sceneType": "image",
                    "properties": ["geometry", "dataImage", "localImage", "rotation", "flip"],
                    "effects": ["shadow", "glow", "blur", "reflection"],
                    "timing": all_timing,
                    "gaps": ["crop", "transparency", "duotone", "artisticEffects", "animatedFilter"],
                    "note": "Partial/progressive image effects require decomposition into multiple native pictures, as in the blur-scan demo.",
                },
                "media": {
                    "status": COMPILES,
                    "ooxmlTarget": "p:pic / a:videoFile|a:audioFile + p14:media",
                    "html": "video / audio / .ppt-media",
                    "sceneType": "media",
                    "properties": ["geometry", "mediaType", "src", "poster", "rotation", "flip"],
                    "effects": ["shadow", "glow", "blur", "reflection"],
                    "timing": all_timing,
                    "gaps": ["playbackCommands", "trim", "posterFrameExtraction", "captions"],
                    "note": "Use local/data media assets. Playback control p:cmd is still a gap; visual entrance/exit/choreography works on the media poster picture.",
                },
                "table": {
                    "status": COMPILES,
                    "ooxmlTarget": "p:graphicFrame / a:tbl",
                    "html": "native scene JSON only",
                    "sceneType": "table",
                    "properties": ["rows", "columns", "cellText", "cellFill", "cellColor", "borderColor"],
                    "effects": [],
                    "timing": all_timing,
                    "gaps": ["mergedCells", "tableEffects", "htmlExtraction"],
                },
                "chart": {
                    "status": COMPILES,
                    "ooxmlTarget": "p:graphicFrame / c:chart + embedded xlsx",
                    "html": "native scene JSON only",
                    "sceneType": "chart",
                    "properties": ["chartType", "categories", "series", "seriesColor", "title", "legend"],
                    "effects": [],
                    "timing": all_timing,
                    "gaps": ["comboChart", "scatter", "area", "axisFormatting", "htmlExtraction"],
                },
                "group": {
                    "status": GAP,
                    "ooxmlTarget": "p:grpSp",
                    "html": ".ppt-group is structural only",
                    "sceneType": "group",
                    "properties": [],
                    "effects": [],
                    "timing": [],
                    "gaps": ["groupWriter", "groupLevelEffects", "groupLevelAnimation"],
                    "note": "Until p:grpSp lands, decompose into sibling native objects and sequence their children.",
                },
            },
            "propertyMatrix": {
                "solidFill": {"compilesOn": ["shape", "freeform", "tableCell"], "gapsOn": ["picture", "media", "connector", "chart"]},
                "gradientFill": {"compilesOn": ["shape", "freeform"], "gapsOn": ["tableCell", "picture", "media", "connector", "chart"]},
                "stroke": {"compilesOn": ["shape", "freeform", "connector"], "gapsOn": ["picture", "media", "chart"]},
                "textRuns": {"compilesOn": ["textbox", "shapeText", "tableCell"], "gapsOn": ["chartLabels"]},
                "shadow": {"compilesOn": ["shape", "freeform", "picture", "media"], "gapsOn": ["textbox", "connector", "table", "chart"]},
                "glow": {"compilesOn": ["shape", "freeform", "picture", "media"], "gapsOn": ["textbox", "connector", "table", "chart"]},
                "blur": {"compilesOn": ["shape", "freeform", "picture", "media"], "gapsOn": ["textbox", "connector", "table", "chart"], "notAnimatable": True},
                "reflection": {"compilesOn": ["shape", "freeform", "picture", "media"], "gapsOn": ["textbox", "connector", "table", "chart"]},
                "crop": {"compilesOn": [], "gapsOn": ["picture"]},
                "animation": {"compilesOn": ["textbox", "shape", "freeform", "connector", "picture", "media", "table", "chart"], "gapsOn": ["group"]},
                "textBuild": {"compilesOn": ["textbox"], "gapsOn": ["shapeText", "tableCell"]},
            },
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
                "compose": {
                    "status": COMPILES,
                    "intent": "Combine native fade, motion path, scale, rotation, and fill-color behaviors "
                              "into one concurrent timing node.",
                    "params": ["opacity", "x", "y", "scaleFrom", "scaleTo", "rotateFrom", "rotateTo",
                               "recolor", "dur", "delay", "ease", "repeat", "alt"],
                },
                "sequence": {
                    "status": COMPILES,
                    "attribute": "data-ppt-sequence",
                    "intent": "Expand one container declaration into staggered/overlapped child animations "
                              "without imposing visual style.",
                    "params": ["selector", "gap", "overlap", "dur", "delay", "ease", "x", "y",
                               "scaleFrom", "scaleTo", "rotateFrom", "rotateTo"],
                },
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
