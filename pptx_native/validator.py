from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any

from .ooxml import (
    CONTENT_TYPES_NS,
    NS,
    is_internal_target_present,
    local_name,
    package_files,
    parse_xml,
    presentation_slides,
    q,
    read_relationships,
    relationship_refs,
    rels_path_to_part,
)


REQUIRED_PARTS = [
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
]


def _content_type_maps(root: Path) -> tuple[set[str], set[str]]:
    path = root / "[Content_Types].xml"
    if not path.exists():
        return set(), set()
    tree = parse_xml(path)
    defaults = set()
    overrides = set()
    for child in tree.getroot():
        if local_name(child.tag) == "Default" and child.attrib.get("Extension"):
            defaults.add(child.attrib["Extension"].lower())
        if local_name(child.tag) == "Override" and child.attrib.get("PartName"):
            overrides.add(child.attrib["PartName"].lstrip("/"))
    return defaults, overrides


def validate_package(root: Path) -> dict[str, Any]:
    root = root.resolve()
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    for required in REQUIRED_PARTS:
        if not (root / required).exists():
            errors.append({"code": "missing_required_part", "part": required})
    if errors:
        return {"ok": False, "errors": errors, "warnings": warnings, "stats": {}}

    defaults, overrides = _content_type_maps(root)
    files = package_files(root)
    rel_counts = Counter()
    for file_path in files:
        rel = file_path.relative_to(root).as_posix()
        if rel.startswith("_rels/") or "/_rels/" in rel:
            if file_path.suffix.lower() != ".rels":
                continue
        elif rel not in overrides:
            extension = file_path.suffix.lower().lstrip(".")
            if extension and extension not in defaults:
                errors.append({"code": "missing_content_type", "part": rel, "extension": extension})

    for rels_path in root.rglob("*.rels"):
        if rels_path.parent.name != "_rels":
            continue
        source_part = rels_path_to_part(rels_path, root)
        if source_part != root and not source_part.exists():
            errors.append(
                {
                    "code": "relationship_source_missing",
                    "rels": rels_path.relative_to(root).as_posix(),
                    "part": source_part.relative_to(root).as_posix(),
                }
            )
            continue
        rels = read_relationships(source_part, root)
        for rel in rels.values():
            rel_counts[rel.get("typeName")] += 1
            if not is_internal_target_present(source_part, root, rel):
                errors.append(
                    {
                        "code": "missing_relationship_target",
                        "part": "." if source_part == root else source_part.relative_to(root).as_posix(),
                        "rid": rel.get("id"),
                        "type": rel.get("typeName"),
                        "target": rel.get("target"),
                    }
                )

    for xml_path in files:
        if xml_path.suffix.lower() != ".xml":
            continue
        if xml_path.name.endswith(".rels"):
            continue
        try:
            xml_root = parse_xml(xml_path).getroot()
        except Exception as exc:  # pragma: no cover - carries parser details.
            errors.append({"code": "xml_parse_error", "part": xml_path.relative_to(root).as_posix(), "message": str(exc)})
            continue
        rels = read_relationships(xml_path, root)
        for ref in relationship_refs(xml_root):
            if ref["rid"] not in rels:
                errors.append(
                    {
                        "code": "missing_local_relationship",
                        "part": xml_path.relative_to(root).as_posix(),
                        "element": ref["element"],
                        "attr": ref["attr"],
                        "rid": ref["rid"],
                    }
                )
        for body_pr in xml_root.findall(".//a:bodyPr", NS):
            anchor = body_pr.attrib.get("anchor")
            if anchor and anchor not in {"t", "ctr", "b", "just", "dist"}:
                errors.append(
                    {
                        "code": "invalid_text_anchor",
                        "part": xml_path.relative_to(root).as_posix(),
                        "anchor": anchor,
                    }
                )

    slides, _ = presentation_slides(root)
    for slide in slides:
        if not slide.get("path") or not (root / str(slide["path"])).exists():
            errors.append({"code": "presentation_slide_missing", "slide": slide["number"], "path": slide.get("path")})
            continue
        slide_root = parse_xml(root / str(slide["path"])).getroot()
        shape_ids = {shape.attrib.get("id") for shape in slide_root.findall(".//p:cNvPr", NS) if shape.attrib.get("id")}
        timing = slide_root.find("./p:timing", NS)
        if timing is not None:
            for target in timing.findall(".//p:spTgt", NS):
                spid = target.attrib.get("spid")
                if spid and spid not in shape_ids:
                    errors.append(
                        {
                            "code": "missing_timing_target_shape",
                            "slide": slide["number"],
                            "path": slide["path"],
                            "spid": spid,
                        }
                    )
        transition = slide_root.find(".//p:transition", NS)
        if transition is not None and transition.attrib.get(q("r", "id")):
            rid = transition.attrib[q("r", "id")]
            rels = read_relationships(root / str(slide["path"]), root)
            if rid not in rels:
                errors.append(
                    {
                        "code": "missing_transition_relationship",
                        "slide": slide["number"],
                        "path": slide["path"],
                        "rid": rid,
                    }
                )

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "stats": {
            "files": len(files),
            "slides": len(slides),
            "relationshipsByType": dict(rel_counts),
        },
    }
