from __future__ import annotations

import json
import base64
import hashlib
import io
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from .ooxml import NS


SLIDE_CX = 12192000
SLIDE_CY = 6858000
PX_W = 1200
PX_H = 675
EMU_PER_PX = 10160

REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PML_CT = "application/vnd.openxmlformats-officedocument.presentationml"

# Single-source capability tables. capabilities.py reflects these so the
# machine-readable manifest can never drift from what the compiler emits.
# `_preset_geom_xml` passes any preset through the identical
# `<a:prstGeom prst="X"><a:avLst/></a:prstGeom>` path, so the full standard OOXML
# ST_ShapeType enum is supported — the agent is never artificially limited to a
# subset. Grouped to mirror the PowerPoint Shapes gallery categories.
_SHAPE_PRESETS: frozenset[str] = frozenset({
    # rectangles
    "rect", "roundRect", "round1Rect", "round2SameRect", "round2DiagRect",
    "snipRoundRect", "snip1Rect", "snip2SameRect", "snip2DiagRect", "plaque", "frame", "halfFrame",
    # basic shapes
    "ellipse", "triangle", "rtTriangle", "parallelogram", "trapezoid", "diamond",
    "pentagon", "hexagon", "heptagon", "octagon", "decagon", "dodecagon",
    "pie", "pieWedge", "chord", "arc", "blockArc", "teardrop", "donut", "noSmoking",
    "corner", "diagStripe", "plus", "can", "cube", "bevel", "foldedCorner",
    "smileyFace", "heart", "lightningBolt", "sun", "moon", "cloud", "arc",
    "leftBracket", "rightBracket", "leftBrace", "rightBrace", "bracketPair", "bracePair",
    "gear6", "gear9", "funnel",
    # block arrows
    "rightArrow", "leftArrow", "upArrow", "downArrow", "leftRightArrow", "upDownArrow",
    "quadArrow", "leftRightUpArrow", "bentArrow", "uturnArrow", "leftUpArrow", "bentUpArrow",
    "curvedRightArrow", "curvedLeftArrow", "curvedUpArrow", "curvedDownArrow",
    "stripedRightArrow", "notchedRightArrow", "homePlate", "chevron", "circularArrow",
    "rightArrowCallout", "leftArrowCallout", "upArrowCallout", "downArrowCallout",
    "leftRightArrowCallout", "quadArrowCallout",
    # equation
    "mathPlus", "mathMinus", "mathMultiply", "mathDivide", "mathEqual", "mathNotEqual",
    # flowchart
    "flowChartProcess", "flowChartDecision", "flowChartInputOutput",
    "flowChartPredefinedProcess", "flowChartInternalStorage", "flowChartDocument",
    "flowChartMultidocument", "flowChartTerminator", "flowChartPreparation",
    "flowChartManualInput", "flowChartManualOperation", "flowChartConnector",
    "flowChartOffpageConnector", "flowChartPunchedCard", "flowChartPunchedTape",
    "flowChartSummingJunction", "flowChartOr", "flowChartCollate", "flowChartSort",
    "flowChartExtract", "flowChartMerge", "flowChartOnlineStorage", "flowChartDelay",
    "flowChartMagneticTape", "flowChartMagneticDisk", "flowChartMagneticDrum",
    "flowChartDisplay",
    # stars & banners
    "star4", "star5", "star6", "star7", "star8", "star10", "star12", "star16",
    "star24", "star32", "irregularSeal1", "irregularSeal2", "ribbon", "ribbon2",
    "ellipseRibbon", "ellipseRibbon2", "verticalScroll", "horizontalScroll",
    "wave", "doubleWave",
    # callouts
    "wedgeRectCallout", "wedgeRoundRectCallout", "wedgeEllipseCallout", "cloudCallout",
    "borderCallout1", "borderCallout2", "borderCallout3",
    "accentCallout1", "accentCallout2", "accentCallout3",
    "callout1", "callout2", "callout3",
    "accentBorderCallout1", "accentBorderCallout2", "accentBorderCallout3",
    # action buttons
    "actionButtonBackPrevious", "actionButtonForwardNext", "actionButtonBeginning",
    "actionButtonEnd", "actionButtonHome", "actionButtonInformation",
    "actionButtonReturn", "actionButtonMovie", "actionButtonDocument",
    "actionButtonSound", "actionButtonHelp", "actionButtonBlank",
    # line
    "line", "lineInv", "straightConnector1",
})
_ARROW_ENDS: frozenset[str] = frozenset({
    "none", "triangle", "stealth", "arrow", "diamond", "oval",
})
_DASH_STYLES: frozenset[str] = frozenset({
    "dash", "dashDot", "lgDash", "lgDashDot", "lgDashDotDot", "sysDash", "sysDot", "dot",
})
_TRANSITION_TYPES: frozenset[str] = frozenset({"fade", "push", "wipe", "split"})
_MORPH_OPTIONS: tuple[str, ...] = ("byObject", "byWord", "byChar")
# Theme color slots. An element fill/stroke/gradient stop may reference a slot by
# name (e.g. "accent1" or "scheme:accent1") instead of a concrete hex, so a single
# theme swap restyles the whole deck — a native-PowerPoint capability HTML lacks.
_SCHEME_TOKENS: frozenset[str] = frozenset({
    "bg1", "tx1", "bg2", "tx2", "dk1", "lt1", "dk2", "lt2",
    "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
    "hlink", "folHlink", "phClr",
})
# Default theme palette: a HUE-NEUTRAL grayscale ramp. The theme1.xml is required
# by the OOXML format, but it must not impose a house style — color is the author's
# decision (via explicit CSS, which is honored verbatim). These neutrals only ever
# surface for unspecified values or theme-token references. Override via scene.theme.colors.
_DEFAULT_THEME_COLORS: dict[str, str] = {
    "dk2": "1F2937", "lt2": "F9FAFB",
    "accent1": "111827", "accent2": "374151", "accent3": "6B7280",
    "accent4": "9CA3AF", "accent5": "D1D5DB", "accent6": "E5E7EB",
    "hlink": "4B5563", "folHlink": "6B7280",
}
_DEFAULT_THEME_FONTS: dict[str, str] = {
    "majorLatin": "Times New Roman", "majorEa": "Songti SC",
    "minorLatin": "Arial", "minorEa": "PingFang SC",
}


def create_deck_from_scene(scene_path: Path, out_dir: Path, overwrite: bool = False) -> dict[str, Any]:
    scene = json.loads(scene_path.read_text(encoding="utf-8"))
    return create_deck(scene, out_dir, overwrite=overwrite)


def create_deck(scene: dict[str, Any], out_dir: Path, overwrite: bool = False) -> dict[str, Any]:
    if out_dir.exists():
        if not overwrite:
            raise FileExistsError(f"Output directory already exists: {out_dir}")
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    size = scene.get("size", {})
    cx = int(size.get("cx", SLIDE_CX))
    cy = int(size.get("cy", SLIDE_CY))
    px_w = float(size.get("pxWidth", PX_W))
    px_h = float(size.get("pxHeight", PX_H))
    slides = scene.get("slides", [])
    if not slides:
        raise ValueError("Scene must contain at least one slide.")

    _infer_morph_keys(scene)

    # Pre-scan charts: each needs its own part + embedded workbook, and the package
    # content types are written up front, so assign a global 1-based index now.
    chart_count = 0
    for slide in slides:
        for element in slide.get("elements", []):
            if isinstance(element, dict) and element.get("type") == "chart":
                chart_count += 1
                element["_chartIndex"] = chart_count

    notes_slides = {i for i, slide in enumerate(slides, 1) if str(slide.get("notes", "")).strip()}

    _write_static_parts(out_dir, scene, cx, cy, len(slides), chart_count, notes_slides)
    slide_reports = []
    losses: list[dict[str, Any]] = []
    for index, slide in enumerate(slides, 1):
        slide_reports.append(_write_slide(out_dir, index, slide, cx, cy, px_w, px_h, losses))

    animation_effects = sum(int(report.get("animationEffects", 0)) for report in slide_reports)
    return {
        "ok": True,
        "out": str(out_dir),
        "slides": len(slides),
        "slideSizeEmu": {"cx": cx, "cy": cy},
        "animations": {
            "slidesWithTiming": [report["slide"] for report in slide_reports if report.get("animationEffects")],
            "effects": animation_effects,
        },
        "losses": losses,
    }


def _morph_identity(element: dict[str, Any]) -> str | None:
    """Stable cross-slide identity of an element, for Morph matching."""
    source = element.get("source")
    if isinstance(source, dict) and source.get("key"):
        return str(source["key"])
    if isinstance(source, str) and source:
        return source
    for key in ("morphKey", "morphId", "objectKey", "name", "id"):
        value = element.get(key)
        if value:
            return str(value)
    return None


def _infer_morph_keys(scene: dict[str, Any]) -> None:
    """Auto-assign shared morphKeys to objects that persist across adjacent
    slides, so PowerPoint smooth-morphs them (e.g. HTML step diffs).

    Gated by scene-level ``autoMorph`` (or per-slide ``autoMorph``) so explicit
    scenes are never altered silently.
    """
    slides = scene.get("slides", [])
    scene_flag = bool(scene.get("autoMorph"))
    for i in range(1, len(slides)):
        if not (scene_flag or slides[i].get("autoMorph")):
            continue
        prev_by_id: dict[str, dict[str, Any]] = {}
        for element in slides[i - 1].get("elements", []):
            ident = _morph_identity(element)
            if ident:
                prev_by_id.setdefault(ident, element)
        matched = 0
        for element in slides[i].get("elements", []):
            ident = _morph_identity(element)
            if not ident or ident not in prev_by_id:
                continue
            morph_key = f"auto:{ident}"
            element.setdefault("morphKey", morph_key)
            prev_by_id[ident].setdefault("morphKey", morph_key)
            matched += 1
        if matched and not slides[i].get("transition"):
            slides[i]["transition"] = {"type": "morph", "option": "byObject"}


def _xml_header(body: str) -> str:
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + body


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _rel_xml(rels: list[tuple[str, str, str, str | None]]) -> str:
    rows = []
    for rid, rel_type, target, mode in rels:
        attrs = f'Id="{_e(rid)}" Type="{_e(rel_type)}" Target="{_e(target)}"'
        if mode:
            attrs += f' TargetMode="{_e(mode)}"'
        rows.append(f"  <Relationship {attrs}/>")
    return _xml_header(f'<Relationships xmlns="{REL_NS}">\n' + "\n".join(rows) + "\n</Relationships>\n")


