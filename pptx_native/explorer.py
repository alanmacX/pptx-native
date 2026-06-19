from __future__ import annotations

import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from .indexer import build_index
from .ooxml import (
    NS,
    cnvpr_for_shape,
    creation_id,
    local_name,
    package_files,
    parse_xml,
    q,
    read_relationships,
    relationship_refs,
    resolve_relationship_target,
    sha1_short,
    write_json,
)


XML_NAMESPACES_RE = re.compile(r"\sxmlns(?::(?P<prefix>[A-Za-z_][\w.-]*))?=(?P<quote>['\"])(?P<uri>.*?)(?P=quote)")


def _raw_namespaces(path: Path) -> dict[str, str]:
    if path.suffix.lower() not in {".xml", ".rels"}:
        return {}
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")[:8000]
    except UnicodeDecodeError:
        return {}
    namespaces = {}
    for match in XML_NAMESPACES_RE.finditer(text):
        namespaces[match.group("prefix") or ""] = match.group("uri")
    return namespaces


def _element_path(parent_path: str, element: ET.Element, index: int) -> str:
    return f"{parent_path}/{local_name(element.tag)}[{index}]"


def _walk(element: ET.Element, parent_path: str = ""):
    children_by_tag = Counter(local_name(child.tag) for child in list(element))
    seen = Counter()
    for child in list(element):
        name = local_name(child.tag)
        seen[name] += 1
        yield child, _element_path(parent_path or local_name(element.tag), child, seen[name]), children_by_tag[name]
        yield from _walk(child, _element_path(parent_path or local_name(element.tag), child, seen[name]))


def _attrib_inventory(element: ET.Element, limit: int | None = None) -> list[dict[str, Any]]:
    rows = []
    root_name = local_name(element.tag)
    stack = [(element, root_name)]
    while stack:
        node, path = stack.pop()
        for attr, value in node.attrib.items():
            rows.append({"path": path, "element": local_name(node.tag), "attr": local_name(attr), "value": value})
            if limit is not None and len(rows) >= limit:
                return rows
        children = list(node)
        counters = Counter(local_name(child.tag) for child in children)
        seen = Counter()
        for child in reversed(children):
            name = local_name(child.tag)
            counters[name] -= 1
            # Push in reverse, but compute stable 1-based index from original order.
        seen.clear()
        ordered_children = []
        for child in children:
            name = local_name(child.tag)
            seen[name] += 1
            ordered_children.append((child, f"{path}/{name}[{seen[name]}]"))
        for child, child_path in reversed(ordered_children):
            stack.append((child, child_path))
    return rows


def _text_runs(element: ET.Element) -> list[dict[str, Any]]:
    runs = []
    for paragraph_index, paragraph in enumerate(element.findall(".//a:p", NS), 1):
        for run_index, run in enumerate(paragraph.findall("./a:r", NS), 1):
            text = run.find("./a:t", NS)
            r_pr = run.find("./a:rPr", NS)
            runs.append(
                {
                    "paragraph": paragraph_index,
                    "run": run_index,
                    "text": text.text if text is not None else "",
                    "rPr": dict(r_pr.attrib) if r_pr is not None else {},
                }
            )
    return runs


def _shape_native_record(shape: ET.Element, compact_shape: dict[str, Any], include_xml: bool) -> dict[str, Any]:
    cnvpr = cnvpr_for_shape(shape)
    record = {
        "objectKey": None,
        "id": compact_shape.get("id"),
        "name": compact_shape.get("name"),
        "kind": compact_shape.get("kind"),
        "xmlTag": compact_shape.get("xmlTag"),
        "xmlPathHint": compact_shape.get("xmlPathHint"),
        "alternateContentVariant": compact_shape.get("alternateContentVariant"),
        "creationId": creation_id(cnvpr),
        "cNvPr": dict(cnvpr.attrib) if cnvpr is not None else {},
        "bboxEmu": compact_shape.get("bboxEmu"),
        "text": compact_shape.get("text"),
        "textRuns": _text_runs(shape),
        "relationshipRefs": compact_shape.get("relationshipRefs", []),
        "attributePaths": _attrib_inventory(shape),
        "relationshipRefPaths": relationship_refs(shape),
        "rawXmlSha1": None,
    }
    raw_xml = ET.tostring(shape, encoding="utf-8")
    import hashlib

    record["rawXmlSha1"] = hashlib.sha1(raw_xml).hexdigest()[:12]
    if include_xml:
        record["rawXml"] = raw_xml.decode("utf-8")
    return record


def _collect_shape_elements(slide_root: ET.Element) -> dict[str, list[ET.Element]]:
    # Map cNvPr id to all concrete variants. AlternateContent can legitimately
    # duplicate an id for Choice/Fallback, so keep a list.
    interesting = {"sp", "pic", "graphicFrame", "cxnSp", "grpSp"}
    result: dict[str, list[ET.Element]] = defaultdict(list)

    def walk(node: ET.Element) -> None:
        for child in list(node):
            if local_name(child.tag) in interesting:
                cnvpr = cnvpr_for_shape(child)
                if cnvpr is not None and cnvpr.attrib.get("id"):
                    result[cnvpr.attrib["id"]].append(child)
                walk(child)
            else:
                walk(child)

    walk(slide_root)
    return result


