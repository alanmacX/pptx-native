from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any

from .ooxml import (
    NS,
    bbox_of,
    cnvpr_for_shape,
    creation_id,
    iter_shape_elements,
    local_name,
    package_files,
    parse_xml,
    presentation_slides,
    preset_geometry,
    q,
    read_relationships,
    relationship_refs,
    resolve_relationship_target,
    sha1_short,
    shape_kind,
    text_of,
    write_json,
)


def _shape_record(shape, path_hint: str, rels: dict[str, dict[str, str | None]]) -> dict[str, Any]:
    cnvpr = cnvpr_for_shape(shape)
    refs = []
    for ref in relationship_refs(shape):
        rel = rels.get(ref["rid"])
        refs.append(
            {
                **ref,
                "type": rel.get("typeName") if rel else None,
                "target": rel.get("target") if rel else None,
            }
        )
    alternate_variant = None
    if "/Choice[" in path_hint:
        alternate_variant = "Choice"
    elif "/Fallback[" in path_hint:
        alternate_variant = "Fallback"
    return {
        "xmlPathHint": path_hint,
        "alternateContentVariant": alternate_variant,
        "xmlTag": local_name(shape.tag),
        "kind": shape_kind(shape),
        "id": cnvpr.attrib.get("id") if cnvpr is not None else None,
        "name": cnvpr.attrib.get("name") if cnvpr is not None else None,
        "descr": cnvpr.attrib.get("descr") if cnvpr is not None else None,
        "creationId": creation_id(cnvpr),
        "text": text_of(shape),
        "bboxEmu": bbox_of(shape),
        "geometry": preset_geometry(shape),
        "relationshipRefs": refs,
    }


ANIMATION_ACTION_TAGS = {
    "anim",
    "animClr",
    "animEffect",
    "animMotion",
    "animRot",
    "animScale",
    "audio",
    "cmd",
    "set",
    "video",
}


def _walk(element, parent_path: str = ""):
    children = list(element)
    seen = Counter()
    for child in children:
        name = local_name(child.tag)
        seen[name] += 1
        path = f"{parent_path}/{name}[{seen[name]}]" if parent_path else f"{name}[{seen[name]}]"
        yield child, path
        yield from _walk(child, path)


def _transition_info(slide_root) -> dict[str, Any] | None:
    variants = []
    for node, path in _walk(slide_root, local_name(slide_root.tag)):
        if local_name(node.tag) != "transition":
            continue
        children = [local_name(child.tag) for child in list(node)]
        morph = next((child for child in list(node) if local_name(child.tag) == "morph"), None)
        variant = "Choice" if "/Choice[" in path else "Fallback" if "/Fallback[" in path else "Primary"
        variants.append(
            {
                "path": path,
                "variant": variant,
                "attrs": dict(node.attrib),
                "children": children,
                "morph": dict(morph.attrib) if morph is not None else None,
            }
        )
    if not variants:
        return None
    primary = next((item for item in variants if item["variant"] == "Choice"), variants[0])
    kind = "morph" if primary.get("morph") is not None else (primary["children"][0] if primary["children"] else None)
    return {
        "kind": kind,
        "attrs": primary["attrs"],
        "children": primary["children"],
        "morph": primary.get("morph"),
        "variants": variants,
    }


def _timing_effect_records(timing) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []

    def walk(node, path: str, active_ctn: dict[str, str] | None) -> None:
        children = list(node)
        seen = Counter()
        for child in children:
            name = local_name(child.tag)
            seen[name] += 1
            child_path = f"{path}/{name}[{seen[name]}]" if path else f"{name}[{seen[name]}]"
            child_ctn = dict(child.attrib) if name == "cTn" else active_ctn
            if name in ANIMATION_ACTION_TAGS:
                records.append(
                    {
                        "path": child_path,
                        "tag": name,
                        "attrs": dict(child.attrib),
                        "targets": [
                            target.attrib.get("spid")
                            for target in child.findall(".//p:spTgt", NS)
                            if target.attrib.get("spid")
                        ],
                        "attrNames": [attr.text for attr in child.findall(".//p:attrName", NS) if attr.text],
                        "preset": {
                            key: child_ctn.get(key)
                            for key in ("presetClass", "presetID", "presetSubtype", "nodeType", "dur", "fill")
                            if child_ctn and child_ctn.get(key) is not None
                        }
                        if child_ctn
                        else None,
                    }
                )
            walk(child, child_path, child_ctn)

    walk(timing, "timing", None)
    return records


