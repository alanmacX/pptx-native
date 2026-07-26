from __future__ import annotations

import base64
import re
import shutil
from collections import Counter
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from .ooxml import (
    NS,
    bbox_of,
    cnvpr_for_shape,
    direct_xfrm,
    find_shapes,
    image_content_type,
    image_dimensions,
    next_media_name,
    next_rid,
    part_to_rels_path,
    parse_xml,
    presentation_slides,
    read_json,
    read_relationships,
    rels_path_to_part,
    slide_part_for_number,
)
from .validator import validate_package


IMAGE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
NOTES_SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
SLIDE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
SHAPE_TAGS = ("graphicFrame", "grpSp", "cxnSp", "pic", "sp")
ASPECT_TOLERANCE = 0.15
TAG_RE = re.compile(
    r"<(?P<closing>/)?(?P<qname>[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(?P<attrs>\s[^<>]*?)?(?P<self>/)?>",
    re.DOTALL,
)


def _shape_selector(op: dict[str, Any]) -> dict[str, Any]:
    selector = {}
    for key in ("shapeId", "id", "shapeName", "name", "creationId", "kind"):
        if key in op:
            selector[key] = op[key]
    if not selector:
        raise ValueError(f"Patch op needs a shape selector: {op}")
    return selector


def _load_slide(root: Path, op: dict[str, Any]):
    slide_number = int(op.get("slide", op.get("slideNumber", 0)))
    if not slide_number:
        raise ValueError(f"Patch op needs a slide number: {op}")
    slide_path = slide_part_for_number(root, slide_number)
    tree = parse_xml(slide_path)
    slide_root = tree.getroot()
    matches = find_shapes(slide_root, _shape_selector(op))
    if not matches:
        raise ValueError(f"No matching shape for op on slide {slide_number}: {op}")
    return slide_number, slide_path, tree, slide_root, matches


def _slide_path_from_op(root: Path, op: dict[str, Any]) -> tuple[int, Path]:
    slide_number = int(op.get("slide", op.get("slideNumber", 0)))
    if not slide_number:
        raise ValueError(f"Patch op needs a slide number: {op}")
    return slide_number, slide_part_for_number(root, slide_number)


def _matched_shape_ids(matches) -> list[str]:
    ids = []
    seen = set()
    for shape, _path in matches:
        cnvpr = cnvpr_for_shape(shape)
        shape_id = cnvpr.attrib.get("id") if cnvpr is not None else None
        if shape_id and shape_id not in seen:
            seen.add(shape_id)
            ids.append(shape_id)
    return ids


def _last_shape_start(xml: str, c_nv_pr_start: int) -> tuple[int, str]:
    best: tuple[int, str] | None = None
    for tag in SHAPE_TAGS:
        pattern = re.compile(rf"<p:{tag}(?=[\s>])")
        for match in pattern.finditer(xml, 0, c_nv_pr_start):
            if best is None or match.start() > best[0]:
                best = (match.start(), tag)
    if best is None:
        raise ValueError("Could not find enclosing shape element.")
    return best


def _matching_shape_end(xml: str, start: int, tag: str) -> int:
    pattern = re.compile(rf"</?p:{tag}(?=[\s>/])[^>]*>")
    depth = 0
    for match in pattern.finditer(xml, start):
        token = match.group(0)
        if token.startswith("</"):
            depth -= 1
            if depth == 0:
                return match.end()
        elif token.endswith("/>"):
            continue
        else:
            depth += 1
    raise ValueError(f"Could not find closing tag for p:{tag}.")


def _shape_spans_for_id(xml: str, shape_id: str) -> list[tuple[int, int]]:
    id_pattern = re.escape(str(shape_id))
    c_nv_pr_pattern = re.compile(rf"<p:cNvPr\b(?=[^>]*\bid=(['\"]){id_pattern}\1)[^>]*>")
    spans = []
    seen = set()
    for match in c_nv_pr_pattern.finditer(xml):
        start, tag = _last_shape_start(xml, match.start())
        end = _matching_shape_end(xml, start, tag)
        key = (start, end)
        if key not in seen:
            seen.add(key)
            spans.append(key)
    return spans


def _shape_spans_for_ids(xml: str, shape_ids: list[str]) -> list[tuple[int, int]]:
    spans = []
    seen = set()
    for shape_id in shape_ids:
        for span in _shape_spans_for_id(xml, shape_id):
            if span not in seen:
                seen.add(span)
                spans.append(span)
    return sorted(spans)


def _rewrite_spans(xml: str, spans: list[tuple[int, int]], rewrite) -> tuple[str, int, list[dict[str, str]]]:
    changed = 0
    warnings: list[dict[str, str]] = []
    for start, end in sorted(spans, reverse=True):
        segment = xml[start:end]
        new_segment, did_change, segment_warnings = rewrite(segment)
        if did_change:
            xml = xml[:start] + new_segment + xml[end:]
            changed += 1
        warnings.extend(segment_warnings)
    return xml, changed, warnings


def _read_xml_text(path: Path) -> str:
    return path.read_bytes().decode("utf-8")


def _write_xml_text(path: Path, text: str) -> None:
    path.write_bytes(text.encode("utf-8"))


def _escape_attr_value(value: Any, quote: str = '"') -> str:
    replacements = {"&": "&amp;", "<": "&lt;", ">": "&gt;"}
    if quote == '"':
        replacements['"'] = "&quot;"
    else:
        replacements["'"] = "&apos;"
    return "".join(replacements.get(char, char) for char in str(value))


def _split_path(path: str) -> list[tuple[str, int | None]]:
    tokens = []
    for raw in path.strip("/").split("/"):
        if not raw:
            continue
        match = re.fullmatch(r"([A-Za-z_][\w.-]*)(?:\[(\d+)\])?", raw)
        if not match:
            raise ValueError(f"Unsupported XML path token: {raw}")
        tokens.append((match.group(1), int(match.group(2)) if match.group(2) else None))
    if not tokens:
        raise ValueError("XML path cannot be empty.")
    return tokens