def _timing_nodes(slide_root: ET.Element) -> list[dict[str, Any]]:
    timing = slide_root.find("./p:timing", NS)
    if timing is None:
        return []
    rows = []
    for node, path, _sibling_count in _walk(timing, "timing"):
        name = local_name(node.tag)
        row = {"path": path, "tag": name, "attrs": dict(node.attrib)}
        if name == "spTgt":
            row["spid"] = node.attrib.get("spid")
        if name == "attrName":
            row["text"] = node.text
        rows.append(row)
    return rows


def _transition_nodes(slide_root: ET.Element) -> list[dict[str, Any]]:
    rows = []
    for node, path, _sibling_count in _walk(slide_root, local_name(slide_root.tag)):
        if local_name(node.tag) == "transition":
            morph = next((child for child in list(node) if local_name(child.tag) == "morph"), None)
            rows.append(
                {
                    "path": path,
                    "variant": "Choice" if "/Choice[" in path else "Fallback" if "/Fallback[" in path else "Primary",
                    "attrs": dict(node.attrib),
                    "children": [local_name(child.tag) for child in list(node)],
                    "morph": dict(morph.attrib) if morph is not None else None,
                }
            )
    return rows


def _part_record(path: Path, root: Path) -> dict[str, Any]:
    rel = path.relative_to(root).as_posix()
    record = {
        "path": rel,
        "bytes": path.stat().st_size,
        "sha1": sha1_short(path),
        "extension": path.suffix.lower().lstrip("."),
        "kind": "binary",
        "namespaces": _raw_namespaces(path),
        "relationships": [],
        "xml": None,
    }
    if path.suffix.lower() == ".rels":
        record["kind"] = "relationships"
    elif path.suffix.lower() == ".xml" or path.name == "[Content_Types].xml":
        record["kind"] = "xml"
        try:
            root_el = parse_xml(path).getroot()
        except Exception as exc:
            record["xml"] = {"parseError": str(exc)}
        else:
            tag_counts = Counter(local_name(node.tag) for node in root_el.iter())
            attr_counts = Counter(local_name(attr) for node in root_el.iter() for attr in node.attrib)
            record["xml"] = {
                "root": local_name(root_el.tag),
                "tagCounts": dict(tag_counts),
                "attributeCounts": dict(attr_counts),
                "relationshipRefs": relationship_refs(root_el),
                "alternateContentCount": tag_counts.get("AlternateContent", 0),
                "timingCount": tag_counts.get("timing", 0),
                "transitionCount": tag_counts.get("transition", 0),
            }
    if path.suffix.lower() == ".xml" and not path.name.endswith(".rels"):
        rels = read_relationships(path, root)
        record["relationships"] = list(rels.values())
    return record


def build_explore(root: Path, include_xml: bool = False) -> dict[str, Any]:
    root = root.resolve()
    compact = build_index(root)
    parts = [_part_record(path, root) for path in package_files(root)]
    relationship_edges = []
    for part in package_files(root):
        if part.suffix.lower() != ".xml" or part.name.endswith(".rels"):
            continue
        for rel in read_relationships(part, root).values():
            resolved = resolve_relationship_target(part, root, rel.get("target"))
            relationship_edges.append(
                {
                    "from": part.relative_to(root).as_posix(),
                    "rid": rel.get("id"),
                    "type": rel.get("typeName"),
                    "target": rel.get("target"),
                    "targetMode": rel.get("targetMode"),
                    "resolved": resolved.relative_to(root).as_posix() if resolved and resolved.exists() else None,
                }
            )

    slides = []
    for slide in compact["slides"]:
        slide_path = root / str(slide["path"])
        slide_root = parse_xml(slide_path).getroot()
        by_id = _collect_shape_elements(slide_root)
        variant_offsets = Counter()
        controls = []
        for compact_shape in slide["shapes"]:
            shape_id = compact_shape.get("id")
            if not shape_id:
                continue
            variants = by_id.get(str(shape_id), [])
            variant_offsets[str(shape_id)] += 1
            offset = variant_offsets[str(shape_id)] - 1
            shape = variants[min(offset, len(variants) - 1)] if variants else None
            if shape is None:
                continue
            native = _shape_native_record(shape, compact_shape, include_xml)
            variant = native.get("alternateContentVariant") or "Primary"
            native["objectKey"] = f"slide:{slide['number']}:shape:{shape_id}:{variant}"
            controls.append(native)
        slides.append(
            {
                "number": slide["number"],
                "path": slide["path"],
                "layout": slide.get("layout"),
                "notes": slide.get("notes"),
                "controls": controls,
                "timingNodes": _timing_nodes(slide_root),
                "transitionNodes": _transition_nodes(slide_root),
            }
        )

    schema_counts = {
        "partKinds": dict(Counter(part["kind"] for part in parts)),
        "xmlRoots": dict(Counter(part["xml"]["root"] for part in parts if part.get("xml") and part["xml"].get("root"))),
        "relationshipTypes": compact["counts"].get("relationshipsByType", {}),
        "controlKinds": dict(Counter(control["kind"] for slide in slides for control in slide["controls"])),
        "attributeNames": dict(
            Counter(
                attr["attr"]
                for slide in slides
                for control in slide["controls"]
                for attr in control.get("attributePaths", [])
            )
        ),
    }
    return {
        "unpackedRoot": str(root),
        "summary": compact["counts"],
        "schemaInventory": schema_counts,
        "parts": parts,
        "relationshipGraph": relationship_edges,
        "slides": slides,
    }


def write_explore(root: Path, out_path: Path, include_xml: bool = False) -> dict[str, Any]:
    data = build_explore(root, include_xml=include_xml)
    write_json(out_path, data)
    return data