def _timing_info(slide_root, shapes: list[dict[str, Any]]) -> dict[str, Any] | None:
    timing = slide_root.find("./p:timing", NS)
    if timing is None:
        return None
    by_id = {}
    for shape in shapes:
        if not shape.get("id"):
            continue
        shape_id = str(shape["id"])
        record = {
            "name": shape["name"],
            "kind": shape["kind"],
            "text": shape["text"],
            "alternateContentVariant": shape.get("alternateContentVariant"),
        }
        if shape_id not in by_id or shape.get("alternateContentVariant") == "Choice":
            by_id[shape_id] = record
    targets = []
    for target in timing.findall(".//p:spTgt", NS):
        spid = target.attrib.get("spid")
        targets.append({"spid": spid, **by_id.get(str(spid), {})})
    unique_targets = []
    seen = set()
    for target in targets:
        spid = target.get("spid")
        if spid in seen:
            continue
        seen.add(spid)
        unique_targets.append(target)
    tag_counts = Counter(local_name(node.tag) for node in timing.iter())
    node_counts = Counter(local_name(node.tag) for node in timing.iter() if local_name(node.tag) in ANIMATION_ACTION_TAGS)
    return {
        "targets": unique_targets,
        "animationNodeCounts": dict(node_counts),
        "timingTagCounts": dict(tag_counts),
        "effects": _timing_effect_records(timing),
    }


def _notes_text(slide_path: Path, root: Path, rels: dict[str, dict[str, str | None]]) -> str | None:
    notes_rel = next((rel for rel in rels.values() if rel.get("typeName") == "notesSlide"), None)
    if not notes_rel:
        return None
    notes_path = resolve_relationship_target(slide_path, root, notes_rel.get("target"))
    if notes_path is None or not notes_path.exists():
        return None
    return text_of(parse_xml(notes_path).getroot())


def build_index(root: Path) -> dict[str, Any]:
    root = root.resolve()
    slides_base, slide_size = presentation_slides(root)
    slides = []
    relationship_counts = Counter()
    layout_usage = Counter()
    for slide in slides_base:
        slide_path = root / str(slide["path"])
        slide_root = parse_xml(slide_path).getroot()
        rels = read_relationships(slide_path, root)
        for rel in rels.values():
            relationship_counts[rel.get("typeName")] += 1
        layout = next((rel for rel in rels.values() if rel.get("typeName") == "slideLayout"), None)
        notes = next((rel for rel in rels.values() if rel.get("typeName") == "notesSlide"), None)
        if layout:
            layout_usage[str(layout.get("target"))] += 1
        shape_tree = slide_root.find("./p:cSld/p:spTree", NS)
        shapes = []
        if shape_tree is not None:
            shapes = [_shape_record(shape, path, rels) for shape, path in iter_shape_elements(shape_tree)]
        slides.append(
            {
                **slide,
                "layout": layout.get("target") if layout else None,
                "notes": notes.get("target") if notes else None,
                "notesText": _notes_text(slide_path, root, rels),
                "shapeCount": len(shapes),
                "shapeKinds": dict(Counter(shape["kind"] for shape in shapes)),
                "shapes": shapes,
                "relationships": [
                    {
                        "id": rel["id"],
                        "type": rel["typeName"],
                        "target": rel["target"],
                        "targetMode": rel["targetMode"],
                    }
                    for rel in sorted(rels.values(), key=lambda item: str(item["id"]))
                ],
                "transition": _transition_info(slide_root),
                "timing": _timing_info(slide_root, shapes),
            }
        )
    media_dir = root / "ppt/media"
    media = []
    if media_dir.exists():
        for path in sorted(media_dir.iterdir()):
            if path.is_file():
                media.append(
                    {
                        "path": path.relative_to(root).as_posix(),
                        "bytes": path.stat().st_size,
                        "sha1": sha1_short(path),
                        "extension": path.suffix.lower().lstrip("."),
                    }
                )
    files = package_files(root)
    return {
        "unpackedRoot": str(root),
        "slideSizeEmu": slide_size,
        "counts": {
            "files": len(files),
            "slides": len(slides),
            "slideLayouts": len(list((root / "ppt/slideLayouts").glob("slideLayout*.xml"))),
            "slideMasters": len(list((root / "ppt/slideMasters").glob("slideMaster*.xml"))),
            "notesSlides": len(list((root / "ppt/notesSlides").glob("notesSlide*.xml"))),
            "media": len(media),
            "relationshipsByType": dict(relationship_counts),
            "slidesWithTiming": [slide["number"] for slide in slides if slide["timing"]],
            "slidesWithTransition": [slide["number"] for slide in slides if slide["transition"]],
            "slidesWithMorph": [slide["number"] for slide in slides if slide["transition"] and slide["transition"].get("kind") == "morph"],
        },
        "layoutUsage": dict(layout_usage),
        "media": media,
        "slides": slides,
    }


def write_index(root: Path, out_path: Path) -> dict[str, Any]:
    index = build_index(root)
    write_json(out_path, index)
    return index