def _write_static_parts(root: Path, scene: dict[str, Any], cx: int, cy: int, slide_count: int, chart_count: int = 0, notes_slides: set[int] | None = None) -> None:
    notes_slides = notes_slides or set()
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    title = scene.get("title", "PPTX Native Deck")

    overrides = [
        ("/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"),
        ("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"),
        ("/ppt/presentation.xml", f"{PML_CT}.presentation.main+xml"),
        ("/ppt/slideMasters/slideMaster1.xml", f"{PML_CT}.slideMaster+xml"),
        ("/ppt/slideLayouts/slideLayout1.xml", f"{PML_CT}.slideLayout+xml"),
        ("/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"),
    ]
    overrides.extend((f"/ppt/slides/slide{i}.xml", f"{PML_CT}.slide+xml") for i in range(1, slide_count + 1))
    overrides.extend(
        (f"/ppt/charts/chart{n}.xml",
         "application/vnd.openxmlformats-officedocument.drawingml.chart+xml")
        for n in range(1, chart_count + 1)
    )
    if notes_slides:
        overrides.append(("/ppt/notesMasters/notesMaster1.xml", f"{PML_CT}.notesMaster+xml"))
        overrides.extend(
            (f"/ppt/notesSlides/notesSlide{i}.xml", f"{PML_CT}.notesSlide+xml")
            for i in sorted(notes_slides)
        )
    override_xml = "\n".join(
        f'  <Override PartName="{part}" ContentType="{ct}"/>' for part, ct in overrides
    )
    xlsx_default = (
        '  <Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>\n'
        if chart_count else ""
    )
    _write(
        root / "[Content_Types].xml",
        _xml_header(
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
            '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
            '  <Default Extension="xml" ContentType="application/xml"/>\n'
            '  <Default Extension="jpg" ContentType="image/jpeg"/>\n'
            '  <Default Extension="jpeg" ContentType="image/jpeg"/>\n'
            '  <Default Extension="png" ContentType="image/png"/>\n'
            '  <Default Extension="gif" ContentType="image/gif"/>\n'
            f"{xlsx_default}"
            f"{override_xml}\n"
            "</Types>\n"
        ),
    )

    _write(
        root / "_rels/.rels",
        _rel_xml(
            [
                ("rId1", f"{OFFICE_REL}/officeDocument", "ppt/presentation.xml", None),
                ("rId2", f"{OFFICE_REL}/metadata/core-properties", "docProps/core.xml", None),
                ("rId3", f"{OFFICE_REL}/extended-properties", "docProps/app.xml", None),
            ]
        ),
    )
    _write(
        root / "docProps/core.xml",
        _xml_header(
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
            f"  <dc:title>{_e(title)}</dc:title>\n"
            "  <dc:creator>pptx_native</dc:creator>\n"
            "  <cp:lastModifiedBy>pptx_native</cp:lastModifiedBy>\n"
            f'  <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>\n'
            f'  <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>\n'
            "</cp:coreProperties>\n"
        ),
    )
    _write(
        root / "docProps/app.xml",
        _xml_header(
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
            'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">\n'
            "  <Application>pptx_native</Application>\n"
            "  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>\n"
            f"  <Slides>{slide_count}</Slides>\n"
            "  <Notes>0</Notes>\n"
            "  <HiddenSlides>0</HiddenSlides>\n"
            "  <MMClips>0</MMClips>\n"
            "  <ScaleCrop>false</ScaleCrop>\n"
            "  <HeadingPairs><vt:vector size=\"2\" baseType=\"variant\"><vt:variant><vt:lpstr>Slides</vt:lpstr></vt:variant><vt:variant><vt:i4>"
            f"{slide_count}</vt:i4></vt:variant></vt:vector></HeadingPairs>\n"
            f"  <TitlesOfParts><vt:vector size=\"{slide_count}\" baseType=\"lpstr\">"
            + "".join(f"<vt:lpstr>Slide {i}</vt:lpstr>" for i in range(1, slide_count + 1))
            + "</vt:vector></TitlesOfParts>\n"
            "  <Company></Company>\n"
            "  <LinksUpToDate>false</LinksUpToDate>\n"
            "  <SharedDoc>false</SharedDoc>\n"
            "  <HyperlinksChanged>false</HyperlinksChanged>\n"
            "  <AppVersion>16.0000</AppVersion>\n"
            "</Properties>\n"
        ),
    )

    pres_rels = [("rId1", f"{OFFICE_REL}/slideMaster", "slideMasters/slideMaster1.xml", None)]
    pres_rels.extend(
        (f"rId{i + 1}", f"{OFFICE_REL}/slide", f"slides/slide{i}.xml", None)
        for i in range(1, slide_count + 1)
    )
    notes_master_idlst = ""
    if notes_slides:
        notes_rid = f"rId{slide_count + 2}"
        pres_rels.append((notes_rid, f"{OFFICE_REL}/notesMaster", "notesMasters/notesMaster1.xml", None))
        notes_master_idlst = (
            "  <p:notesMasterIdLst>\n"
            f'    <p:notesMasterId r:id="{notes_rid}"/>\n'
            "  </p:notesMasterIdLst>\n"
        )
        _write_notes_master(root)
    _write(root / "ppt/_rels/presentation.xml.rels", _rel_xml(pres_rels))

    slide_ids = "\n".join(
        f'    <p:sldId id="{255 + i}" r:id="rId{i + 1}"/>' for i in range(1, slide_count + 1)
    )
    _write(
        root / "ppt/presentation.xml",
        _xml_header(
            f'<p:presentation xmlns:a="{NS["a"]}" xmlns:r="{NS["r"]}" xmlns:p="{NS["p"]}" saveSubsetFonts="1">\n'
            '  <p:sldMasterIdLst>\n'
            '    <p:sldMasterId id="2147483648" r:id="rId1"/>\n'
            "  </p:sldMasterIdLst>\n"
            f"{notes_master_idlst}"
            "  <p:sldIdLst>\n"
            f"{slide_ids}\n"
            "  </p:sldIdLst>\n"
            f'  <p:sldSz cx="{cx}" cy="{cy}" type="screen16x9"/>\n'
            '  <p:notesSz cx="6858000" cy="9144000"/>\n'
            f"{_default_text_style()}\n"
            "</p:presentation>\n"
        ),
    )

    _write(root / "ppt/slideMasters/_rels/slideMaster1.xml.rels", _rel_xml(
        [
            ("rId1", f"{OFFICE_REL}/slideLayout", "../slideLayouts/slideLayout1.xml", None),
            ("rId2", f"{OFFICE_REL}/theme", "../theme/theme1.xml", None),
        ]
    ))
    _write(root / "ppt/slideLayouts/_rels/slideLayout1.xml.rels", _rel_xml(
        [("rId1", f"{OFFICE_REL}/slideMaster", "../slideMasters/slideMaster1.xml", None)]
    ))
    _write(root / "ppt/slideMasters/slideMaster1.xml", _slide_master_xml())
    _write(root / "ppt/slideLayouts/slideLayout1.xml", _slide_layout_xml())
    _write(root / "ppt/theme/theme1.xml", _theme_xml(scene.get("theme")))


def _write_slide(root: Path, index: int, slide: dict[str, Any], cx: int, cy: int, px_w: float, px_h: float, losses: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    sx = cx / px_w
    sy = cy / px_h
    shapes = []
    shape_id = 2
    target_map: dict[str, list[int]] = {}
    shape_ids: set[int] = set()
    paragraph_counts: dict[int, int] = {}
    rels = [("rId1", f"{OFFICE_REL}/slideLayout", "../slideLayouts/slideLayout1.xml", None)]
    media_index = 1

    bg = slide.get("background", "FFFFFF")
    if bg:
        shapes.append(
            _shape_xml(
                shape_id,
                "Background",
                "rect",
                0,
                0,
                cx,
                cy,
                fill=str(bg),
                line={"fill": str(bg), "width": 0},
            )
        )
        _register_target(target_map, "background", shape_id)
        _register_target(target_map, "slide/background", shape_id)
        shape_ids.add(shape_id)
        shape_id += 1

    for element in slide.get("elements", []):
        start_shape_id = shape_id
        name = _element_name(element, shape_id, "Image" if element.get("type") == "image" else "Shape")
        if element.get("type") == "image":
            rid = f"rId{len(rels) + 1}"
            element_xml, shape_id, media_name = _image_element_xml(
                root,
                index,
                media_index,
                shape_id,
                element,
                sx,
                sy,
                rid,
            )
            if element_xml and media_name:
                rels.append((rid, f"{OFFICE_REL}/image", f"../media/{media_name}", None))
                media_index += 1
        elif element.get("type") == "chart":
            rid = f"rId{len(rels) + 1}"
            chart_n = int(element.get("_chartIndex", 1))
            element_xml = _chart_element_xml(root, chart_n, shape_id, name, element, sx, sy, rid)
            if element_xml:
                rels.append((rid, f"{OFFICE_REL}/chart", f"../charts/chart{chart_n}.xml", None))
                shape_id += 1
        else:
            element_xml, shape_id = _element_xml(shape_id, element, sx, sy)
        if element_xml:
            shapes.append(element_xml)
            emitted_ids = list(range(start_shape_id, shape_id))
            shape_ids.update(emitted_ids)
            _register_element_targets(target_map, element, name, emitted_ids)
            if len(emitted_ids) == 1 and element.get("type") != "image":
                paragraph_counts[emitted_ids[0]] = _paragraph_count(element)

    transition = _transition_xml(slide.get("transition"))
    timing, animation_effects = _timing_xml(
        slide.get("animations"), target_map, shape_ids, paragraph_counts,
        losses=losses, slide_index=index,
    )
    name = slide.get("name", f"Slide {index}")
    _write(
        root / f"ppt/slides/slide{index}.xml",
        _xml_header(
            f'<p:sld xmlns:a="{NS["a"]}" xmlns:r="{NS["r"]}" xmlns:p="{NS["p"]}">\n'
            f'  <p:cSld name="{_e(name)}">\n'
            "    <p:spTree>\n"
            "      <p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\n"
            "      <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>\n"
            + "\n".join(shapes)
            + "\n"
            "    </p:spTree>\n"
            "  </p:cSld>\n"
            "  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>\n"
            f"{transition}"
            f"{timing}"
            "</p:sld>\n"
        ),
    )
    notes_text = str(slide.get("notes", "")).strip()
    if notes_text:
        notes_rid = f"rId{len(rels) + 1}"
        rels.append((notes_rid, f"{OFFICE_REL}/notesSlide", f"../notesSlides/notesSlide{index}.xml", None))
        _write(root / f"ppt/notesSlides/notesSlide{index}.xml", _notes_slide_xml(notes_text))
        _write(
            root / f"ppt/notesSlides/_rels/notesSlide{index}.xml.rels",
            _rel_xml([
                (f"rId1", f"{OFFICE_REL}/slide", f"../slides/slide{index}.xml", None),
                (f"rId2", f"{OFFICE_REL}/notesMaster", "../notesMasters/notesMaster1.xml", None),
            ]),
        )

    _write(
        root / f"ppt/slides/_rels/slide{index}.xml.rels",
        _rel_xml(rels),
    )
    return {"slide": index, "animationEffects": animation_effects}


def _image_element_xml(
    root: Path,
    slide_index: int,
    media_index: int,
    shape_id: int,
    element: dict[str, Any],
    sx: float,
    sy: float,
    rid: str,
) -> tuple[str | None, int, str | None]:
    parsed = _parse_data_image(element.get("src") or element.get("dataUri"))
    if not parsed:
        return None, shape_id, None
    ext, data = parsed
    media_name = f"image{slide_index}_{media_index}.{ext}"
    media_path = root / "ppt/media" / media_name
    media_path.parent.mkdir(parents=True, exist_ok=True)
    media_path.write_bytes(data)
    name = _element_name(element, shape_id, "Image")
    x = _emu(element.get("x", 0), sx)
    y = _emu(element.get("y", 0), sy)
    cx = _emu(element.get("w", element.get("cx", 100)), sx)
    cy = _emu(element.get("h", element.get("cy", 100)), sy)
    rot = _rotation_attr(element.get("rotation")) + _flip_attr(
        bool(element.get("flipH")), bool(element.get("flipV")))
    xml = (
        "      <p:pic>\n"
        f'        <p:nvPicPr><p:cNvPr id="{shape_id}" name="{_e(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="0"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>\n'
        f'        <p:blipFill><a:blip r:embed="{_e(rid)}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>\n'
        "        <p:spPr>\n"
        f'          <a:xfrm{rot}><a:off x="{x}" y="{y}"/><a:ext cx="{max(cx, 1)}" cy="{max(cy, 1)}"/></a:xfrm>\n'
        '          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>\n'
        f"{_shadow_xml(_scene_shadow(element.get('shadow'), sx), 10)}"
        "        </p:spPr>\n"
        "      </p:pic>"
    )
    return xml, shape_id + 1, media_name


def _parse_data_image(src: Any) -> tuple[str, bytes] | None:
    text = str(src or "")
    if not text.startswith("data:image/"):
        return None
    header, _, payload = text.partition(",")
    if not payload or ";base64" not in header:
        return None
    mime = header[5:].split(";", 1)[0].lower()
    ext = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
    }.get(mime)
    if not ext:
        return None
    try:
        return ext, base64.b64decode(payload)
    except ValueError:
        return None


_XLSX_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
_SS_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"


def _col_letter(index: int) -> str:
    """0-based column index -> spreadsheet column letters (0->A, 26->AA)."""
    result = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        result = chr(65 + rem) + result
    return result


