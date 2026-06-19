from __future__ import annotations

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
    read_json,
    read_relationships,
    slide_part_for_number,
)
from .validator import validate_package


IMAGE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
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
        else:
            raise ValueError(f"Unsupported patch op: {op_name}")
    validation = validate_package(root) if validate else None
    if validation and not validation["ok"]:
        return {"ok": False, "applied": results, "validation": validation}
    return {"ok": True, "applied": results, "validation": validation}