def _path_matches(actual: str, requested: str) -> bool:
    actual_tokens = _split_path(actual)
    requested_tokens = _split_path(requested)
    if len(actual_tokens) != len(requested_tokens):
        return False
    for (actual_name, actual_index), (requested_name, requested_index) in zip(actual_tokens, requested_tokens):
        if actual_name != requested_name:
            return False
        if requested_index is not None and actual_index != requested_index:
            return False
    return True


def _local_qname(qname: str) -> str:
    return qname.rsplit(":", 1)[-1]


def _scan_xml_records(xml: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    root_counts: Counter[str] = Counter()
    for match in TAG_RE.finditer(xml):
        qname = match.group("qname")
        local = _local_qname(qname)
        if match.group("closing"):
            for index in range(len(stack) - 1, -1, -1):
                if stack[index]["local"] == local:
                    record = stack.pop(index)
                    record["closeStart"] = match.start()
                    record["end"] = match.end()
                    break
            continue
        parent = stack[-1] if stack else None
        counts = parent["childCounts"] if parent else root_counts
        counts[local] += 1
        child_index = counts[local]
        if parent:
            path = f"{parent['path']}/{local}[{child_index}]"
        else:
            path = local if child_index == 1 else f"{local}[{child_index}]"
        record = {
            "path": path,
            "local": local,
            "qname": qname,
            "start": match.start(),
            "openEnd": match.end(),
            "startTagEnd": match.end(),
            "closeStart": match.end() if match.group("self") else None,
            "end": match.end() if match.group("self") else None,
            "selfClosing": bool(match.group("self")),
            "childCounts": Counter(),
        }
        records.append(record)
        if not record["selfClosing"]:
            stack.append(record)
    return records


def _find_record_by_path(xml: str, path: str) -> dict[str, Any] | None:
    for record in _scan_xml_records(xml):
        if _path_matches(record["path"], path):
            return record
    return None


def _first_element_span(xml: str, local: str) -> tuple[int, int] | None:
    for record in _scan_xml_records(xml):
        if record["local"] == local and record.get("end") is not None:
            return int(record["start"]), int(record["end"])
    return None


def _set_attr_at_path(segment: str, path: str, attr: str, value: Any) -> tuple[str, bool]:
    record = _find_record_by_path(segment, path)
    if record is None:
        return segment, False
    start, open_end = int(record["start"]), int(record["openEnd"])
    tag_text = segment[start:open_end]
    new_tag_text = _replace_or_insert_attr(tag_text, attr, value)
    if new_tag_text == tag_text:
        return segment, False
    return segment[:start] + new_tag_text + segment[open_end:], True


def _set_text_at_path(segment: str, path: str, text: str) -> tuple[str, bool]:
    record = _find_record_by_path(segment, path)
    if record is None or record.get("selfClosing") or record.get("closeStart") is None:
        return segment, False
    start, open_end, close_start = int(record["start"]), int(record["openEnd"]), int(record["closeStart"])
    if segment[start:open_end].startswith("</"):
        return segment, False
    return segment[:open_end] + escape(text) + segment[close_start:], True


def _replace_shape_text_raw(slide_path: Path, shape_ids: list[str], text: str) -> int:
    xml = _read_xml_text(slide_path)
    spans = _shape_spans_for_ids(xml, shape_ids)

    def rewrite(segment: str):
        text_matches = list(re.finditer(r"(<a:t(?:\s[^>]*)?>)(.*?)(</a:t>)", segment, re.DOTALL))
        if not text_matches:
            return segment, False, []
        pieces = []
        cursor = 0
        for index, match in enumerate(text_matches):
            pieces.append(segment[cursor : match.start()])
            replacement_text = escape(text) if index == 0 else ""
            pieces.append(match.group(1) + replacement_text + match.group(3))
            cursor = match.end()
        pieces.append(segment[cursor:])
        return "".join(pieces), True, []

    xml, changed, _warnings = _rewrite_spans(xml, spans, rewrite)
    if changed:
        _write_xml_text(slide_path, xml)
    return changed


def _replace_or_insert_attr(tag_text: str, attr: str, value: Any) -> str:
    attr_pattern = re.compile(rf"(\b{re.escape(attr)}=)(['\"])(.*?)(\2)")
    if attr_pattern.search(tag_text):
        return attr_pattern.sub(
            lambda match: f"{match.group(1)}{match.group(2)}{_escape_attr_value(value, match.group(2))}{match.group(4)}",
            tag_text,
            count=1,
        )
    insert_at = -2 if tag_text.endswith("/>") else -1
    return tag_text[:insert_at] + f' {attr}="{_escape_attr_value(value)}"' + tag_text[insert_at:]


def _update_first_tag_attrs(segment: str, tag: str, attrs: dict[str, Any]) -> tuple[str, bool]:
    match = re.search(rf"<a:{tag}\b[^>]*>", segment)
    if not match:
        return segment, False
    tag_text = match.group(0)
    new_tag_text = tag_text
    for attr, value in attrs.items():
        new_tag_text = _replace_or_insert_attr(new_tag_text, attr, value)
    return segment[: match.start()] + new_tag_text + segment[match.end() :], new_tag_text != tag_text


def _update_first_xfrm_child_attrs(segment: str, child_tag: str, attrs: dict[str, Any]) -> tuple[str, bool]:
    xfrm_match = re.search(r"<(?:a|p):xfrm\b[^>]*>.*?</(?:a|p):xfrm>", segment, re.DOTALL)
    if not xfrm_match:
        return segment, False
    xfrm = xfrm_match.group(0)
    new_xfrm, changed = _update_first_tag_attrs(xfrm, child_tag, attrs)
    if not changed:
        return segment, False
    return segment[: xfrm_match.start()] + new_xfrm + segment[xfrm_match.end() :], True


def _move_or_resize_raw(slide_path: Path, shape_ids: list[str], op: dict[str, Any]) -> int:
    xml = _read_xml_text(slide_path)
    spans = _shape_spans_for_ids(xml, shape_ids)

    def rewrite(segment: str):
        changed_any = False
        if "x" in op or "y" in op:
            attrs = {}
            if "x" in op:
                attrs["x"] = int(op["x"])
            if "y" in op:
                attrs["y"] = int(op["y"])
            segment, changed = _update_first_xfrm_child_attrs(segment, "off", attrs)
            changed_any = changed_any or changed
        if "cx" in op or "cy" in op:
            attrs = {}
            if "cx" in op:
                attrs["cx"] = int(op["cx"])
            if "cy" in op:
                attrs["cy"] = int(op["cy"])
            segment, changed = _update_first_xfrm_child_attrs(segment, "ext", attrs)
            changed_any = changed_any or changed
        return segment, changed_any, []

    xml, changed, _warnings = _rewrite_spans(xml, spans, rewrite)
    if changed:
        _write_xml_text(slide_path, xml)
    return changed


def _replace_primary_blip_raw(slide_path: Path, shape_ids: list[str], new_rid: str) -> tuple[int, list[dict[str, str]]]:
    xml = _read_xml_text(slide_path)
    spans = _shape_spans_for_ids(xml, shape_ids)

    def rewrite(segment: str):
        warnings = []
        if len(re.findall(r"<a:blip\b", segment)) > 1:
            warnings.append(
                {
                    "code": "multiple_blips_preserved",
                    "message": "Only the first a:blip r:embed was replaced; additional effect/fallback layers were kept.",
                }
            )
        pattern = re.compile(r"(<a:blip\b[^>]*\br:embed=)(['\"])(.*?)(\2)")
        if not pattern.search(segment):
            return segment, False, []
        segment = pattern.sub(lambda match: f"{match.group(1)}{match.group(2)}{new_rid}{match.group(4)}", segment, count=1)
        return segment, True, warnings

    xml, changed, warnings = _rewrite_spans(xml, spans, rewrite)
    if changed:
        _write_xml_text(slide_path, xml)
    return changed, warnings


def _append_relationship_raw(part_path: Path, root: Path, rel_id: str, rel_type: str, target: str) -> None:
    rels_path = part_to_rels_path(part_path, root)
    xml = _read_xml_text(rels_path)
    closing = re.search(r"</(?P<prefix>(?:[^:<>\s]+:)?)Relationships>\s*$", xml)
    if closing is None:
        raise ValueError(f"Could not find Relationships closing tag: {rels_path}")
    prefix = closing.group("prefix") or ""
    relationship_tag = f"{prefix}Relationship"
    relationship = f'<{relationship_tag} Id="{rel_id}" Type="{rel_type}" Target="{target}"/>'
    xml = xml[: closing.start()] + relationship + xml[closing.start() :]
    _write_xml_text(rels_path, xml)


def _ensure_default_content_type_raw(root: Path, extension: str, content_type: str) -> bool:
    extension = extension.lower().lstrip(".")
    path = root / "[Content_Types].xml"
    xml = _read_xml_text(path)
    if re.search(rf"<(?:[^:<>\s]+:)?Default\b(?=[^>]*\bExtension=(['\"]){re.escape(extension)}\1)", xml):
        return False
    closing = re.search(r"</(?P<prefix>(?:[^:<>\s]+:)?)Types>\s*$", xml)
    if closing is None:
        raise ValueError("Could not find Types closing tag.")
    prefix = closing.group("prefix") or ""
    default_tag = f'<{prefix}Default Extension="{extension}" ContentType="{content_type}"/>'
    first_override = re.search(rf"<{re.escape(prefix)}Override\b", xml)
    insert_at = first_override.start() if first_override else closing.start()
    xml = xml[:insert_at] + default_tag + xml[insert_at:]
    _write_xml_text(path, xml)
    return True


def _add_override_raw(root: Path, part_name: str, content_type: str) -> bool:
    path = root / "[Content_Types].xml"
    xml = _read_xml_text(path)
    if re.search(rf"<(?:[^:<>\s]+:)?Override\b(?=[^>]*\bPartName=(['\"]){re.escape(part_name)}\1)", xml):
        return False
    closing = re.search(r"</(?P<prefix>(?:[^:<>\s]+:)?)Types>\s*$", xml)
    if closing is None:
        raise ValueError("Could not find Types closing tag.")
    prefix = closing.group("prefix") or ""
    override = f'<{prefix}Override PartName="{_escape_attr_value(part_name)}" ContentType="{_escape_attr_value(content_type)}"/>'
    xml = xml[: closing.start()] + override + xml[closing.start() :]
    _write_xml_text(path, xml)
    return True


def _remove_override_raw(root: Path, part_name: str) -> bool:
    path = root / "[Content_Types].xml"
    xml = _read_xml_text(path)
    pattern = re.compile(
        rf"\s*<(?:[^:<>\s]+:)?Override\b(?=[^>]*\bPartName=(['\"]){re.escape(part_name)}\1)[^>]*/>"
    )
    new_xml, count = pattern.subn("", xml, count=1)
    if count:
        _write_xml_text(path, new_xml)
    return bool(count)


def _remove_relationship_raw(part_path: Path, root: Path, rel_id: str) -> bool:
    rels_path = part_to_rels_path(part_path, root)
    if not rels_path.exists():
        return False
    xml = _read_xml_text(rels_path)
    pattern = re.compile(
        rf"\s*<(?:[^:<>\s]+:)?Relationship\b(?=[^>]*\bId=(['\"]){re.escape(rel_id)}\1)[^>]*"
        rf"(?:/>|>\s*</(?:[^:<>\s]+:)?Relationship>)"
    )
    new_xml, count = pattern.subn("", xml, count=1)
    if count:
        _write_xml_text(rels_path, new_xml)
    return bool(count)


def _next_shape_id(xml: str) -> int:
    max_id = 1
    for match in re.finditer(r"<p:cNvPr\b[^>]*\bid=['\"](\d+)['\"]", xml):
        max_id = max(max_id, int(match.group(1)))
    return max_id + 1


def _insert_into_sp_tree(xml: str, fragment: str) -> str:
    insert_at = xml.rfind("</p:spTree>")
    if insert_at < 0:
        raise ValueError("Slide has no p:spTree closing tag.")
    return xml[:insert_at] + fragment + xml[insert_at:]


def _normalize_hex(value: Any) -> str:
    text = str(value).strip().lstrip("#")
    if re.fullmatch(r"[0-9A-Fa-f]{3}", text):
        text = "".join(char * 2 for char in text)
    if not re.fullmatch(r"[0-9A-Fa-f]{6}", text):
        raise ValueError(f"Invalid hex color: {value}")
    return text.upper()


def _require_emu(op: dict[str, Any], keys: tuple[str, ...]) -> dict[str, int]:
    values = {}
    for key in keys:
        if key not in op:
            raise ValueError(f"Patch op {op.get('op')} needs EMU value '{key}': {op}")
        values[key] = int(op[key])
    return values


_SPID_ATTR_RE = re.compile(r"<p:spTgt\b[^>]*\bspid=['\"](\d+)['\"]")
_BUILD_LOCALS = {"bldP", "bldOleChart", "bldDgm", "bldGraphic"}


def _strip_timing_refs_raw(xml: str, shape_ids: set[str]) -> tuple[str, dict[str, Any]]:
    """Remove timing effect nodes and build entries that only target deleted shapes.

    Conservative contract: a <p:par>/<p:seq> subtree is removed only when every
    spTgt inside it targets a deleted shape; containers whose childTnLst becomes
    empty are then removed (never tmRoot/mainSeq); if no spTgt remains anywhere,
    the whole <p:timing> element is dropped. Mixed-target nodes that still
    reference a deleted shape are left in place and counted in residualRefs so
    validation fails loudly instead of silently corrupting the tree.
    """
    info: dict[str, Any] = {
        "removedEffectNodes": 0,
        "removedEmptyContainers": 0,
        "removedBuildEntries": 0,
        "removedTiming": False,
        "residualRefs": 0,
    }
    shape_ids = {str(shape_id) for shape_id in shape_ids}
    span = _first_element_span(xml, "timing")
    if span is None:
        return xml, info
    start, end = span
    timing = xml[start:end]

    changed = True
    while changed:
        changed = False
        records = _scan_xml_records(timing)
        time_nodes = [
            record
            for record in records
            if record["local"] in {"par", "seq"} and record.get("end") is not None
        ]
        removals: list[tuple[int, int]] = []
        for record in sorted(time_nodes, key=lambda item: int(item["start"])):
            node_start, node_end = int(record["start"]), int(record["end"])
            if any(node_start >= s and node_end <= e for s, e in removals):
                continue
            segment = timing[node_start:node_end]
            spids = _SPID_ATTR_RE.findall(segment)
            if spids and set(spids) <= shape_ids:
                removals.append((node_start, node_end))
        if removals:
            for node_start, node_end in sorted(removals, reverse=True):
                timing = timing[:node_start] + timing[node_end:]
            info["removedEffectNodes"] += len(removals)
            changed = True
            continue
        for record in records:
            if record["local"] != "childTnLst" or record.get("closeStart") is None:
                continue
            if record.get("selfClosing"):
                continue
            if timing[int(record["openEnd"]) : int(record["closeStart"])].strip():
                continue
            enclosing = None
            for candidate in records:
                if candidate["local"] not in {"par", "seq"} or candidate.get("end") is None:
                    continue
                if int(candidate["start"]) < int(record["start"]) and int(candidate["end"]) > int(record["end"]):
                    if enclosing is None or int(candidate["start"]) > int(enclosing["start"]):
                        enclosing = candidate
            if enclosing is None:
                continue
            segment = timing[int(enclosing["start"]) : int(enclosing["end"])]
            if 'nodeType="tmRoot"' in segment or 'nodeType="mainSeq"' in segment:
                continue
            timing = timing[: int(enclosing["start"])] + timing[int(enclosing["end"]) :]
            info["removedEmptyContainers"] += 1
            changed = True
            break

    build_removals: list[tuple[int, int]] = []
    records = _scan_xml_records(timing)
    for record in records:
        if record["local"] not in _BUILD_LOCALS or record.get("end") is None:
            continue
        open_tag = timing[int(record["start"]) : int(record["openEnd"])]
        spid_match = re.search(r"\bspid=['\"](\d+)['\"]", open_tag)
        if spid_match and spid_match.group(1) in shape_ids:
            build_removals.append((int(record["start"]), int(record["end"])))
    for node_start, node_end in sorted(set(build_removals), reverse=True):
        timing = timing[:node_start] + timing[node_end:]
    info["removedBuildEntries"] = len(set(build_removals))

    bld_lst = _first_element_span(timing, "bldLst")
    if bld_lst is not None:
        lst_start, lst_end = bld_lst
        inner = re.sub(r"^<p:bldLst\b[^>]*>|</p:bldLst>$", "", timing[lst_start:lst_end])
        if not inner.strip():
            timing = timing[:lst_start] + timing[lst_end:]

    info["residualRefs"] = sum(1 for spid in _SPID_ATTR_RE.findall(timing) if spid in shape_ids)
    if not _SPID_ATTR_RE.search(timing):
        info["removedTiming"] = True
        return xml[:start] + xml[end:], info
    return xml[:start] + timing + xml[end:], info


def _sld_id_list_span(xml: str) -> tuple[int, int]:
    match = re.search(r"<p:sldIdLst\s*>.*?</p:sldIdLst>|<p:sldIdLst\s*/>", xml, re.DOTALL)
    if match is None:
        raise ValueError("presentation.xml has no p:sldIdLst.")
    return match.start(), match.end()


_SLD_ID_ENTRY_RE = re.compile(r"<p:sldId\b[^>]*?(?:/>|>\s*</p:sldId>)", re.DOTALL)


def _sld_id_entries(list_text: str) -> list[dict[str, Any]]:
    entries = []
    for match in _SLD_ID_ENTRY_RE.finditer(list_text):
        text = match.group(0)
        id_match = re.search(r"\bid=['\"](\d+)['\"]", text)
        rid_match = re.search(r"\br:id=['\"]([^'\"]+)['\"]", text)
        entries.append(
            {
                "start": match.start(),
                "end": match.end(),
                "text": text,
                "id": id_match.group(1) if id_match else None,
                "rid": rid_match.group(1) if rid_match else None,
            }
        )
    return entries


def _slide_part_numbers(root: Path) -> list[int]:
    numbers = []
    slides_dir = root / "ppt/slides"
    if slides_dir.exists():
        for path in slides_dir.glob("slide*.xml"):
            match = re.fullmatch(r"slide(\d+)\.xml", path.name)
            if match:
                numbers.append(int(match.group(1)))
    return numbers


def _slide_entry_for_number(root: Path, slide_number: int) -> dict[str, Any]:
    slides, _size = presentation_slides(root)
    if not 1 <= slide_number <= len(slides):
        raise ValueError(f"Slide number out of range: {slide_number} (deck has {len(slides)}).")
    entry = slides[slide_number - 1]
    if not entry.get("path") or not entry.get("rid"):
        raise ValueError(f"Slide {slide_number} has no resolvable part in presentation.xml.")
    return entry


def _set_text(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number, slide_path, _tree, _slide_root, matches = _load_slide(root, op)
    text = str(op.get("text", ""))
    changed = _replace_shape_text_raw(slide_path, _matched_shape_ids(matches), text)
    if not changed:
        raise ValueError(f"Matched shapes have no text body: {op}")
    return {"op": "setText", "slide": slide_number, "changedShapes": changed}


def _move_or_resize(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    op_name = str(op["op"])
    slide_number, slide_path, _tree, _slide_root, matches = _load_slide(root, op)
    changed = _move_or_resize_raw(slide_path, _matched_shape_ids(matches), op)
    if not changed:
        raise ValueError(f"Matched shapes have no transform: {op}")
    return {"op": op_name, "slide": slide_number, "changedShapes": changed}


def _set_attr_by_path(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number, slide_path, _tree, _slide_root, matches = _load_slide(root, op)
    path = str(op.get("path", ""))
    attr = str(op.get("attr", ""))
    if not path or not attr:
        raise ValueError(f"setAttrByPath needs path and attr: {op}")
    value = op.get("value", "")
    shape_ids = _matched_shape_ids(matches)
    xml = _read_xml_text(slide_path)
    spans = _shape_spans_for_ids(xml, shape_ids)

    def rewrite(segment: str):
        new_segment, changed = _set_attr_at_path(segment, path, attr, value)
        return new_segment, changed, []

    xml, changed, _warnings = _rewrite_spans(xml, spans, rewrite)
    if not changed:
        raise ValueError(f"No matching control attribute path: {op}")
    _write_xml_text(slide_path, xml)
    return {"op": "setAttrByPath", "slide": slide_number, "changedShapes": changed, "path": path, "attr": attr}


def _set_text_run(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number, slide_path, _tree, _slide_root, matches = _load_slide(root, op)
    text = str(op.get("text", ""))
    path = op.get("path")
    if not path:
        paragraph = int(op.get("paragraph", 1))
        run = int(op.get("run", 1))
        # The root token is the concrete shape tag, for example sp or pic.
        first_shape = matches[0][0]
        root_tag = first_shape.tag.rsplit("}", 1)[-1]
        path = f"{root_tag}/txBody[1]/p[{paragraph}]/r[{run}]/t[1]"
    path = str(path)
    shape_ids = _matched_shape_ids(matches)
    xml = _read_xml_text(slide_path)
    spans = _shape_spans_for_ids(xml, shape_ids)

    def rewrite(segment: str):
        new_segment, changed = _set_text_at_path(segment, path, text)
        return new_segment, changed, []

    xml, changed, _warnings = _rewrite_spans(xml, spans, rewrite)
    if not changed:
        raise ValueError(f"No matching text run path: {op}")
    _write_xml_text(slide_path, xml)
    return {"op": "setTextRun", "slide": slide_number, "changedShapes": changed, "path": path}


def _set_slide_attr_by_path(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number, slide_path = _slide_path_from_op(root, op)
    path = str(op.get("path", ""))
    attr = str(op.get("attr", ""))
    if not path or not attr:
        raise ValueError(f"setSlideAttrByPath needs path and attr: {op}")
    xml = _read_xml_text(slide_path)
    new_xml, changed = _set_attr_at_path(xml, path, attr, op.get("value", ""))
    if not changed:
        raise ValueError(f"No matching slide attribute path: {op}")
    _write_xml_text(slide_path, new_xml)
    return {"op": "setSlideAttrByPath", "slide": slide_number, "path": path, "attr": attr}


def _set_timing_attr(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number, slide_path = _slide_path_from_op(root, op)
    path = str(op.get("path", ""))
    attr = str(op.get("attr", ""))
    if not path or not attr:
        raise ValueError(f"setTimingAttr needs path and attr: {op}")
    xml = _read_xml_text(slide_path)
    span = _first_element_span(xml, "timing")
    if span is None:
        raise ValueError(f"Slide has no p:timing: {slide_number}")
    start, end = span
    timing = xml[start:end]
    new_timing, changed = _set_attr_at_path(timing, path, attr, op.get("value", ""))
    if not changed:
        raise ValueError(f"No matching timing attribute path: {op}")
    xml = xml[:start] + new_timing + xml[end:]
    _write_xml_text(slide_path, xml)
    return {"op": "setTimingAttr", "slide": slide_number, "path": path, "attr": attr}


def _replace_image(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number, slide_path, _tree, _slide_root, matches = _load_slide(root, op)
    source = Path(str(op.get("file", op.get("path", "")))).expanduser()
    if not source.is_absolute():
        source = (Path.cwd() / source).resolve()
    if not source.exists():
        raise FileNotFoundError(f"Replacement image not found: {source}")
    extension = source.suffix.lower().lstrip(".")
    content_type = image_content_type(extension)
    dimensions = image_dimensions(source)
    if dimensions and not op.get("allowAspectMismatch"):
        image_aspect = dimensions[0] / dimensions[1]
        mismatches = []
        for shape, _path in matches:
            bbox = bbox_of(shape)
            if not bbox or not bbox.get("cx") or not bbox.get("cy"):
                continue
            box_aspect = int(bbox["cx"]) / int(bbox["cy"])
            drift = abs(image_aspect - box_aspect) / max(image_aspect, box_aspect)
            if drift > ASPECT_TOLERANCE:
                cnvpr = cnvpr_for_shape(shape)
                mismatches.append(
                    {
                        "shapeId": cnvpr.attrib.get("id") if cnvpr is not None else None,
                        "shapeName": cnvpr.attrib.get("name") if cnvpr is not None else None,
                        "boxAspect": round(box_aspect, 3),
                        "imageAspect": round(image_aspect, 3),
                    }
                )
        if mismatches:
            raise ValueError(
                "Replacement image aspect ratio does not match the target shape. "
                "Use a same-aspect image, add crop support, or set allowAspectMismatch=true. "
                f"Details: {mismatches}"
            )
    media_dir = root / "ppt/media"
    media_dir.mkdir(parents=True, exist_ok=True)
    media_name = next_media_name(media_dir, "image", extension)
    media_path = media_dir / media_name
    shutil.copyfile(source, media_path)
    added_content_type = _ensure_default_content_type_raw(root, extension, content_type)

    rels_map = read_relationships(slide_path, root)
    rels = list(rels_map.values())
    rid = next_rid(rels)
    changed, warnings = _replace_primary_blip_raw(slide_path, _matched_shape_ids(matches), rid)
    if not changed:
        raise ValueError(f"Matched shapes have no image blip: {op}")
    _append_relationship_raw(slide_path, root, rid, IMAGE_REL_TYPE, f"../media/{media_name}")
    return {
        "op": "replaceImage",
        "slide": slide_number,
        "changedShapes": changed,
        "newRelationshipId": rid,
        "newMedia": f"ppt/media/{media_name}",
        "addedContentType": added_content_type,
        "warnings": warnings,
    }


def _delete_shape(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number, slide_path, _tree, _slide_root, matches = _load_slide(root, op)
    shape_ids = _matched_shape_ids(matches)
    xml = _read_xml_text(slide_path)
    spans = _shape_spans_for_ids(xml, shape_ids)
    if not spans:
        raise ValueError(f"Could not locate raw spans for matched shapes: {op}")
    orphaned_rids = sorted(
        {
            rid
            for start, end in spans
            for rid in re.findall(r"\br:(?:embed|link|id)=['\"]([^'\"]+)['\"]", xml[start:end])
        }
    )
    for start, end in sorted(spans, reverse=True):
        xml = xml[:start] + xml[end:]
    xml, timing_info = _strip_timing_refs_raw(xml, set(shape_ids))
    _write_xml_text(slide_path, xml)
    warnings: list[dict[str, Any]] = []
    if orphaned_rids:
        warnings.append(
            {
                "code": "relationships_left_in_place",
                "message": "Deleted shape(s) referenced relationships that were kept; the targets remain in the package.",
                "rids": orphaned_rids,
            }
        )
    if timing_info["residualRefs"]:
        warnings.append(
            {
                "code": "residual_timing_refs",
                "message": "Some timing nodes still reference the deleted shape (mixed-target nodes are not rewritten); validation will fail until they are fixed.",
                "count": timing_info["residualRefs"],
            }
        )
    return {
        "op": "deleteShape",
        "slide": slide_number,
        "shapeIds": shape_ids,
        "removedShapes": len(spans),
        "timing": timing_info,
        "warnings": warnings,
    }


def _add_textbox(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number, slide_path = _slide_path_from_op(root, op)
    geometry = _require_emu(op, ("x", "y", "cx", "cy"))
    text = str(op.get("text", ""))
    xml = _read_xml_text(slide_path)
    shape_id = _next_shape_id(xml)
    name = str(op.get("name") or f"TextBox {shape_id}")
    rpr_attrs = ' lang="en-US"'
    if op.get("fontSizePt") is not None:
        rpr_attrs += f' sz="{int(round(float(op["fontSizePt"]) * 100))}"'
    if op.get("bold"):
        rpr_attrs += ' b="1"'
    rpr_attrs += ' dirty="0"'
    fill = ""
    if op.get("colorHex"):
        fill = f'<a:solidFill><a:srgbClr val="{_normalize_hex(op["colorHex"])}"/></a:solidFill>'
    paragraphs = []
    for line in text.split("\n"):
        if line:
            paragraphs.append(f"<a:p><a:r><a:rPr{rpr_attrs}>{fill}</a:rPr><a:t>{escape(line)}</a:t></a:r></a:p>")
        else:
            paragraphs.append(f"<a:p><a:endParaRPr{rpr_attrs}>{fill}</a:endParaRPr></a:p>")
    fragment = (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="{_escape_attr_value(name)}"/>'
        f'<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{geometry["x"]}" y="{geometry["y"]}"/>'
        f'<a:ext cx="{geometry["cx"]}" cy="{geometry["cy"]}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
        f'<p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>{"".join(paragraphs)}</p:txBody></p:sp>'
    )
    _write_xml_text(slide_path, _insert_into_sp_tree(xml, fragment))
    return {
        "op": "addTextbox",
        "slide": slide_number,
        "shapeId": shape_id,
        "name": name,
        "warnings": [],
    }


_IMAGE_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpeg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


def _image_payload_from_op(op: dict[str, Any]) -> tuple[bytes, str]:
    data_uri = op.get("dataUri")
    if data_uri:
        match = re.fullmatch(r"data:image/([\w.+-]+);base64,(.*)", str(data_uri), re.DOTALL)
        if not match:
            raise ValueError("addImage dataUri must look like data:image/<type>;base64,<payload>.")
        subtype = match.group(1).lower()
        extension = {"jpeg": "jpeg", "jpg": "jpeg", "svg+xml": "svg"}.get(subtype, subtype)
        return base64.b64decode(match.group(2)), extension
    source = Path(str(op.get("path", op.get("file", "")))).expanduser()
    if not str(source.name):
        raise ValueError(f"addImage needs path or dataUri: {op}")
    if not source.is_absolute():
        source = (Path.cwd() / source).resolve()
    if not source.exists():
        raise FileNotFoundError(f"Image not found: {source}")
    data = source.read_bytes()
    extension = source.suffix.lower().lstrip(".")
    if not extension:
        for signature, sniffed in _IMAGE_SIGNATURES:
            if data.startswith(signature):
                extension = sniffed
                break
        else:
            raise ValueError(f"Cannot determine image type (no extension, unknown signature): {source}")
    return data, extension


def _add_image(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number, slide_path = _slide_path_from_op(root, op)
    geometry = _require_emu(op, ("x", "y", "cx", "cy"))
    data, extension = _image_payload_from_op(op)
    content_type = image_content_type(extension)
    media_dir = root / "ppt/media"
    media_dir.mkdir(parents=True, exist_ok=True)
    media_name = next_media_name(media_dir, "image", extension)
    (media_dir / media_name).write_bytes(data)
    added_content_type = _ensure_default_content_type_raw(root, extension, content_type)

    rels = list(read_relationships(slide_path, root).values())
    rid = next_rid(rels)
    xml = _read_xml_text(slide_path)
    shape_id = _next_shape_id(xml)
    name = str(op.get("name") or f"Picture {shape_id}")
    fragment = (
        f'<p:pic><p:nvPicPr><p:cNvPr id="{shape_id}" name="{_escape_attr_value(name)}"/>'
        f'<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
        f'<p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        f'<p:spPr><a:xfrm><a:off x="{geometry["x"]}" y="{geometry["y"]}"/>'
        f'<a:ext cx="{geometry["cx"]}" cy="{geometry["cy"]}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    )
    _write_xml_text(slide_path, _insert_into_sp_tree(xml, fragment))
    _append_relationship_raw(slide_path, root, rid, IMAGE_REL_TYPE, f"../media/{media_name}")
    return {
        "op": "addImage",
        "slide": slide_number,
        "shapeId": shape_id,
        "name": name,
        "newRelationshipId": rid,
        "newMedia": f"ppt/media/{media_name}",
        "addedContentType": added_content_type,
        "warnings": [],
    }


def _duplicate_slide(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number = int(op.get("slide", op.get("slideNumber", 0)))
    if not slide_number:
        raise ValueError(f"duplicateSlide needs a slide number: {op}")
    source_entry = _slide_entry_for_number(root, slide_number)
    slides, _size = presentation_slides(root)
    after = int(op.get("after", slide_number))
    if not 0 <= after <= len(slides):
        raise ValueError(f"duplicateSlide 'after' out of range: {after} (deck has {len(slides)}).")

    source_path = root / str(source_entry["path"])
    new_part_number = max(_slide_part_numbers(root), default=0) + 1
    new_part_rel = f"slides/slide{new_part_number}.xml"
    new_path = root / "ppt" / new_part_rel
    shutil.copyfile(source_path, new_path)
    warnings: list[dict[str, Any]] = []

    source_rels_path = part_to_rels_path(source_path, root)
    if source_rels_path.exists():
        new_rels_path = part_to_rels_path(new_path, root)
        new_rels_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_rels_path, new_rels_path)
        source_rels = read_relationships(source_path, root)
        shared_notes = [
            rel["id"] for rel in source_rels.values() if rel.get("type") == NOTES_SLIDE_REL_TYPE
        ]
        if shared_notes:
            warnings.append(
                {
                    "code": "notes_part_shared",
                    "message": "Duplicated slide shares the source slide's notesSlide part; edits to notes affect both slides.",
                    "rids": shared_notes,
                }
            )

    _add_override_raw(root, f"/ppt/{new_part_rel}", SLIDE_CONTENT_TYPE)

    presentation_path = root / "ppt/presentation.xml"
    rid = next_rid(read_relationships(presentation_path, root).values())
    _append_relationship_raw(presentation_path, root, rid, SLIDE_REL_TYPE, new_part_rel)

    xml = _read_xml_text(presentation_path)
    list_start, list_end = _sld_id_list_span(xml)
    list_text = xml[list_start:list_end]
    entries = _sld_id_entries(list_text)
    new_slide_id = max([int(entry["id"]) for entry in entries if entry["id"]] + [255]) + 1
    entry_text = f'<p:sldId id="{new_slide_id}" r:id="{rid}"/>'
    if after == 0:
        open_end = list_text.index(">") + 1
        insert_at = open_end
    else:
        if after > len(entries):
            raise ValueError(f"duplicateSlide 'after' beyond sldIdLst entries: {after}")
        insert_at = entries[after - 1]["end"]
    list_text = list_text[:insert_at] + entry_text + list_text[insert_at:]
    _write_xml_text(presentation_path, xml[:list_start] + list_text + xml[list_end:])

    if "!!" in _read_xml_text(new_path):
        warnings.append(
            {
                "code": "morph_name_double_match",
                "message": "Duplicated slide contains '!!' morph-matching names; morph may now double-match across the copies. Rename if morph misbehaves.",
            }
        )
    return {
        "op": "duplicateSlide",
        "slide": slide_number,
        "after": after,
        "newSlideNumber": after + 1,
        "newPart": f"ppt/{new_part_rel}",
        "newRelationshipId": rid,
        "newPresentationSlideId": new_slide_id,
        "warnings": warnings,
    }


def _referenced_elsewhere(root: Path, target_path: Path, excluded_rels: Path) -> bool:
    root_resolved = root.resolve()
    target_resolved = target_path.resolve()
    for rels_path in root_resolved.rglob("*.rels"):
        if rels_path.parent.name != "_rels" or rels_path == excluded_rels.resolve():
            continue
        source_part = rels_path_to_part(rels_path, root_resolved)
        for rel in read_relationships(source_part, root_resolved).values():
            if rel.get("targetMode") == "External" or not rel.get("target"):
                continue
            base = root_resolved if source_part == root_resolved else source_part.parent
            if (base / str(rel["target"])).resolve() == target_resolved:
                return True
    return False


def _delete_slide(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number = int(op.get("slide", op.get("slideNumber", 0)))
    if not slide_number:
        raise ValueError(f"deleteSlide needs a slide number: {op}")
    entry = _slide_entry_for_number(root, slide_number)
    rid = str(entry["rid"])
    part_rel = str(entry["path"])
    part_path = root / part_rel
    warnings: list[dict[str, Any]] = []

    presentation_path = root / "ppt/presentation.xml"
    xml = _read_xml_text(presentation_path)
    list_start, list_end = _sld_id_list_span(xml)
    list_text = xml[list_start:list_end]
    entries = _sld_id_entries(list_text)
    keep = [item for item in entries if item["rid"] != rid]
    if len(keep) == len(entries):
        raise ValueError(f"Slide {slide_number} (r:id {rid}) not present in sldIdLst.")
    for item in sorted((item for item in entries if item["rid"] == rid), key=lambda item: -item["start"]):
        list_text = list_text[: item["start"]] + list_text[item["end"] :]
    xml = xml[:list_start] + list_text + xml[list_end:]
    custom_show_refs = re.subn(
        rf"\s*<p:sld\b[^>]*\br:id=['\"]{re.escape(rid)}['\"][^>]*/>", "", xml
    )
    if custom_show_refs[1]:
        xml = custom_show_refs[0]
        warnings.append(
            {
                "code": "custom_show_entries_removed",
                "message": "Removed custom-show references to the deleted slide.",
                "count": custom_show_refs[1],
            }
        )
    _write_xml_text(presentation_path, xml)
    _remove_relationship_raw(presentation_path, root, rid)
    _remove_override_raw(root, f"/{part_rel}")

    removed_parts = []
    slide_rels = read_relationships(part_path, root)
    orphaned_targets = []
    for rel in slide_rels.values():
        if rel.get("targetMode") == "External":
            continue
        target = rel.get("target")
        if not target:
            continue
        resolved = (part_path.parent / str(target)).resolve()
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            continue
        if not resolved.exists():
            continue
        target_rel = resolved.relative_to(root.resolve()).as_posix()
        if rel.get("type") == NOTES_SLIDE_REL_TYPE:
            notes_rels_path = part_to_rels_path(resolved, root)
            resolved.unlink()
            removed_parts.append(target_rel)
            if notes_rels_path.exists():
                notes_rels_path.unlink()
                removed_parts.append(notes_rels_path.relative_to(root.resolve()).as_posix())
            _remove_override_raw(root, f"/{target_rel}")
        elif not target_rel.startswith("ppt/slideLayouts/") and not _referenced_elsewhere(
            root, resolved, part_to_rels_path(part_path, root)
        ):
            orphaned_targets.append(target_rel)
    if orphaned_targets:
        warnings.append(
            {
                "code": "orphaned_parts_left",
                "message": "Parts referenced only by the deleted slide may now be orphaned; they were kept (harmless, larger file).",
                "parts": sorted(set(orphaned_targets)),
            }
        )

    rels_path = part_to_rels_path(part_path, root)
    part_path.unlink()
    removed_parts.insert(0, part_rel)
    if rels_path.exists():
        rels_path.unlink()
        removed_parts.insert(1, rels_path.relative_to(root.resolve()).as_posix())
    return {
        "op": "deleteSlide",
        "slide": slide_number,
        "removedRelationshipId": rid,
        "removedParts": removed_parts,
        "warnings": warnings,
    }


def _reorder_slide(root: Path, op: dict[str, Any]) -> dict[str, Any]:
    slide_number = int(op.get("slide", op.get("slideNumber", 0)))
    before = int(op.get("before", 0))
    if not slide_number or not before:
        raise ValueError(f"reorderSlide needs slide and before: {op}")
    presentation_path = root / "ppt/presentation.xml"
    xml = _read_xml_text(presentation_path)
    list_start, list_end = _sld_id_list_span(xml)
    list_text = xml[list_start:list_end]
    entries = _sld_id_entries(list_text)
    count = len(entries)
    if not 1 <= slide_number <= count:
        raise ValueError(f"reorderSlide slide out of range: {slide_number} (deck has {count}).")
    if not 1 <= before <= count + 1:
        raise ValueError(f"reorderSlide 'before' out of range: {before} (deck has {count}).")
    if before in (slide_number, slide_number + 1):
        order = [entry["id"] for entry in entries]
        return {"op": "reorderSlide", "slide": slide_number, "before": before, "changed": False, "order": order}
    texts = [entry["text"] for entry in entries]
    moved = texts.pop(slide_number - 1)
    insert_index = before - 1 if before <= slide_number else before - 2
    texts.insert(insert_index, moved)
    # Rebuild the list body, permuting entry texts while keeping every
    # inter-entry separator (whitespace/indentation) byte-identical.
    pieces = [list_text[: entries[0]["start"]]]
    for index, entry in enumerate(entries):
        pieces.append(texts[index])
        next_start = entries[index + 1]["start"] if index + 1 < count else len(list_text)
        pieces.append(list_text[entry["end"] : next_start])
    new_list_text = "".join(pieces)
    _write_xml_text(presentation_path, xml[:list_start] + new_list_text + xml[list_end:])
    new_order = [re.search(r"\bid=['\"](\d+)['\"]", text).group(1) for text in texts]  # type: ignore[union-attr]
    return {
        "op": "reorderSlide",
        "slide": slide_number,
        "before": before,
        "changed": True,
        "order": new_order,
        "warnings": [],
    }


def apply_patch_file(root: Path, patch_path: Path, validate: bool = True) -> dict[str, Any]:
    patch = read_json(patch_path)
    if isinstance(patch, dict):
        ops = patch.get("ops", [])
    else:
        ops = patch
    if not isinstance(ops, list):
        raise ValueError("Patch file must be a list of operations or an object with an 'ops' list.")
    results = []
    for op in ops:
        if not isinstance(op, dict) or "op" not in op:
            raise ValueError(f"Invalid patch operation: {op}")
        op_name = op["op"]
        if op_name == "setText":
            results.append(_set_text(root, op))
        elif op_name in {"setTextRun", "setRunText"}:
            results.append(_set_text_run(root, op))
        elif op_name in {"moveShape", "resizeShape", "setBounds"}:
            results.append(_move_or_resize(root, op))
        elif op_name in {"setAttrByPath", "setControlAttr"}:
            results.append(_set_attr_by_path(root, op))
        elif op_name == "setSlideAttrByPath":
            results.append(_set_slide_attr_by_path(root, op))
        elif op_name == "setTimingAttr":
            results.append(_set_timing_attr(root, op))
        elif op_name == "replaceImage":
            results.append(_replace_image(root, op))
        elif op_name == "deleteShape":
            results.append(_delete_shape(root, op))
        elif op_name == "addTextbox":
            results.append(_add_textbox(root, op))
        elif op_name == "addImage":
            results.append(_add_image(root, op))
        elif op_name == "duplicateSlide":
            results.append(_duplicate_slide(root, op))
        elif op_name == "deleteSlide":
            results.append(_delete_slide(root, op))
        elif op_name == "reorderSlide":
            results.append(_reorder_slide(root, op))
        else:
            raise ValueError(f"Unsupported patch op: {op_name}")
    validation = validate_package(root) if validate else None
    if validation and not validation["ok"]:
        return {"ok": False, "applied": results, "validation": validation}
    return {"ok": True, "applied": results, "validation": validation}