def _chart_num(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _str_cache(values: list[Any]) -> str:
    pts = "".join(f'<c:pt idx="{i}"><c:v>{_e(str(v))}</c:v></c:pt>' for i, v in enumerate(values))
    return f'<c:strCache><c:ptCount val="{len(values)}"/>{pts}</c:strCache>'


def _num_cache(values: list[Any]) -> str:
    pts = "".join(f'<c:pt idx="{i}"><c:v>{_chart_num(v):g}</c:v></c:pt>' for i, v in enumerate(values))
    return f'<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="{len(values)}"/>{pts}</c:numCache>'


def _chart_series_xml(idx: int, name: Any, categories: list[Any], values: list[Any], sheet: str, color: Any) -> str:
    n = len(categories)
    val_col = _col_letter(idx + 1)
    color_xml = f"<c:spPr><a:solidFill>{_color_xml(color)}</a:solidFill></c:spPr>" if color else ""
    return (
        "<c:ser>"
        f'<c:idx val="{idx}"/><c:order val="{idx}"/>'
        f"<c:tx><c:strRef><c:f>{sheet}!${val_col}$1</c:f>"
        f'<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>{_e(str(name))}</c:v></c:pt></c:strCache></c:strRef></c:tx>'
        f"{color_xml}"
        f"<c:cat><c:strRef><c:f>{sheet}!$A$2:$A${n + 1}</c:f>{_str_cache(categories)}</c:strRef></c:cat>"
        f"<c:val><c:numRef><c:f>{sheet}!${val_col}$2:${val_col}${n + 1}</c:f>{_num_cache(values)}</c:numRef></c:val>"
        "</c:ser>"
    )


def _cat_val_axes(ax1: int, ax2: int) -> str:
    return (
        f'<c:catAx><c:axId val="{ax1}"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
        f'<c:delete val="0"/><c:axPos val="b"/><c:crossAx val="{ax2}"/></c:catAx>'
        f'<c:valAx><c:axId val="{ax2}"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
        f'<c:delete val="0"/><c:axPos val="l"/><c:crossAx val="{ax1}"/></c:valAx>'
    )


def _chart_xml(element: dict[str, Any], embed_rid: str) -> str:
    ctype = str(element.get("chartType", "bar")).strip().lower()
    categories = [str(c) for c in element.get("categories", [])]
    series = [s for s in element.get("series", []) if isinstance(s, dict)]
    sheet = "Sheet1"
    ser_xml = "".join(
        _chart_series_xml(i, s.get("name", f"Series {i + 1}"), categories, s.get("values", []), sheet, s.get("color"))
        for i, s in enumerate(series)
    )
    ax1, ax2 = 111111111, 222222222
    if ctype in {"pie", "doughnut", "donut"}:
        plot = f'<c:pieChart><c:varyColors val="1"/>{ser_xml}<c:firstSliceAng val="0"/></c:pieChart>'
    elif ctype == "line":
        plot = (
            f'<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>{ser_xml}'
            f'<c:marker val="1"/><c:axId val="{ax1}"/><c:axId val="{ax2}"/></c:lineChart>'
            + _cat_val_axes(ax1, ax2)
        )
    else:  # bar / column
        bar_dir = "bar" if ctype in {"barh", "hbar"} else "col"
        plot = (
            f'<c:barChart><c:barDir val="{bar_dir}"/><c:grouping val="clustered"/><c:varyColors val="0"/>{ser_xml}'
            f'<c:gapWidth val="150"/><c:axId val="{ax1}"/><c:axId val="{ax2}"/></c:barChart>'
            + _cat_val_axes(ax1, ax2)
        )
    title = element.get("title")
    if title:
        title_xml = (
            "<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>"
            f"<a:p><a:r><a:t>{_e(str(title))}</a:t></a:r></a:p></c:rich></c:tx>"
            '<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>'
        )
    else:
        title_xml = '<c:autoTitleDeleted val="1"/>'
    legend_xml = (
        '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>'
        if element.get("legend", True) else ""
    )
    return (
        f'<c:chartSpace xmlns:c="{_C_NS}" xmlns:a="{NS["a"]}" xmlns:r="{NS["r"]}">\n'
        f"  <c:chart>{title_xml}<c:plotArea><c:layout/>{plot}</c:plotArea>"
        f'{legend_xml}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>\n'
        f'  <c:externalData r:id="{_e(embed_rid)}"><c:autoUpdate val="0"/></c:externalData>\n'
        "</c:chartSpace>\n"
    )


def _build_chart_workbook(categories: list[Any], series: list[dict[str, Any]]) -> bytes:
    """A minimal valid .xlsx so PowerPoint's "Edit Data" opens the chart's source."""
    def cell(ref: str, value: Any, is_text: bool) -> str:
        if value is None or value == "":
            return ""
        if is_text:
            return f'<c r="{ref}" t="inlineStr"><is><t>{_e(str(value))}</t></is></c>'
        return f'<c r="{ref}"><v>{_chart_num(value):g}</v></c>'

    rows = []
    header = cell("A1", "", True)
    for j, s in enumerate(series):
        header += cell(f"{_col_letter(j + 1)}1", s.get("name", f"Series {j + 1}"), True)
    rows.append(f'<row r="1">{header}</row>')
    for i, catv in enumerate(categories):
        r = i + 2
        line = cell(f"A{r}", catv, True)
        for j, s in enumerate(series):
            vals = s.get("values", [])
            line += cell(f"{_col_letter(j + 1)}{r}", vals[i] if i < len(vals) else None, False)
        rows.append(f'<row r="{r}">{line}</row>')
    sheet_xml = (
        _XLSX_DECL + f'<worksheet xmlns="{_SS_NS}"><sheetData>' + "".join(rows) + "</sheetData></worksheet>"
    )
    parts = {
        "[Content_Types].xml": (
            _XLSX_DECL
            + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            _XLSX_DECL
            + f'<Relationships xmlns="{_PKG_REL_NS}">'
            f'<Relationship Id="rId1" Type="{OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>"
        ),
        "xl/workbook.xml": (
            _XLSX_DECL
            + f'<workbook xmlns="{_SS_NS}" xmlns:r="{NS["r"]}">'
            '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": (
            _XLSX_DECL
            + f'<Relationships xmlns="{_PKG_REL_NS}">'
            f'<Relationship Id="rId1" Type="{OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/>'
            "</Relationships>"
        ),
        "xl/worksheets/sheet1.xml": sheet_xml,
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in parts.items():
            zf.writestr(name, content)
    return buffer.getvalue()


def _chart_element_xml(root: Path, n: int, shape_id: int, name: str, element: dict[str, Any], sx: float, sy: float, rid: str) -> str | None:
    categories = [str(c) for c in element.get("categories", [])]
    series = [s for s in element.get("series", []) if isinstance(s, dict)]
    if not categories or not series:
        return None
    embed_rid = "rId1"
    _write(root / f"ppt/charts/chart{n}.xml", _xml_header(_chart_xml(element, embed_rid)))
    _write(
        root / f"ppt/charts/_rels/chart{n}.xml.rels",
        _rel_xml([(embed_rid, f"{OFFICE_REL}/package", f"../embeddings/Microsoft_Excel_Sheet{n}.xlsx", None)]),
    )
    workbook_path = root / f"ppt/embeddings/Microsoft_Excel_Sheet{n}.xlsx"
    workbook_path.parent.mkdir(parents=True, exist_ok=True)
    workbook_path.write_bytes(_build_chart_workbook(categories, series))

    x, y = _emu(element.get("x", 0), sx), _emu(element.get("y", 0), sy)
    w = max(1, _emu(element.get("w", element.get("cx", 100)), sx))
    h = max(1, _emu(element.get("h", element.get("cy", 100)), sy))
    return (
        "      <p:graphicFrame>\n"
        f'        <p:nvGraphicFramePr><p:cNvPr id="{shape_id}" name="{_e(name)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>\n'
        f'        <p:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></p:xfrm>\n'
        '        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
        f'<c:chart xmlns:c="{_C_NS}" xmlns:r="{NS["r"]}" r:id="{_e(rid)}"/>'
        "</a:graphicData></a:graphic>\n"
        "      </p:graphicFrame>"
    )


def _element_xml(shape_id: int, element: dict[str, Any], sx: float, sy: float) -> tuple[str | None, int]:
    kind = element.get("type", "shape")
    name = _element_name(element, shape_id, "Shape")
    if kind == "table":
        return _table_xml(shape_id, name, element, sx, sy), shape_id + 1
    if kind == "line":
        xml = _line_xml(
            shape_id,
            name,
            _emu(element.get("x1", 0), sx),
            _emu(element.get("y1", 0), sy),
            _emu(element.get("x2", 0), sx),
            _emu(element.get("y2", 0), sy),
            line=element.get("line", {}),
            arrow=bool(element.get("arrow", False)),
        )
        return xml, shape_id + 1
    if kind == "text":
        xml = _shape_xml(
            shape_id,
            name,
            "rect",
            _emu(element.get("x", 0), sx),
            _emu(element.get("y", 0), sy),
            _emu(element.get("w", element.get("cx", 100)), sx),
            _emu(element.get("h", element.get("cy", 40)), sy),
            fill=None,
            line={"fill": None, "width": 0},
            text=element.get("text", ""),
            text_style=element,
            rotation=element.get("rotation"),
        )
        return xml, shape_id + 1
    if kind == "polyline":
        points = element.get("points", [])
        if len(points) < 2:
            return None, shape_id
        rows = []
        for idx, (a, b) in enumerate(zip(points, points[1:])):
            rows.append(
                _line_xml(
                    shape_id + idx,
                    f"{name} {idx + 1}",
                    _emu(a[0], sx),
                    _emu(a[1], sy),
                    _emu(b[0], sx),
                    _emu(b[1], sy),
                    line=element.get("line", {}),
                    arrow=bool(element.get("arrow", False) and idx == len(points) - 2),
                )
            )
        return "\n".join(rows), shape_id + len(rows)
    if kind in {"freeform", "polygon", "path"}:
        pts = element.get("points", [])
        emu_pts = [(_emu(p[0], sx), _emu(p[1], sy)) for p in pts if len(p) >= 2]
        if len(emu_pts) < 2:
            return None, shape_id
        closed = bool(element.get("closed", element.get("fill") is not None or kind == "polygon"))
        xml = _freeform_xml(
            shape_id,
            name,
            emu_pts,
            closed=closed,
            fill=element.get("fill") if (closed or element.get("fill")) else None,
            fill_alpha=element.get("fillAlpha", element.get("opacity", 1)),
            fill_gradient=element.get("fillGradient"),
            line=element.get("line", {"fill": None, "width": 0}),
            shadow=_scene_shadow(element.get("shadow"), sx),
            glow=_scene_glow(element.get("glow"), sx),
        )
        return xml, shape_id + 1
    preset = str(element.get("shape", "rect"))
    radius_adj = _round_rect_adj(element) if preset == "roundRect" else None
    xml = _shape_xml(
        shape_id,
        name,
        preset,
        _emu(element.get("x", 0), sx),
        _emu(element.get("y", 0), sy),
        _emu(element.get("w", element.get("cx", 100)), sx),
        _emu(element.get("h", element.get("cy", 40)), sy),
        fill=element.get("fill", "FFFFFF"),
        fill_alpha=element.get("fillAlpha", element.get("opacity", 1)),
        fill_gradient=element.get("fillGradient"),
        line=element.get("line", {"fill": "D9E2EC", "width": 1}),
        shadow=_scene_shadow(element.get("shadow"), sx),
        glow=_scene_glow(element.get("glow"), sx),
        radius_adj=radius_adj,
        text=element.get("text"),
        text_style=element,
        rotation=element.get("rotation"),
        flip_h=bool(element.get("flipH")),
        flip_v=bool(element.get("flipV")),
        blur=_scene_blur(element.get("blur"), sx),
        reflection=_scene_reflection(element.get("reflection"), sx),
    )
    return xml, shape_id + 1


def _shape_xml(
    shape_id: int,
    name: str,
    preset: str,
    x: int,
    y: int,
    cx: int,
    cy: int,
    *,
    fill: str | None,
    line: dict[str, Any] | None,
    fill_alpha: Any = 1,
    fill_gradient: Any = None,
    shadow: dict[str, Any] | None = None,
    glow: dict[str, Any] | None = None,
    radius_adj: int | None = None,
    text: str | None = None,
    text_style: dict[str, Any] | None = None,
    rotation: Any = None,
    flip_h: bool = False,
    flip_v: bool = False,
    blur: dict[str, Any] | None = None,
    reflection: dict[str, Any] | None = None,
) -> str:
    rot = _rotation_attr(rotation) + _flip_attr(flip_h, flip_v)
    sp_pr = (
        "        <p:spPr>\n"
        f'          <a:xfrm{rot}><a:off x="{x}" y="{y}"/><a:ext cx="{max(cx, 1)}" cy="{max(cy, 1)}"/></a:xfrm>\n'
        f"{_preset_geom_xml(preset, radius_adj, 10)}"
        f"{_fill_xml(fill, 10, alpha=fill_alpha, gradient=fill_gradient)}"
        f"{_line_xml_inner(line, 10)}"
        f"{_effects_xml(shadow, glow, 10, blur=blur, reflection=reflection)}"
        "        </p:spPr>\n"
    )
    tx = _text_body(text, text_style or {}) if text is not None else ""
    return (
        "      <p:sp>\n"
        f'        <p:nvSpPr><p:cNvPr id="{shape_id}" name="{_e(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>\n'
        f"{sp_pr}"
        f"{tx}"
        "      </p:sp>"
    )


def _freeform_xml(
    shape_id: int,
    name: str,
    emu_pts: list[tuple[int, int]],
    *,
    closed: bool,
    fill: str | None,
    fill_alpha: Any = 1,
    fill_gradient: Any = None,
    line: dict[str, Any] | None = None,
    shadow: dict[str, Any] | None = None,
    glow: dict[str, Any] | None = None,
) -> str:
    """Emit a native custom-geometry (custGeom) freeform from sampled points.

    Coordinates are made relative to the shape bounding box, which is the path's
    own coordinate space (w/h = ext in EMU).
    """
    xs = [p[0] for p in emu_pts]
    ys = [p[1] for p in emu_pts]
    min_x, min_y = min(xs), min(ys)
    w = max(max(xs) - min_x, 1)
    h = max(max(ys) - min_y, 1)
    rel = [(px - min_x, py - min_y) for px, py in emu_pts]
    moves = [f'<a:moveTo><a:pt x="{rel[0][0]}" y="{rel[0][1]}"/></a:moveTo>']
    for px, py in rel[1:]:
        moves.append(f'<a:lnTo><a:pt x="{px}" y="{py}"/></a:lnTo>')
    if closed:
        moves.append("<a:close/>")
    path = f'<a:path w="{w}" h="{h}">' + "".join(moves) + "</a:path>"
    geom = (
        "          <a:custGeom>\n"
        "            <a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>\n"
        f'            <a:rect l="0" t="0" r="{w}" b="{h}"/>\n'
        f"            <a:pathLst>{path}</a:pathLst>\n"
        "          </a:custGeom>\n"
    )
    sp_pr = (
        "        <p:spPr>\n"
        f'          <a:xfrm><a:off x="{min_x}" y="{min_y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>\n'
        f"{geom}"
        f"{_fill_xml(fill, 10, alpha=fill_alpha, gradient=fill_gradient)}"
        f"{_line_xml_inner(line, 10)}"
        f"{_effects_xml(shadow, glow, 10)}"
        "        </p:spPr>\n"
    )
    return (
        "      <p:sp>\n"
        f'        <p:nvSpPr><p:cNvPr id="{shape_id}" name="{_e(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>\n'
        f"{sp_pr}"
        "      </p:sp>"
    )


def _line_xml(shape_id: int, name: str, x1: int, y1: int, x2: int, y2: int, *, line: dict[str, Any], arrow: bool) -> str:
    x = min(x1, x2)
    y = min(y1, y2)
    cx = max(abs(x2 - x1), 1)
    cy = max(abs(y2 - y1), 1)
    flip_h = ' flipH="1"' if x2 < x1 else ""
    flip_v = ' flipV="1"' if y2 < y1 else ""
    return (
        "      <p:cxnSp>\n"
        f'        <p:nvCxnSpPr><p:cNvPr id="{shape_id}" name="{_e(name)}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>\n'
        "        <p:spPr>\n"
        f'          <a:xfrm{flip_h}{flip_v}><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>\n'
        '          <a:prstGeom prst="line"><a:avLst/></a:prstGeom>\n'
        f"{_line_xml_inner(line, 10, arrow=arrow)}"
        "        </p:spPr>\n"
        "      </p:cxnSp>"
    )


def _round_rect_adj(element: dict[str, Any]) -> int | None:
    try:
        radius = float(element.get("radiusPx", 0))
        width = float(element.get("w", element.get("cx", 0)))
        height = float(element.get("h", element.get("cy", 0)))
    except (TypeError, ValueError):
        return None
    min_dim = min(width, height)
    if radius <= 0 or min_dim <= 0:
        return None
    return max(0, min(50000, int(round((radius / min_dim) * 100000))))


def _preset_geom_xml(preset: str, radius_adj: int | None, indent: int) -> str:
    pad = " " * indent
    if preset == "roundRect" and radius_adj is not None:
        return (
            f'{pad}<a:prstGeom prst="{_e(preset)}">'
            f'<a:avLst><a:gd name="adj" fmla="val {radius_adj}"/></a:avLst>'
            "</a:prstGeom>\n"
        )
    return f'{pad}<a:prstGeom prst="{_e(preset)}"><a:avLst/></a:prstGeom>\n'


_VALIGN_CODES = {"top": "t", "t": "t", "mid": "ctr", "middle": "ctr", "center": "ctr",
                 "ctr": "ctr", "bottom": "b", "b": "b"}


def _cell_txbody(text: Any, style: dict[str, Any]) -> str:
    """Cell text body in the a: namespace (a:tbl cells use a:txBody, not p:txBody)."""
    align = {"left": "l", "center": "ctr", "right": "r"}.get(str(style.get("align", "left")), "l")
    valign = _VALIGN_CODES.get(str(style.get("valign", "ctr")), "ctr")
    p_pr = _paragraph_pr(align, style)
    runs = style.get("runs")
    if isinstance(runs, list) and runs:
        body = "".join(_run_xml(run, style) for run in runs)
        paras = [f"<a:p>{p_pr}{body}</a:p>"]
    else:
        font_size = int(float(style.get("fontSize", 16)) * 100)
        color = _hex(style.get("color", "1F2937"))
        bold = ' b="1"' if style.get("bold") else ""
        italic = ' i="1"' if style.get("italic") else ""
        latin = style.get("latinFont", "Times New Roman")
        ea = style.get("font", style.get("eastAsianFont", "Songti SC"))
        paras = []
        for paragraph in (str(text).split("\n") or [""]):
            paras.append(
                f"<a:p>{p_pr}<a:r><a:rPr lang=\"zh-CN\" sz=\"{font_size}\"{bold}{italic}>"
                f"<a:solidFill>{_srgb_xml(color)}</a:solidFill>"
                f'<a:latin typeface="{_e(str(latin))}"/><a:ea typeface="{_e(str(ea))}"/><a:cs typeface="{_e(str(latin))}"/>'
                f"</a:rPr><a:t>{_e(paragraph)}</a:t></a:r></a:p>"
            )
    return f"<a:txBody><a:bodyPr anchor=\"{valign}\"/><a:lstStyle/>{''.join(paras)}</a:txBody>"


def _table_xml(shape_id: int, name: str, element: dict[str, Any], sx: float, sy: float) -> str | None:
    # Normalize rows: each row is [cell,...] or {cells:[...], height:px}.
    norm_rows: list[tuple[list[Any], Any]] = []
    for row in element.get("rows", []):
        if isinstance(row, dict):
            cells, height = row.get("cells", []), row.get("height")
        else:
            cells, height = row, None
        norm_rows.append((cells if isinstance(cells, list) else [], height))
    if not norm_rows:
        return None
    ncols = max((len(c) for c, _ in norm_rows), default=0)
    if ncols == 0:
        return None

    x, y = _emu(element.get("x", 0), sx), _emu(element.get("y", 0), sy)
    total_w = _emu(element.get("w", element.get("cx", 100)), sx)
    total_h = _emu(element.get("h", element.get("cy", 40)), sy)
    cols = element.get("columns")
    if isinstance(cols, list) and len(cols) == ncols:
        col_w = [max(1, _emu(c, sx)) for c in cols]
    else:
        base = max(1, total_w // ncols)
        col_w = [base] * ncols
        col_w[-1] = max(1, total_w - base * (ncols - 1))

    default_fs = element.get("fontSize", 16)
    header_fill = element.get("headerFill")
    header_color = element.get("headerColor", "FFFFFF")
    row_fill = element.get("rowFill")
    body_color = element.get("color", "1F2937")
    border = element.get("borderColor")
    border_xml = ""
    if border:
        ln = f'<a:ln w="12700" cap="flat"><a:solidFill>{_color_xml(border)}</a:solidFill></a:ln>'
        border_xml = f'<a:lnL>{ln}</a:lnL><a:lnR>{ln}</a:lnR><a:lnT>{ln}</a:lnT><a:lnB>{ln}</a:lnB>'

    nrows = len(norm_rows)
    tr_rows = []
    total_h_used = 0
    for ri, (cells, height) in enumerate(norm_rows):
        h = _emu(height, sy) if height is not None else max(1, total_h // nrows)
        total_h_used += h
        is_header_row = ri == 0 and header_fill is not None
        tcs = []
        for ci in range(ncols):
            cell = cells[ci] if ci < len(cells) else ""
            cstyle = cell if isinstance(cell, dict) else {}
            ctext = cell.get("text", "") if isinstance(cell, dict) else cell
            fill = cstyle.get("fill", header_fill if is_header_row else row_fill)
            color = cstyle.get("color", header_color if is_header_row else body_color)
            style = {
                "color": color,
                "bold": cstyle.get("bold", is_header_row),
                "italic": cstyle.get("italic", False),
                "align": cstyle.get("align", "left"),
                "valign": cstyle.get("valign", "ctr"),
                "fontSize": cstyle.get("fontSize", default_fs),
                "runs": cstyle.get("runs"),
            }
            fill_xml = f"<a:solidFill>{_color_xml(fill)}</a:solidFill>" if fill else "<a:noFill/>"
            anchor = _VALIGN_CODES.get(str(style["valign"]), "ctr")
            tcpr = f'<a:tcPr anchor="{anchor}">{border_xml}{fill_xml}</a:tcPr>'
            tcs.append(f"<a:tc>{_cell_txbody(ctext, style)}{tcpr}</a:tc>")
        tr_rows.append(f'<a:tr h="{h}">' + "".join(tcs) + "</a:tr>")

    ext_cx = sum(col_w)
    ext_cy = total_h_used
    grid = "".join(f'<a:gridCol w="{w}"/>' for w in col_w)
    first_row = "1" if header_fill is not None else "0"
    return (
        "      <p:graphicFrame>\n"
        f'        <p:nvGraphicFramePr><p:cNvPr id="{shape_id}" name="{_e(name)}"/>'
        '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>\n'
        f'        <p:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{ext_cx}" cy="{ext_cy}"/></p:xfrm>\n'
        '        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">\n'
        f'          <a:tbl><a:tblPr firstRow="{first_row}" bandRow="1"/><a:tblGrid>{grid}</a:tblGrid>\n'
        f'          {"".join(tr_rows)}\n'
        "          </a:tbl>\n"
        "        </a:graphicData></a:graphic>\n"
        "      </p:graphicFrame>"
    )


def _text_body(text: str, style: dict[str, Any]) -> str:
    font_size = int(float(style.get("fontSize", 18)) * 100)
    color = _hex(style.get("color", "1F2937"))
    alpha = _alpha(style.get("alpha", style.get("opacity", 1)))
    bold = ' b="1"' if style.get("bold") else ""
    italic = ' i="1"' if style.get("italic") else ""
    align = {"left": "l", "center": "ctr", "right": "r"}.get(str(style.get("align", "left")), "l")
    valign = {
        "top": "t",
        "t": "t",
        "mid": "ctr",
        "middle": "ctr",
        "center": "ctr",
        "ctr": "ctr",
        "bottom": "b",
        "b": "b",
    }.get(str(style.get("valign", "top")), "t")
    latin = style.get("latinFont", "Times New Roman")
    east_asian = style.get("font", style.get("eastAsianFont", "Songti SC"))
    margin = int(style.get("margin", 0))
    wrap = "none" if str(style.get("wrap", "square")) == "none" else "square"
    autofit = "<a:noAutofit/>" if str(style.get("autofit", "shape")) == "none" else "<a:spAutoFit/>"
    p_pr = _paragraph_pr(align, style)
    runs = style.get("runs")
    rows = []
    if isinstance(runs, list) and runs:
        run_xml = "".join(_run_xml(run, style) for run in runs)
        rows.append(f"          <a:p>{p_pr}{run_xml}</a:p>")
    else:
        paragraphs = str(text).split("\n") or [""]
        for paragraph in paragraphs:
            rows.append(
                f"          <a:p>{p_pr}"
                f'<a:r><a:rPr lang="zh-CN" sz="{font_size}"{bold}{italic}>'
                f'<a:solidFill>{_srgb_xml(color, alpha)}</a:solidFill>'
                f'<a:latin typeface="{_e(str(latin))}"/><a:ea typeface="{_e(str(east_asian))}"/><a:cs typeface="{_e(str(latin))}"/>'
                f'</a:rPr><a:t>{_e(paragraph)}</a:t></a:r>'
                "</a:p>"
            )
    return (
        "        <p:txBody>\n"
        f'          <a:bodyPr wrap="{wrap}" anchor="{valign}" lIns="{margin}" tIns="{margin}" rIns="{margin}" bIns="{margin}">{autofit}</a:bodyPr>\n'
        "          <a:lstStyle/>\n"
        + "\n".join(rows)
        + "\n"
        "        </p:txBody>\n"
    )


def _paragraph_pr(align: str, style: dict[str, Any]) -> str:
    line_height = style.get("lineHeight")
    if line_height is None:
        return f'<a:pPr algn="{align}"/>'
    try:
        line_height_val = int(round(float(line_height) * 100))
    except (TypeError, ValueError):
        return f'<a:pPr algn="{align}"/>'
    if line_height_val <= 0:
        return f'<a:pPr algn="{align}"/>'
    return f'<a:pPr algn="{align}"><a:lnSpc><a:spcPts val="{line_height_val}"/></a:lnSpc></a:pPr>'


def _run_xml(run: dict[str, Any], fallback: dict[str, Any]) -> str:
    if run.get("break"):
        return "<a:br/>"
    font_size = int(float(run.get("fontSize", fallback.get("fontSize", 18))) * 100)
    color = _hex(run.get("color", fallback.get("color", "1F2937")))
    alpha = _alpha(run.get("alpha", run.get("opacity", fallback.get("alpha", fallback.get("opacity", 1)))))
    bold = ' b="1"' if run.get("bold", fallback.get("bold")) else ""
    italic = ' i="1"' if run.get("italic", fallback.get("italic")) else ""
    latin = run.get("latinFont", fallback.get("latinFont", "Times New Roman"))
    east_asian = run.get("font", run.get("eastAsianFont", fallback.get("font", fallback.get("eastAsianFont", "Songti SC"))))
    return (
        f'<a:r><a:rPr lang="zh-CN" sz="{font_size}"{bold}{italic}>'
        f'<a:solidFill>{_srgb_xml(color, alpha)}</a:solidFill>'
        f'<a:latin typeface="{_e(str(latin))}"/><a:ea typeface="{_e(str(east_asian))}"/><a:cs typeface="{_e(str(latin))}"/>'
        f'</a:rPr><a:t>{_e(run.get("text", ""))}</a:t></a:r>'
    )


def _fill_xml(fill: str | None, indent: int, alpha: Any = 1, gradient: Any = None) -> str:
    pad = " " * indent
    gradient_xml = _gradient_fill_xml(gradient, indent)
    if gradient_xml:
        return gradient_xml
    alpha_value = _alpha(alpha)
    if fill is None or alpha_value <= 0:
        return f"{pad}<a:noFill/>\n"
    return f"{pad}<a:solidFill>{_color_xml(fill, alpha_value)}</a:solidFill>\n"


def _scene_shadow(shadow: Any, sx: float) -> dict[str, Any] | None:
    if not isinstance(shadow, dict):
        return None
    try:
        blur = max(0.0, float(shadow.get("blur", 0)))
        distance = max(0.0, float(shadow.get("distance", 0)))
        direction = float(shadow.get("direction", 45))
    except (TypeError, ValueError):
        return None
    alpha = _alpha(shadow.get("alpha", 1))
    if alpha <= 0 or (blur <= 0 and distance <= 0):
        return None
    return {
        "color": _hex(shadow.get("color", "000000")),
        "alpha": alpha,
        "blurRad": _emu(blur, sx),
        "dist": _emu(distance, sx),
        "dir": int(round(direction * 60000)),
    }


def _scene_glow(glow: Any, sx: float) -> dict[str, Any] | None:
    if not isinstance(glow, dict):
        return None
    try:
        radius = max(0.0, float(glow.get("radius", glow.get("blur", 0))))
    except (TypeError, ValueError):
        return None
    alpha = _alpha(glow.get("alpha", 1))
    if radius <= 0 or alpha <= 0:
        return None
    return {"color": _hex(glow.get("color", "FFFFFF")), "alpha": alpha, "rad": _emu(radius, sx)}


def _scene_blur(blur: Any, sx: float) -> dict[str, Any] | None:
    if not isinstance(blur, dict):
        return None
    try:
        radius = max(0.0, float(blur.get("radius", blur.get("blur", 0))))
    except (TypeError, ValueError):
        return None
    if radius <= 0:
        return None
    return {"rad": _emu(radius, sx)}


def _scene_reflection(reflection: Any, sx: float) -> dict[str, Any] | None:
    if not isinstance(reflection, dict):
        return None
    alpha = _alpha(reflection.get("alpha", 0.5))
    if alpha <= 0:
        return None
    return {
        "alpha": alpha,
        "dist": _emu(max(0.0, float(reflection.get("dist", 0) or 0)), sx),
        "blurRad": _emu(max(0.0, float(reflection.get("blur", 0) or 0)), sx),
    }


def _shadow_xml(shadow: dict[str, Any] | None, indent: int) -> str:
    return _effects_xml(shadow, None, indent)


def _effects_xml(
    shadow: dict[str, Any] | None,
    glow: dict[str, Any] | None,
    indent: int,
    blur: dict[str, Any] | None = None,
    reflection: dict[str, Any] | None = None,
) -> str:
    pad = " " * indent
    parts: list[str] = []
    # CT_EffectList order is fixed: blur, glow, outerShdw, reflection.
    if blur and int(blur.get("rad", 0)) > 0:
        parts.append(f'<a:blur rad="{int(blur["rad"])}" grow="1"/>')
    if glow and int(glow.get("rad", 0)) > 0:
        color = _hex(glow.get("color", "FFFFFF"))
        alpha = _alpha(glow.get("alpha", 1))
        alpha_xml = f'<a:alpha val="{int(round(alpha * 100000))}"/>' if alpha < 1 else ""
        parts.append(
            f'<a:glow rad="{int(glow["rad"])}"><a:srgbClr val="{color}">{alpha_xml}</a:srgbClr></a:glow>'
        )
    if shadow:
        blur = max(0, int(shadow.get("blurRad", 0)))
        dist = max(0, int(shadow.get("dist", 0)))
        if blur > 0 or dist > 0:
            color = _hex(shadow.get("color", "000000"))
            alpha = _alpha(shadow.get("alpha", 1))
            direction = int(shadow.get("dir", 2700000))
            alpha_xml = f'<a:alpha val="{int(round(alpha * 100000))}"/>' if alpha < 1 else ""
            parts.append(
                f'<a:outerShdw blurRad="{blur}" dist="{dist}" dir="{direction}" algn="tl" rotWithShape="0">'
                f'<a:srgbClr val="{color}">{alpha_xml}</a:srgbClr></a:outerShdw>'
            )
    if reflection:
        start_a = int(round(_alpha(reflection.get("alpha", 0.5)) * 100000))
        dist = max(0, int(reflection.get("dist", 0)))
        blur_rad = max(0, int(reflection.get("blurRad", 0)))
        parts.append(
            f'<a:reflection blurRad="{blur_rad}" stA="{start_a}" stPos="0" '
            f'endA="300" endPos="90000" dist="{dist}" dir="5400000" '
            'sy="-100000" algn="bl" rotWithShape="0"/>'
        )
    if not parts:
        return ""
    return f"{pad}<a:effectLst>{''.join(parts)}</a:effectLst>\n"


def _gradient_fill_xml(gradient: Any, indent: int) -> str:
    if not isinstance(gradient, dict):
        return ""
    colors = gradient.get("colors")
    if not isinstance(colors, list) or len(colors) < 2:
        return ""
    pad = " " * indent
    stops = []
    last = max(len(colors) - 1, 1)
    for idx, color in enumerate(colors):
        if not isinstance(color, dict):
            continue
        hex_value = color.get("hex")
        if not hex_value:
            continue
        alpha = _alpha(color.get("alpha", 1))
        # Honor an explicit CSS stop position; otherwise distribute evenly.
        css_pos = color.get("pos")
        if isinstance(css_pos, (int, float)):
            pos = int(round(max(0.0, min(100.0, float(css_pos))) * 1000))
        else:
            pos = int(round(idx / last * 100000))
        stops.append(f'{pad}    <a:gs pos="{pos}">{_color_xml(hex_value, alpha)}</a:gs>')
    if len(stops) < 2:
        return ""
    # Gradient geometry. CSS radial -> OOXML path("circle") (center -> edge).
    # CSS linear angle (0deg = to top, clockwise) -> OOXML ang (0 = east / +x,
    # clockwise, in 60000ths of a degree): ang = (css_deg - 90) mod 360.
    if str(gradient.get("type")) == "radial":
        geom = (
            f'{pad}  <a:path path="circle">'
            '<a:fillToRect l="50000" t="50000" r="50000" b="50000"/>'
            "</a:path>\n"
        )
    else:
        css_deg = gradient.get("angle")
        if not isinstance(css_deg, (int, float)):
            css_deg = 180  # CSS linear default = to bottom (== legacy 5400000)
        ang = int(round(((float(css_deg) - 90.0) % 360.0) * 60000))
        geom = f'{pad}  <a:lin ang="{ang}" scaled="0"/>\n'
    return (
        f"{pad}<a:gradFill flip=\"none\" rotWithShape=\"1\">\n"
        f"{pad}  <a:gsLst>\n"
        + "\n".join(stops)
        + "\n"
        f"{pad}  </a:gsLst>\n"
        f"{geom}"
        f"{pad}</a:gradFill>\n"
    )


def _line_xml_inner(line: dict[str, Any] | None, indent: int, arrow: bool = False) -> str:
    pad = " " * indent
    line = line or {}
    color = line.get("fill", line.get("color", "CBD5E1"))
    alpha = _alpha(line.get("alpha", line.get("opacity", 1)))
    width = int(float(line.get("width", 1)) * 12700)
    if color is None or width <= 0 or alpha <= 0:
        return f"{pad}<a:ln><a:noFill/></a:ln>\n"
    head = line.get("headEnd") or line.get("arrowStart")
    tail = line.get("tailEnd") or line.get("arrowEnd")
    if arrow and not tail:
        tail = "triangle"
    ends = ""
    if head:
        ends += f'\n{pad}  <a:headEnd type="{_e(_arrow_type(head))}" w="med" len="med"/>'
    if tail:
        ends += f'\n{pad}  <a:tailEnd type="{_e(_arrow_type(tail))}" w="med" len="med"/>'
    dash_xml = _dash_xml(line.get("dash"), pad)
    return (
        f'{pad}<a:ln w="{width}"><a:solidFill>{_color_xml(color, alpha)}</a:solidFill>'
        f"{dash_xml}{ends}</a:ln>\n"
    )


def _arrow_type(value: Any) -> str:
    if value is True:
        return "triangle"
    text = str(value or "triangle").strip().lower()
    lookup = {a.lower(): a for a in _ARROW_ENDS}
    return lookup.get(text, "triangle")


def _dash_xml(value: Any, pad: str) -> str:
    if not value:
        return ""
    dash = str(value).strip()
    if dash not in _DASH_STYLES:
        dash = "dash"
    return f'\n{pad}  <a:prstDash val="{_e(dash)}"/>'


def _transition_xml(value: Any) -> str:
    if not value:
        return ""
    if isinstance(value, str):
        kind = value
        speed = "fast"
        duration = 1000
        option = "byObject"
    else:
        kind = value.get("type", "fade")
        speed = value.get("speed", "fast")
        duration = _ms(value.get("durationMs", value.get("duration", 1000)), 1000)
        option = _morph_option(value.get("option", value.get("morph", "byObject")))
    normalized = str(kind).strip().lower()
    if normalized in {"morph", "smooth", "平滑"}:
        return _morph_transition_xml(speed, duration, option)
    kind = kind if kind in _TRANSITION_TYPES else "fade"
    return f'  <p:transition spd="{_e(str(speed))}"><p:{kind}/></p:transition>\n'


def _morph_transition_xml(speed: Any, duration_ms: int, option: str) -> str:
    return (
        '  <mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        'xmlns:p159="http://schemas.microsoft.com/office/powerpoint/2015/09/main">\n'
        "    <mc:Choice Requires=\"p159\">\n"
        f'      <p:transition spd="{_e(str(speed))}" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" p14:dur="{duration_ms}"><p159:morph option="{_e(option)}"/></p:transition>\n'
        "    </mc:Choice>\n"
        "    <mc:Fallback>\n"
        f'      <p:transition spd="{_e(str(speed))}"><p:fade/></p:transition>\n'
        "    </mc:Fallback>\n"
        "  </mc:AlternateContent>\n"
    )


def _morph_option(value: Any) -> str:
    text = str(value or "byObject").strip()
    lowered = text.lower().replace("-", "").replace("_", "").replace(" ", "")
    if lowered in {"object", "byobject", "objects"}:
        return "byObject"
    if lowered in {"word", "byword", "words"}:
        return "byWord"
    if lowered in {"char", "character", "bychar", "bycharacter", "chars", "characters"}:
        return "byChar"
    return "byObject"


# Entrance/exit reveal effects that compile to <p:animEffect filter="...">.
# Structurally identical to the original fade writer, so low risk.
# effect name -> (presetID, filter)
_ANIM_EFFECT_FILTERS: dict[str, tuple[int, str]] = {
    "fade": (10, "fade"),
    "blinds": (3, "blinds(horizontal)"),
    "box": (4, "box(in)"),
    "checkerboard": (5, "checkerboard(across)"),
    "circle": (6, "circle"),
    "diamond": (7, "diamond"),
    "dissolve": (9, "dissolve"),
    "plus": (12, "plus"),
    "randombars": (13, "randombar(horizontal)"),
    "wedge": (18, "wedge"),
    "wheel": (21, "wheel(4)"),
    "wipe": (22, "wipe(up)"),
}

# Modern combined entrances: fade + a directional slide (+ optional zoom) running
# concurrently with shared easing — the tasteful "things settle into place" look
# that a single canned preset cannot express. (dx, dy) are the START offset in
# slide fractions for a relative motion path (positive y = below, positive x =
# right), so the object travels from there to its home (0,0). `scale` is the
# start scale (None = no zoom).
_MOTION_ENTRANCES: dict[str, tuple[float, float, float | None]] = {
    "rise":       (0.0,  0.045, None),
    "slideup":    (0.0,  0.045, None),
    "slidedown":  (0.0, -0.045, None),
    "slideleft":  (0.060, 0.0,  None),
    "slideright": (-0.060, 0.0, None),
    "zoom":       (0.0,  0.0,   0.90),
    "risezoom":   (0.0,  0.030, 0.94),
}


def _timing_xml(
    animations: Any,
    target_map: dict[str, list[int]],
    shape_ids: set[int],
    paragraph_counts: dict[int, int] | None = None,
    losses: list[dict[str, Any]] | None = None,
    slide_index: int | None = None,
) -> tuple[str, int]:
    animation_list = _animation_list(animations)
    if not animation_list:
        return "", 0
    paragraph_counts = paragraph_counts or {}

    def _loss(code: str, message: str, suggestion: str, animation: Any) -> None:
        if losses is None:
            return
        losses.append({
            "code": code,
            "where": {"slide": slide_index},
            "target": animation.get("target") or animation.get("sourceKey") or animation.get("name"),
            "message": message,
            "suggestion": suggestion,
        })

    expanded: list[dict[str, Any]] = []
    # grpId 0 is the default shared group; build shapes get their own grpId.
    build_grp: dict[int, int] = {}
    next_grp = 1
    for animation in animation_list:
        targets = _resolve_animation_targets(animation, target_map, shape_ids)
        if not targets:
            _loss(
                "ANIM_TARGET_NOT_FOUND",
                f"Animation target not found: {animation.get('target') or animation}",
                "Use a target that matches an element's source.key/name/id, or set "
                "shapeId. See capabilities.targeting.animationTargetKeys.",
                animation,
            )
            continue
        effect = _animation_effect(animation)
        if effect == "motionPath" and not str(animation.get("pptPath") or animation.get("path") or "").strip():
            _loss(
                "ANIM_MOTION_PATH_MISSING",
                "motionPath animation requires a pptPath/path.",
                'Provide a PowerPoint relative path, e.g. pptPath:"M 0 0 L 0.2 0".',
                animation,
            )
            continue
        if effect == "build":
            # Per-paragraph text build: one reveal node per paragraph.
            reveal = _build_reveal_effect(animation)
            for spid in targets:
                grp = build_grp.get(spid)
                if grp is None:
                    grp = next_grp
                    build_grp[spid] = grp
                    next_grp += 1
                count = max(1, int(paragraph_counts.get(spid, 1)))
                for p in range(count):
                    expanded.append({
                        **animation, "_spid": spid, "_effect": reveal,
                        "_prg": p, "_grpId": grp,
                    })
            continue
        if not _is_supported_effect(effect):
            _loss(
                "ANIM_EFFECT_UNSUPPORTED",
                f"Unsupported animation effect: {effect}",
                "Use a supported effect from capabilities.animation.within "
                "(entrance/exit/emphasis/appear/motionPath/build).",
                animation,
            )
            continue
        for spid in targets:
            expanded.append({**animation, "_spid": spid, "_effect": effect})
    if not expanded:
        return "", 0

    groups: list[dict[str, Any]] = []
    current_group: dict[str, Any] | None = None
    for animation in expanded:
        trigger = _animation_trigger(animation)
        if current_group is None or trigger == "onClick":
            current_group = {"trigger": trigger, "items": []}
            groups.append(current_group)
        current_group["items"].append(animation)

    node_id = 3
    group_rows = []
    for group in groups:
        items = group["items"]
        group_trigger = str(group.get("trigger") or "onClick")
        group_id = node_id
        inner_id = node_id + 1
        node_id += 2
        effect_rows = []
        for idx, animation in enumerate(items):
            node_type = _animation_node_type(animation, idx)
            xml, node_id = _animation_node_xml(animation, node_id, node_type)
            effect_rows.append(xml)
        group_start = '<p:cond delay="indefinite"/>'
        if group_trigger != "onClick":
            # PowerPoint-authored with/after-previous groups bind to the main
            # sequence begin event; using delay=0 here blocks PageUp on Mac.
            group_start += '<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>'
        group_rows.append(
            "              <p:par>\n"
            f'                <p:cTn id="{group_id}" fill="hold">\n'
            f"                  <p:stCondLst>{group_start}</p:stCondLst>\n"
            "                  <p:childTnLst>\n"
            "                    <p:par>\n"
            f'                      <p:cTn id="{inner_id}" fill="hold">\n'
            '                        <p:stCondLst><p:cond delay="0"/></p:stCondLst>\n'
            "                        <p:childTnLst>\n"
            + "\n".join(effect_rows)
            + "\n"
            "                        </p:childTnLst>\n"
            "                      </p:cTn>\n"
            "                    </p:par>\n"
            "                  </p:childTnLst>\n"
            "                </p:cTn>\n"
            "              </p:par>"
        )

    build_entries: dict[int, str] = {}
    for a in expanded:
        spid = int(a["_spid"])
        effect = str(a["_effect"])
        if "_prg" in a:
            grp = int(a.get("_grpId", 0))
            build_entries[spid] = f'<p:bldP spid="{spid}" grpId="{grp}" build="p"/>'
        elif effect == "compose" and _compose_is_entrance(a):
            build_entries.setdefault(spid, f'<p:bldP spid="{spid}" grpId="0"/>')
        elif _is_entrance_effect(effect):
            build_entries.setdefault(spid, f'<p:bldP spid="{spid}" grpId="0"/>')
    build_list = "".join(build_entries[spid] for spid in sorted(build_entries))
    # An empty <p:bldLst/> is schema-invalid; omit it when there are no builds.
    bld_xml = f"    <p:bldLst>{build_list}</p:bldLst>\n" if build_list else ""
    timing = (
        "  <p:timing>\n"
        "    <p:tnLst>\n"
        "      <p:par>\n"
        '        <p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">\n'
        "          <p:childTnLst>\n"
        '            <p:seq concurrent="1" nextAc="seek">\n'
        '              <p:cTn id="2" dur="indefinite" nodeType="mainSeq">\n'
        "                <p:childTnLst>\n"
        + "\n".join(group_rows)
        + "\n"
        "                </p:childTnLst>\n"
        "              </p:cTn>\n"
        '              <p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>\n'
        '              <p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>\n'
        "            </p:seq>\n"
        "          </p:childTnLst>\n"
        "        </p:cTn>\n"
        "      </p:par>\n"
        "    </p:tnLst>\n"
        f"{bld_xml}"
        "  </p:timing>\n"
    )
    return timing, len(expanded)


def _sp_tgt(spid: int, prg: Any = None) -> str:
    if prg is None:
        return f'<p:spTgt spid="{spid}"/>'
    p = int(prg)
    return f'<p:spTgt spid="{spid}"><p:txEl><p:pRg st="{p}" end="{p}"/></p:txEl></p:spTgt>'


def _animation_node_type(animation: dict[str, Any], index_in_group: int) -> str:
    trigger = _animation_trigger(animation)
    if trigger == "withPrevious":
        return "withEffect"
    if trigger == "afterPrevious":
        return "afterEffect"
    return "clickEffect" if index_in_group == 0 else "withEffect"


def _animation_node_xml(animation: dict[str, Any], node_id: int, node_type: str) -> tuple[str, int]:
    spid = int(animation["_spid"])
    effect = str(animation["_effect"])
    grp = int(animation.get("_grpId", 0))
    prg = animation.get("_prg")
    sp_tgt = _sp_tgt(spid, prg)
    delay = _ms(animation.get("delayMs", animation.get("delay", 0)), 0)
    duration = _ms(animation.get("durationMs", animation.get("duration", 500)), 500)
    ease = _ease_attr(animation)
    if effect == "appear":
        duration = max(1, duration)
    if effect == "compose":
        opacity = _compose_opacity(animation)
        ctn_id = node_id
        nid = node_id + 1
        repeat = _repeat_attr(animation)
        autorev = _autorev_attr(animation)
        children = []
        if opacity == "in":
            set_id = nid
            nid += 1
            children.append(
                "                                <p:set>\n"
                "                                  <p:cBhvr>\n"
                f'                                    <p:cTn id="{set_id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>\n'
                f'                                    <p:tgtEl>{sp_tgt}</p:tgtEl>\n'
                "                                    <p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>\n"
                "                                  </p:cBhvr>\n"
                '                                  <p:to><p:strVal val="visible"/></p:to>\n'
                "                                </p:set>\n"
            )
        if opacity in {"in", "out"}:
            fade_id = nid
            nid += 1
            transition = "in" if opacity == "in" else "out"
            children.append(
                f'                                <p:animEffect transition="{transition}" filter="fade">\n'
                f'                                  <p:cBhvr><p:cTn id="{fade_id}" dur="{duration}"{repeat}{ease}{autorev} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl></p:cBhvr>\n'
                "                                </p:animEffect>\n"
            )
        path = str(animation.get("pptPath") or animation.get("path") or "").strip()
        x = _float_or_none(animation.get("x", animation.get("dx")))
        y = _float_or_none(animation.get("y", animation.get("dy")))
        if not path and (x is not None or y is not None):
            fx = (x or 0.0) / 1280.0
            fy = (y or 0.0) / 720.0
            if opacity == "out":
                path = f"M 0 0 L {fx:.4f} {fy:.4f}"
            else:
                path = f"M {fx:.4f} {fy:.4f} L 0 0"
        if path:
            motion_id = nid
            nid += 1
            origin = str(animation.get("origin", "layout"))
            children.append(
                f'                                <p:animMotion origin="{_e(origin)}" path="{_e(path)}" pathEditMode="relative" rAng="0">\n'
                f'                                  <p:cBhvr><p:cTn id="{motion_id}" dur="{duration}"{repeat}{ease}{autorev} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl><p:attrNameLst><p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr>\n'
                '                                  <p:rCtr x="0" y="0"/>\n'
                "                                </p:animMotion>\n"
            )
        scale_from = _float_or_none(animation.get("scaleFrom"))
        scale_to = _float_or_none(animation.get("scaleTo"))
        if scale_from is not None or scale_to is not None:
            scale_id = nid
            nid += 1
            sf = int(round((scale_from if scale_from is not None else 1.0) * 100000))
            st = int(round((scale_to if scale_to is not None else 1.0) * 100000))
            children.append(
                "                                <p:animScale>\n"
                f'                                  <p:cBhvr><p:cTn id="{scale_id}" dur="{duration}"{repeat}{ease}{autorev} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl></p:cBhvr>\n'
                f'                                  <p:from x="{sf}" y="{sf}"/><p:to x="{st}" y="{st}"/>\n'
                "                                </p:animScale>\n"
            )
        rotate_from = _float_or_none(animation.get("rotateFrom"))
        rotate_to = _float_or_none(animation.get("rotateTo"))
        if rotate_from is not None or rotate_to is not None:
            rot_id = nid
            nid += 1
            rf = int(round((rotate_from or 0.0) * 60000))
            rt = int(round((rotate_to or 0.0) * 60000))
            children.append(
                f'                                <p:animRot from="{rf}" to="{rt}">\n'
                f'                                  <p:cBhvr><p:cTn id="{rot_id}" dur="{duration}"{repeat}{ease}{autorev} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl><p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr>\n'
                "                                </p:animRot>\n"
            )
        to_color = animation.get("toColor")
        if to_color:
            clr_id = nid
            nid += 1
            children.append(
                '                                <p:animClr clrSpc="rgb">\n'
                f'                                  <p:cBhvr><p:cTn id="{clr_id}" dur="{duration}"{repeat}{ease}{autorev} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl><p:attrNameLst><p:attrName>fillcolor</p:attrName></p:attrNameLst></p:cBhvr>\n'
                f'                                  <p:to><a:srgbClr val="{_hex(to_color)}"/></p:to>\n'
                "                                </p:animClr>\n"
            )
        if not children:
            # Defensive fallback: a declared but empty compose still gives a
            # visible fade instead of an empty, invalid timing container.
            fade_id = nid
            nid += 1
            children.append(
                '                                <p:animEffect transition="in" filter="fade">\n'
                f'                                  <p:cBhvr><p:cTn id="{fade_id}" dur="{duration}"{ease} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl></p:cBhvr>\n'
                "                                </p:animEffect>\n"
            )
        preset_class = "entr" if opacity == "in" else "exit" if opacity == "out" else "emph"
        xml = (
            "                          <p:par>\n"
            f'                            <p:cTn id="{ctn_id}" presetID="10" presetClass="{preset_class}" presetSubtype="0" fill="hold" grpId="{grp}" nodeType="{node_type}">\n'
            f'                              <p:stCondLst><p:cond delay="{delay}"/></p:stCondLst>\n'
            "                              <p:childTnLst>\n"
            + "".join(children)
            + "                              </p:childTnLst>\n"
            "                            </p:cTn>\n"
            "                          </p:par>"
        )
        return xml, nid
    # Entrance appear: instant visibility set, no filter reveal.
    if effect in _MOTION_ENTRANCES:
        dx, dy, scale = _MOTION_ENTRANCES[effect]
        # Optional px distance override along whichever axis the preset moves on.
        dist = animation.get("dist")
        if dist is not None:
            try:
                d = float(dist)
                if dx:
                    dx = (d / 1280.0) * (1 if dx > 0 else -1)
                if dy:
                    dy = (d / 720.0) * (1 if dy > 0 else -1)
            except (TypeError, ValueError):
                pass
        ctn_id = node_id
        set_id = node_id + 1
        fade_id = node_id + 2
        nid = node_id + 3
        children = [
            "                                <p:set>\n"
            "                                  <p:cBhvr>\n"
            f'                                    <p:cTn id="{set_id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>\n'
            f'                                    <p:tgtEl>{sp_tgt}</p:tgtEl>\n'
            "                                    <p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>\n"
            "                                  </p:cBhvr>\n"
            '                                  <p:to><p:strVal val="visible"/></p:to>\n'
            "                                </p:set>\n"
            '                                <p:animEffect transition="in" filter="fade">\n'
            f'                                  <p:cBhvr><p:cTn id="{fade_id}" dur="{duration}"{ease}/><p:tgtEl>{sp_tgt}</p:tgtEl></p:cBhvr>\n'
            "                                </p:animEffect>\n"
        ]
        if dx or dy:
            motion_id = nid
            nid += 1
            children.append(
                f'                                <p:animMotion origin="layout" path="M {dx:.4f} {dy:.4f} L 0 0" pathEditMode="relative" rAng="0">\n'
                f'                                  <p:cBhvr><p:cTn id="{motion_id}" dur="{duration}"{ease} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl><p:attrNameLst><p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr>\n'
                '                                  <p:rCtr x="0" y="0"/>\n'
                "                                </p:animMotion>\n"
            )
        if scale is not None:
            scale_id = nid
            nid += 1
            sval = int(round(scale * 100000))
            children.append(
                "                                <p:animScale>\n"
                f'                                  <p:cBhvr><p:cTn id="{scale_id}" dur="{duration}"{ease} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl></p:cBhvr>\n'
                f'                                  <p:from x="{sval}" y="{sval}"/><p:to x="100000" y="100000"/>\n'
                "                                </p:animScale>\n"
            )
        xml = (
            "                          <p:par>\n"
            f'                            <p:cTn id="{ctn_id}" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" grpId="{grp}" nodeType="{node_type}">\n'
            f'                              <p:stCondLst><p:cond delay="{delay}"/></p:stCondLst>\n'
            "                              <p:childTnLst>\n"
            + "".join(children)
            + "                              </p:childTnLst>\n"
            "                            </p:cTn>\n"
            "                          </p:par>"
        )
        return xml, nid
    if effect == "appear":
        ctn_id = node_id
        set_id = node_id + 1
        next_id = node_id + 2
        xml = (
            "                          <p:par>\n"
            f'                            <p:cTn id="{ctn_id}" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" grpId="{grp}" nodeType="{node_type}">\n'
            f'                              <p:stCondLst><p:cond delay="{delay}"/></p:stCondLst>\n'
            "                              <p:childTnLst>\n"
            "                                <p:set>\n"
            "                                  <p:cBhvr>\n"
            f'                                    <p:cTn id="{set_id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>\n'
            f'                                    <p:tgtEl>{sp_tgt}</p:tgtEl>\n'
            "                                    <p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>\n"
            "                                  </p:cBhvr>\n"
            '                                  <p:to><p:strVal val="visible"/></p:to>\n'
            "                                </p:set>\n"
            "                              </p:childTnLst>\n"
            "                            </p:cTn>\n"
            "                          </p:par>"
        )
        return xml, next_id
    # Entrance/exit filter reveals (fade/wipe/blinds/checkerboard/...).
    is_exit = effect.startswith("exit-")
    base = effect[len("exit-"):] if is_exit else effect
    if base in _ANIM_EFFECT_FILTERS:
        preset_id, filt = _ANIM_EFFECT_FILTERS[base]
        preset_class = "exit" if is_exit else "entr"
        transition = "out" if is_exit else "in"
        visibility = "hidden" if is_exit else "visible"
        ctn_id = node_id
        set_id = node_id + 1
        effect_id = node_id + 2
        next_id = node_id + 3
        xml = (
            "                          <p:par>\n"
            f'                            <p:cTn id="{ctn_id}" presetID="{preset_id}" presetClass="{preset_class}" presetSubtype="0" fill="hold" grpId="{grp}" nodeType="{node_type}">\n'
            f'                              <p:stCondLst><p:cond delay="{delay}"/></p:stCondLst>\n'
            "                              <p:childTnLst>\n"
            "                                <p:set>\n"
            "                                  <p:cBhvr>\n"
            f'                                    <p:cTn id="{set_id}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>\n'
            f'                                    <p:tgtEl>{sp_tgt}</p:tgtEl>\n'
            "                                    <p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>\n"
            "                                  </p:cBhvr>\n"
            f'                                  <p:to><p:strVal val="{visibility}"/></p:to>\n'
            "                                </p:set>\n"
            f'                                <p:animEffect transition="{transition}" filter="{_e(filt)}">\n'
            f'                                  <p:cBhvr><p:cTn id="{effect_id}" dur="{duration}"{ease}/><p:tgtEl>{sp_tgt}</p:tgtEl></p:cBhvr>\n'
            "                                </p:animEffect>\n"
            "                              </p:childTnLst>\n"
            "                            </p:cTn>\n"
            "                          </p:par>"
        )
        return xml, next_id

    # Emphasis: fill-color change (animClr).
    if effect == "recolor":
        color = _hex(animation.get("toColor", "FFFFFF"))
        ctn_id = node_id
        beh_id = node_id + 1
        next_id = node_id + 2
        repeat = _repeat_attr(animation)
        autorev = _autorev_attr(animation)
        xml = (
            "                          <p:par>\n"
            f'                            <p:cTn id="{ctn_id}" presetID="6" presetClass="emph" presetSubtype="0" fill="hold" grpId="{grp}" nodeType="{node_type}">\n'
            f'                              <p:stCondLst><p:cond delay="{delay}"/></p:stCondLst>\n'
            "                              <p:childTnLst>\n"
            '                                <p:animClr clrSpc="rgb">\n'
            f'                                  <p:cBhvr><p:cTn id="{beh_id}" dur="{duration}"{repeat}{ease}{autorev} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl><p:attrNameLst><p:attrName>fillcolor</p:attrName></p:attrNameLst></p:cBhvr>\n'
            f'                                  <p:to><a:srgbClr val="{color}"/></p:to>\n'
            "                                </p:animClr>\n"
            "                              </p:childTnLst>\n"
            "                            </p:cTn>\n"
            "                          </p:par>"
        )
        return xml, next_id
    # Emphasis: spin (animRot), grow/shrink/pulse (animScale).
    if effect in {"spin", "grow", "shrink", "pulse"}:
        ctn_id = node_id
        beh_id = node_id + 1
        next_id = node_id + 2
        # CT_TLCommonTimeNodeData attr order: dur, repeatCount, accel/decel, autoRev, fill.
        repeat = _repeat_attr(animation)
        if effect == "spin":
            spins = int(animation.get("spins", 1)) or 1
            deg = float(animation.get("byDeg", 360)) * spins
            by = int(round(deg * 60000))  # OOXML rotation unit = 1/60000 degree
            autorev = _autorev_attr(animation)
            inner = (
                f'                                <p:animRot by="{by}">\n'
                f'                                  <p:cBhvr><p:cTn id="{beh_id}" dur="{duration}"{repeat}{ease}{autorev} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl><p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr>\n'
                "                                </p:animRot>\n"
            )
            preset_id = 8
        else:
            if effect == "grow":
                pct, autorev = float(animation.get("scale", 150)), _autorev_attr(animation)
            elif effect == "shrink":
                pct, autorev = float(animation.get("scale", 50)), _autorev_attr(animation)
            else:  # pulse: scale up and auto-reverse back
                pct, autorev = float(animation.get("scale", 110)), ' autoRev="1"'
            val = int(round(pct * 1000))  # thousandths of a percent
            inner = (
                "                                <p:animScale>\n"
                f'                                  <p:cBhvr><p:cTn id="{beh_id}" dur="{duration}"{repeat}{ease}{autorev} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl></p:cBhvr>\n'
                f'                                  <p:by x="{val}" y="{val}"/>\n'
                "                                </p:animScale>\n"
            )
            preset_id = 6
        xml = (
            "                          <p:par>\n"
            f'                            <p:cTn id="{ctn_id}" presetID="{preset_id}" presetClass="emph" presetSubtype="0" fill="hold" grpId="{grp}" nodeType="{node_type}">\n'
            f'                              <p:stCondLst><p:cond delay="{delay}"/></p:stCondLst>\n'
            "                              <p:childTnLst>\n"
            + inner
            + "                              </p:childTnLst>\n"
            "                            </p:cTn>\n"
            "                          </p:par>"
        )
        return xml, next_id

    path = str(animation.get("pptPath") or animation.get("path") or "").strip()
    if not path:
        raise ValueError(f"motionPath animation requires pptPath/path: {animation}")
    ctn_id = node_id
    motion_id = node_id + 1
    next_id = node_id + 2
    origin = str(animation.get("origin", "layout"))
    xml = (
        "                          <p:par>\n"
        f'                            <p:cTn id="{ctn_id}" presetID="0" presetClass="path" presetSubtype="0" fill="hold" grpId="{grp}" nodeType="{node_type}">\n'
        f'                              <p:stCondLst><p:cond delay="{delay}"/></p:stCondLst>\n'
        "                              <p:childTnLst>\n"
        f'                                <p:animMotion origin="{_e(origin)}" path="{_e(path)}" pathEditMode="relative" rAng="0">\n'
        f'                                  <p:cBhvr><p:cTn id="{motion_id}" dur="{duration}"{ease} fill="hold"/><p:tgtEl>{sp_tgt}</p:tgtEl><p:attrNameLst><p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr>\n'
        '                                  <p:rCtr x="0" y="0"/>\n'
        "                                </p:animMotion>\n"
        "                              </p:childTnLst>\n"
        "                            </p:cTn>\n"
        "                          </p:par>"
    )
    return xml, next_id


def _animation_list(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        for key in ("effects", "items", "animations"):
            items = value.get(key)
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict)]
        return [value]
    return []


def _paragraph_count(element: dict[str, Any]) -> int:
    runs = element.get("runs")
    if isinstance(runs, list) and runs:
        return 1
    text = element.get("text")
    if text is None:
        return 1
    return max(1, len(str(text).split("\n")))


def _build_reveal_effect(animation: dict[str, Any]) -> str:
    """The per-paragraph reveal effect used inside a text build."""
    raw = animation.get("buildEffect") or animation.get("reveal") or "fade"
    effect = _animation_effect({"effect": raw})
    if not _is_supported_effect(effect) or effect == "motionPath":
        return "fade"
    return effect


_EMPHASIS_EFFECTS = {"spin", "grow", "shrink", "pulse"}


def _is_entrance_effect(effect: str) -> bool:
    return effect == "appear" or effect in _ANIM_EFFECT_FILTERS or effect in _MOTION_ENTRANCES


def _is_supported_effect(effect: str) -> bool:
    if effect in {"appear", "motionPath", "recolor", "compose"} or effect in _EMPHASIS_EFFECTS or effect in _MOTION_ENTRANCES:
        return True
    base = effect[len("exit-"):] if effect.startswith("exit-") else effect
    return base in _ANIM_EFFECT_FILTERS


def _animation_effect(animation: dict[str, Any]) -> str:
    value = str(animation.get("effect") or animation.get("type") or "fade").strip()
    lowered = value.lower().replace("_", "-").replace(" ", "-")
    if lowered in {"entrance-fade", "fade-in", "fade", "opacity"}:
        return "fade"
    if lowered in {"appear", "entrance-appear"}:
        return "appear"
    if lowered in {"compose", "combo", "composite", "choreography"}:
        return "compose"
    if lowered in {"motion", "motion-path", "motionpath", "path"}:
        return "motionPath"
    if lowered in {"spin", "rotate", "emphasis-spin"}:
        return "spin"
    if lowered in {"grow", "grow-shrink", "growshrink", "scale-up", "scaleup", "emphasis-grow"}:
        return "grow"
    if lowered in {"shrink", "scale-down", "scaledown", "emphasis-shrink"}:
        return "shrink"
    if lowered in {"pulse", "emphasis-pulse"}:
        return "pulse"
    # Exit reveals: "exit-fade", "fade-out", "fadeout", "exit-wipe", ...
    if lowered in {"fade-out", "fadeout"} or lowered.startswith("exit-"):
        base = lowered[len("exit-"):] if lowered.startswith("exit-") else "fade"
        base = base.replace("-", "")
        if base in _ANIM_EFFECT_FILTERS:
            return f"exit-{base}"
    # Entrance filter family: strip "entrance-" prefix and dashes.
    base = lowered[len("entrance-"):] if lowered.startswith("entrance-") else lowered
    base = base.replace("-", "")
    if base in _ANIM_EFFECT_FILTERS:
        return base
    return value


def _animation_trigger(animation: dict[str, Any]) -> str:
    value = str(animation.get("trigger") or animation.get("start") or "onClick").strip().lower()
    value = value.replace("_", "").replace("-", "").replace(" ", "")
    if value in {"withprevious", "with"}:
        return "withPrevious"
    if value in {"afterprevious", "after", "auto"}:
        return "afterPrevious"
    return "onClick"


def _resolve_animation_targets(animation: dict[str, Any], target_map: dict[str, list[int]], shape_ids: set[int]) -> list[int]:
    direct_shape_id = animation.get("shapeId") or animation.get("spid")
    if direct_shape_id is not None:
        try:
            spid = int(direct_shape_id)
        except (TypeError, ValueError):
            spid = -1
        if spid in shape_ids:
            return [spid]
    target_values = []
    for key in ("target", "targetKey", "sourceKey", "name", "id"):
        value = animation.get(key)
        if value is not None:
            target_values.extend(_target_values(value))
    resolved: list[int] = []
    for value in target_values:
        for spid in target_map.get(_target_key(value), []):
            if spid not in resolved:
                resolved.append(spid)
    return resolved


def _register_element_targets(target_map: dict[str, list[int]], element: dict[str, Any], name: str, shape_ids: list[int]) -> None:
    if not shape_ids:
        return
    values: list[Any] = [
        name,
        element.get("name"),
        element.get("id"),
        element.get("key"),
        element.get("sourceKey"),
        element.get("morphKey"),
        element.get("morphId"),
        element.get("objectKey"),
    ]
    values.extend(_target_values(element.get("source")))
    if len(shape_ids) == 1:
        values.append(f"shape:{shape_ids[0]}")
    for value in values:
        for spid in shape_ids:
            _register_target(target_map, value, spid)


def _register_target(target_map: dict[str, list[int]], value: Any, shape_id: int) -> None:
    for candidate in _target_values(value):
        key = _target_key(candidate)
        if not key:
            continue
        target_map.setdefault(key, [])
        if shape_id not in target_map[key]:
            target_map[key].append(shape_id)


def _target_values(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        items: list[Any] = []
        for item in value:
            items.extend(_target_values(item))
        return items
    if isinstance(value, dict):
        items = []
        for key in ("key", "id", "name", "sourceKey"):
            if value.get(key) is not None:
                items.append(value.get(key))
        return items
    return [value]


def _target_key(value: Any) -> str:
    return str(value or "").strip().lower()


def _element_name(element: dict[str, Any], shape_id: int, prefix: str) -> str:
    morph_key = element.get("morphKey") or element.get("morphId") or element.get("objectKey")
    if morph_key:
        return _morph_shape_name(morph_key)
    return str(element.get("name") or element.get("id") or f"{prefix} {shape_id}")


def _morph_shape_name(value: Any) -> str:
    text = str(value or "").strip()
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    safe = re.sub(r"[^A-Za-z0-9_.:-]+", "_", text).strip("_")
    if not safe:
        safe = digest
    if len(safe) > 64:
        safe = f"{safe[:48]}_{digest}"
    return f"!!{safe}"


def _ms(value: Any, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return max(0, int(round(float(value))))
    text = str(value).strip().lower()
    try:
        if text.endswith("ms"):
            return max(0, int(round(float(text[:-2].strip()))))
        if text.endswith("s"):
            return max(0, int(round(float(text[:-1].strip()) * 1000)))
        return max(0, int(round(float(text))))
    except ValueError:
        return default


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _compose_opacity(animation: dict[str, Any]) -> str:
    value = str(animation.get("opacity") or animation.get("fade") or "").strip().lower()
    value = value.replace("-", "").replace("_", "").replace(" ", "")
    if value in {"in", "fadein", "entrance", "appear", "on"}:
        return "in"
    if value in {"out", "fadeout", "exit", "disappear", "off"}:
        return "out"
    return ""


def _compose_is_entrance(animation: dict[str, Any]) -> bool:
    return _compose_opacity(animation) == "in"


def _emu(value: Any, scale: float) -> int:
    return int(round(float(value) * scale))


def _rotation_attr(value: Any) -> str:
    try:
        degrees = float(value)
    except (TypeError, ValueError):
        return ""
    if abs(degrees) < 0.001:
        return ""
    return f' rot="{int(round(degrees * 60000))}"'


def _ease_attr(animation: dict[str, Any]) -> str:
    # accel/decel are fractions of the behavior duration in 1/1000 (0..100000).
    # Default to ease-out: motion that decelerates into place reads as premium.
    ease = str(animation.get("ease", "out")).strip().lower()
    if ease in {"", "out", "easeout", "ease-out"}:
        return ' decel="50000"'
    if ease in {"in", "easein", "ease-in"}:
        return ' accel="50000"'
    if ease in {"inout", "in-out", "smooth", "easeinout", "ease-in-out"}:
        return ' accel="30000" decel="30000"'
    return ""  # linear / none


def _repeat_attr(animation: dict[str, Any]) -> str:
    # CSS animation-iteration-count -> OOXML repeatCount (1000 = one play).
    repeat = animation.get("repeat")
    if repeat is None:
        return ""
    r = str(repeat).strip().lower()
    if r in {"infinite", "indefinite"}:
        return ' repeatCount="indefinite"'
    try:
        n = float(r)
    except (TypeError, ValueError):
        return ""
    return f' repeatCount="{int(round(n * 1000))}"' if n > 1 else ""


def _autorev_attr(animation: dict[str, Any]) -> str:
    return ' autoRev="1"' if animation.get("autoRev") else ""


def _flip_attr(flip_h: bool, flip_v: bool) -> str:
    # CT_Transform2D attribute order: rot, flipH, flipV.
    attr = ""
    if flip_h:
        attr += ' flipH="1"'
    if flip_v:
        attr += ' flipV="1"'
    return attr


def _hex(value: Any) -> str:
    text = str(value).strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    return text.upper()


def _alpha(value: Any) -> float:
    try:
        alpha = float(value)
    except (TypeError, ValueError):
        return 1.0
    return max(0.0, min(1.0, alpha))


def _srgb_xml(hex_value: str, alpha: float = 1.0) -> str:
    alpha = _alpha(alpha)
    if alpha >= 0.999:
        return f'<a:srgbClr val="{_hex(hex_value)}"/>'
    return f'<a:srgbClr val="{_hex(hex_value)}"><a:alpha val="{int(round(alpha * 100000))}"/></a:srgbClr>'


def _scheme_token(value: Any) -> str | None:
    """Return the theme color slot name if value references one, else None."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.lower().startswith("scheme:"):
        text = text.split(":", 1)[1].strip()
    return text if text in _SCHEME_TOKENS else None


def _color_xml(value: Any, alpha: float = 1.0) -> str:
    """Emit a scheme color reference for theme tokens, else a concrete srgb color."""
    token = _scheme_token(value)
    if token is None:
        return _srgb_xml(_hex(value), alpha)
    alpha = _alpha(alpha)
    if alpha >= 0.999:
        return f'<a:schemeClr val="{token}"/>'
    return f'<a:schemeClr val="{token}"><a:alpha val="{int(round(alpha * 100000))}"/></a:schemeClr>'


def _e(value: Any) -> str:
    return escape(str(value), {'"': "&quot;"})


def _default_text_style() -> str:
    return (
        "  <p:defaultTextStyle>\n"
        "    <a:defPPr><a:defRPr lang=\"zh-CN\"><a:latin typeface=\"Times New Roman\"/><a:ea typeface=\"Songti SC\"/></a:defRPr></a:defPPr>\n"
        "  </p:defaultTextStyle>"
    )


def _notes_clr_map() -> str:
    return ('<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" '
            'accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" '
            'accent6="accent6" hlink="hlink" folHlink="folHlink"/>')


def _write_notes_master(root: Path) -> None:
    _write(
        root / "ppt/notesMasters/notesMaster1.xml",
        _xml_header(
            f'<p:notesMaster xmlns:a="{NS["a"]}" xmlns:r="{NS["r"]}" xmlns:p="{NS["p"]}">\n'
            "  <p:cSld>\n"
            "    <p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg>\n"
            "    <p:spTree>\n"
            "      <p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\n"
            "      <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>\n"
            "      <p:sp>\n"
            "        <p:nvSpPr><p:cNvPr id=\"2\" name=\"Notes Placeholder 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr>\n"
            "        <p:spPr><a:xfrm><a:off x=\"685800\" y=\"1143000\"/><a:ext cx=\"5486400\" cy=\"6858000\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>\n"
            "        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p></p:txBody>\n"
            "      </p:sp>\n"
            "    </p:spTree>\n"
            "  </p:cSld>\n"
            f"  {_notes_clr_map()}\n"
            "</p:notesMaster>\n"
        ),
    )
    _write(
        root / "ppt/notesMasters/_rels/notesMaster1.xml.rels",
        _rel_xml([("rId1", f"{OFFICE_REL}/theme", "../theme/theme1.xml", None)]),
    )


def _notes_slide_xml(text: str) -> str:
    paragraphs = []
    for line in (str(text).split("\n") or [""]):
        if line.strip():
            paragraphs.append(f'<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>{_e(line)}</a:t></a:r></a:p>')
        else:
            paragraphs.append("<a:p><a:endParaRPr lang=\"en-US\"/></a:p>")
    body = "".join(paragraphs) or "<a:p><a:endParaRPr lang=\"en-US\"/></a:p>"
    return _xml_header(
        f'<p:notes xmlns:a="{NS["a"]}" xmlns:r="{NS["r"]}" xmlns:p="{NS["p"]}">\n'
        "  <p:cSld>\n"
        "    <p:spTree>\n"
        "      <p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\n"
        "      <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>\n"
        "      <p:sp>\n"
        "        <p:nvSpPr><p:cNvPr id=\"2\" name=\"Notes Placeholder 1\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr>\n"
        "        <p:spPr/>\n"
        f"        <p:txBody><a:bodyPr/><a:lstStyle/>{body}</p:txBody>\n"
        "      </p:sp>\n"
        "    </p:spTree>\n"
        "  </p:cSld>\n"
        "  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>\n"
        "</p:notes>\n"
    )


def _slide_master_xml() -> str:
    return _xml_header(
        f'<p:sldMaster xmlns:a="{NS["a"]}" xmlns:r="{NS["r"]}" xmlns:p="{NS["p"]}">\n'
        "  <p:cSld>\n"
        "    <p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>\n"
        "    <p:spTree>\n"
        "      <p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\n"
        "      <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>\n"
        "    </p:spTree>\n"
        "  </p:cSld>\n"
        "  <p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>\n"
        "  <p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst>\n"
        "  <p:txStyles>\n"
        "    <p:titleStyle/><p:bodyStyle/><p:otherStyle/>\n"
        "  </p:txStyles>\n"
        "</p:sldMaster>\n"
    )


def _slide_layout_xml() -> str:
    return _xml_header(
        f'<p:sldLayout xmlns:a="{NS["a"]}" xmlns:r="{NS["r"]}" xmlns:p="{NS["p"]}" type="blank" preserve="1">\n'
        "  <p:cSld name=\"Blank\">\n"
        "    <p:spTree>\n"
        "      <p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\n"
        "      <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>\n"
        "    </p:spTree>\n"
        "  </p:cSld>\n"
        "  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>\n"
        "</p:sldLayout>\n"
    )


def _theme_xml(theme: Any = None) -> str:
    theme = theme if isinstance(theme, dict) else {}
    name = _e(str(theme.get("name", "PPTX Native")))
    raw_colors = theme.get("colors") if isinstance(theme.get("colors"), dict) else {}
    colors = {**_DEFAULT_THEME_COLORS, **{k: _hex(v) for k, v in raw_colors.items() if v}}
    raw_fonts = theme.get("fonts") if isinstance(theme.get("fonts"), dict) else {}
    fonts = {**_DEFAULT_THEME_FONTS, **{k: str(v) for k, v in raw_fonts.items() if v}}
    accents = "".join(
        f'      <a:accent{i}><a:srgbClr val="{colors[f"accent{i}"]}"/></a:accent{i}>\n'
        for i in range(1, 7)
    )
    return _xml_header(
        f'<a:theme xmlns:a="{NS["a"]}" name="{name}">\n'
        "  <a:themeElements>\n"
        "    <a:clrScheme name=\"Native\">\n"
        "      <a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1>\n"
        "      <a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1>\n"
        f'      <a:dk2><a:srgbClr val="{colors["dk2"]}"/></a:dk2>\n'
        f'      <a:lt2><a:srgbClr val="{colors["lt2"]}"/></a:lt2>\n'
        f"{accents}"
        f'      <a:hlink><a:srgbClr val="{colors["hlink"]}"/></a:hlink>\n'
        f'      <a:folHlink><a:srgbClr val="{colors["folHlink"]}"/></a:folHlink>\n'
        "    </a:clrScheme>\n"
        "    <a:fontScheme name=\"Native\">\n"
        f'      <a:majorFont><a:latin typeface="{_e(fonts["majorLatin"])}"/><a:ea typeface="{_e(fonts["majorEa"])}"/><a:cs typeface="{_e(fonts["majorLatin"])}"/></a:majorFont>\n'
        f'      <a:minorFont><a:latin typeface="{_e(fonts["minorLatin"])}"/><a:ea typeface="{_e(fonts["minorEa"])}"/><a:cs typeface="{_e(fonts["minorLatin"])}"/></a:minorFont>\n'
        "    </a:fontScheme>\n"
        "    <a:fmtScheme name=\"Native\">\n"
        "      <a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst>\n"
        "      <a:lnStyleLst><a:ln w=\"9525\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln><a:ln w=\"25400\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln><a:ln w=\"38100\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln></a:lnStyleLst>\n"
        "      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>\n"
        "      <a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst>\n"
        "    </a:fmtScheme>\n"
        "  </a:themeElements>\n"
        "  <a:objectDefaults/>\n"
        "  <a:extraClrSchemeLst/>\n"
        "</a:theme>\n"
    )
