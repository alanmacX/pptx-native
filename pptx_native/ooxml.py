from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import shutil
import struct
import zipfile
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable
from xml.etree import ElementTree as ET


PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": PACKAGE_REL_NS,
    "ct": CONTENT_TYPES_NS,
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "a14": "http://schemas.microsoft.com/office/drawing/2010/main",
    "a16": "http://schemas.microsoft.com/office/drawing/2014/main",
    "p14": "http://schemas.microsoft.com/office/powerpoint/2010/main",
    "p159": "http://schemas.microsoft.com/office/powerpoint/2015/09/main",
    "am3d": "http://schemas.microsoft.com/office/drawing/2017/model3d",
}

for prefix, uri in NS.items():
    if prefix not in {"rel", "ct"}:
        ET.register_namespace(prefix, uri)


def q(prefix: str, name: str) -> str:
    return f"{{{NS[prefix]}}}{name}"


def rel_q(name: str) -> str:
    return f"{{{PACKAGE_REL_NS}}}{name}"


def ct_q(name: str) -> str:
    return f"{{{CONTENT_TYPES_NS}}}{name}"


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_xml(path: Path) -> ET.ElementTree:
    return ET.parse(path)


def write_xml(path: Path, tree: ET.ElementTree) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tree.write(path, encoding="UTF-8", xml_declaration=True)


def part_to_rels_path(part_path: Path, root: Path) -> Path:
    if part_path == root:
        return root / "_rels/.rels"
    return part_path.parent / "_rels" / f"{part_path.name}.rels"


def rels_path_to_part(rels_path: Path, root: Path) -> Path:
    if rels_path == root / "_rels/.rels":
        return root
    return rels_path.parent.parent / rels_path.name.removesuffix(".rels")


def read_relationships(part_path: Path, root: Path) -> dict[str, dict[str, str | None]]:
    rels_path = part_to_rels_path(part_path, root)
    if not rels_path.exists():
        return {}
    rels_root = parse_xml(rels_path).getroot()
    result: dict[str, dict[str, str | None]] = {}
    for rel in rels_root:
        rel_type = rel.attrib.get("Type")
        rel_id = rel.attrib.get("Id")
        if not rel_id:
            continue
        result[rel_id] = {
            "id": rel_id,
            "type": rel_type,
            "typeName": rel_type.rsplit("/", 1)[-1] if rel_type else None,
            "target": rel.attrib.get("Target"),
            "targetMode": rel.attrib.get("TargetMode"),
        }
    return result


def write_relationships(part_path: Path, root: Path, rels: Iterable[dict[str, str | None]]) -> None:
    rels_root = ET.Element(rel_q("Relationships"))
    for rel in rels:
        attrs = {
            "Id": str(rel["id"]),
            "Type": str(rel["type"]),
            "Target": str(rel["target"]),
        }
        if rel.get("targetMode"):
            attrs["TargetMode"] = str(rel["targetMode"])
        ET.SubElement(rels_root, rel_q("Relationship"), attrs)
    write_xml(part_to_rels_path(part_path, root), ET.ElementTree(rels_root))


def resolve_relationship_target(part_path: Path, root: Path, target: str | None) -> Path | None:
    if not target or "://" in target or target.startswith("mailto:"):
        return None
    base = root if part_path == root else part_path.parent
    return (base / target).resolve()


def is_internal_target_present(part_path: Path, root: Path, rel: dict[str, str | None]) -> bool:
    if rel.get("targetMode") == "External":
        return True
    resolved = resolve_relationship_target(part_path, root, rel.get("target"))
    if resolved is None:
        return True
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return False
    return resolved.exists()


def package_files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.is_file())


def safe_extract_pptx(pptx_path: Path, out_dir: Path, overwrite: bool = False) -> None:
    if out_dir.exists():
        if not overwrite:
            raise FileExistsError(f"Output directory already exists: {out_dir}")
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    root_resolved = out_dir.resolve()
    with zipfile.ZipFile(pptx_path) as archive:
        for member in archive.infolist():
            destination = (out_dir / member.filename).resolve()
            try:
                destination.relative_to(root_resolved)
            except ValueError as exc:
                raise ValueError(f"Unsafe zip member path: {member.filename}") from exc
            if member.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as src, destination.open("wb") as dst:
                shutil.copyfileobj(src, dst)


def pack_pptx(root: Path, out_path: Path) -> None:
    root = root.resolve()
    out_path = out_path.resolve()
    try:
        out_path.relative_to(root)
    except ValueError:
        pass
    else:
        raise ValueError("Output PPTX cannot be written inside the package directory.")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    files = package_files(root)
    content_types = root / "[Content_Types].xml"
    ordered = [content_types] if content_types in files else []
    ordered.extend(path for path in files if path != content_types)
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in ordered:
            archive.write(file_path, file_path.relative_to(root).as_posix())


def presentation_slides(root: Path) -> tuple[list[dict[str, str | int | None]], dict[str, int | str | None] | None]:
    presentation_path = root / "ppt/presentation.xml"
    tree = parse_xml(presentation_path)
    presentation = tree.getroot()
    rels = read_relationships(presentation_path, root)
    slides = []
    for number, slide_id in enumerate(presentation.findall(".//p:sldId", NS), 1):
        rid = slide_id.attrib.get(q("r", "id"))
        rel = rels.get(rid or "", {})
        target = rel.get("target")
        slides.append(
            {
                "number": number,
                "presentationSlideId": slide_id.attrib.get("id"),
                "rid": rid,
                "path": f"ppt/{target}" if target else None,
            }
        )
    size = presentation.find(".//p:sldSz", NS)
    slide_size = None
    if size is not None:
        slide_size = {
            "cx": int(size.attrib.get("cx", "0")),
            "cy": int(size.attrib.get("cy", "0")),
            "type": size.attrib.get("type"),
        }
    return slides, slide_size


def slide_part_for_number(root: Path, slide_number: int) -> Path:
    slides, _ = presentation_slides(root)
    for slide in slides:
        if slide["number"] == slide_number and slide["path"]:
            return root / str(slide["path"])
    raise ValueError(f"Slide not found: {slide_number}")


def cnvpr_for_shape(shape: ET.Element) -> ET.Element | None:
    # Use only the non-visual subtree directly attached to this object.
    for child in list(shape):
        if local_name(child.tag).startswith("nv"):
            found = child.find(".//p:cNvPr", NS)
            if found is not None:
                return found
    return None


def creation_id(cnvpr: ET.Element | None) -> str | None:
    if cnvpr is None:
        return None
    creation = cnvpr.find(".//a16:creationId", NS)
    return creation.attrib.get("id") if creation is not None else None


def text_of(element: ET.Element) -> str:
    paragraphs = []
    for paragraph in element.findall(".//a:p", NS):
        value = "".join(text.text or "" for text in paragraph.findall(".//a:t", NS))
        if value:
            paragraphs.append(value)
    return "\n".join(paragraphs).strip()


def direct_xfrm(shape: ET.Element) -> ET.Element | None:
    for path in ("./p:spPr/a:xfrm", "./p:xfrm", "./p:grpSpPr/a:xfrm"):
        xfrm = shape.find(path, NS)
        if xfrm is not None:
            return xfrm
    return None


def bbox_of(shape: ET.Element) -> dict[str, int | None] | None:
    xfrm = direct_xfrm(shape)
    if xfrm is None:
        return None
    off = xfrm.find("./a:off", NS)
    ext = xfrm.find("./a:ext", NS)
    if off is None and ext is None:
        return None
    return {
        "x": int(off.attrib.get("x", "0")) if off is not None else None,
        "y": int(off.attrib.get("y", "0")) if off is not None else None,
        "cx": int(ext.attrib.get("cx", "0")) if ext is not None else None,
        "cy": int(ext.attrib.get("cy", "0")) if ext is not None else None,
        "rot": int(xfrm.attrib.get("rot", "0")) if xfrm.attrib.get("rot") is not None else None,
    }


def relationship_refs(element: ET.Element) -> list[dict[str, str]]:
    refs = []
    for node in element.iter():
        for attr, value in node.attrib.items():
            if not value:
                continue
            if attr in {q("r", "embed"), q("r", "link"), q("r", "id")}:
                refs.append({"element": local_name(node.tag), "attr": local_name(attr), "rid": value})
    seen: set[tuple[str, str, str]] = set()
    unique = []
    for ref in refs:
        key = (ref["element"], ref["attr"], ref["rid"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(ref)
    return unique


def shape_kind(shape: ET.Element) -> str:
    tag = local_name(shape.tag)
    if tag == "sp":
        c_nv_sp_pr = shape.find("./p:nvSpPr/p:cNvSpPr", NS)
        if c_nv_sp_pr is not None and c_nv_sp_pr.attrib.get("txBox") == "1":
            return "textBox"
        if shape.find(".//a:blip", NS) is not None:
            return "shapeWithImageFill"
        return "shape"
    if tag == "pic":
        if (
            shape.find(".//a:videoFile", NS) is not None
            or shape.find(".//a:audioFile", NS) is not None
            or shape.find(".//p14:media", NS) is not None
        ):
            return "mediaPosterPicture"
        return "picture"
    if tag == "graphicFrame":
        graphic_data = shape.find(".//a:graphicData", NS)
        if graphic_data is not None and graphic_data.attrib.get("uri"):
            return graphic_data.attrib["uri"].rsplit("/", 1)[-1]
        return "graphicFrame"
    return tag


def preset_geometry(shape: ET.Element) -> str | None:
    geom = shape.find(".//a:prstGeom", NS)
    return geom.attrib.get("prst") if geom is not None else None


def iter_shape_elements(container: ET.Element, path_prefix: str = "spTree") -> Iterable[tuple[ET.Element, str]]:
    interesting = {"sp", "pic", "graphicFrame", "cxnSp", "grpSp"}
    transparent = {"AlternateContent", "Choice", "Fallback"}
    for index, child in enumerate(list(container), 1):
        tag = local_name(child.tag)
        path = f"{path_prefix}/{tag}[{index}]"
        if tag in interesting:
            yield child, path
            if tag == "grpSp":
                yield from iter_shape_elements(child, path)
        elif tag in transparent:
            yield from iter_shape_elements(child, path)


def shape_matches(shape: ET.Element, selector: dict[str, Any]) -> bool:
    cnvpr = cnvpr_for_shape(shape)
    if cnvpr is None:
        return False
    checks = {
        "shapeId": cnvpr.attrib.get("id"),
        "id": cnvpr.attrib.get("id"),
        "shapeName": cnvpr.attrib.get("name"),
        "name": cnvpr.attrib.get("name"),
        "creationId": creation_id(cnvpr),
        "kind": shape_kind(shape),
    }
    for key, actual in checks.items():
        if key in selector and str(selector[key]) != str(actual):
            return False
    return True


def find_shapes(slide_root: ET.Element, selector: dict[str, Any]) -> list[tuple[ET.Element, str]]:
    tree = slide_root.find("./p:cSld/p:spTree", NS)
    if tree is None:
        return []
    return [(shape, path) for shape, path in iter_shape_elements(tree) if shape_matches(shape, selector)]


def sha1_short(path: Path) -> str:
    hasher = hashlib.sha1()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()[:12]


def next_rid(rels: Iterable[dict[str, str | None]]) -> str:
    max_number = 0
    for rel in rels:
        match = re.fullmatch(r"rId(\d+)", str(rel.get("id") or ""))
        if match:
            max_number = max(max_number, int(match.group(1)))
    return f"rId{max_number + 1}"


def next_media_name(media_dir: Path, prefix: str, extension: str) -> str:
    max_number = 0
    pattern = re.compile(rf"{re.escape(prefix)}(\d+)\.[^.]+$")
    for file_path in media_dir.glob(f"{prefix}*.*"):
        match = pattern.fullmatch(file_path.name)
        if match:
            max_number = max(max_number, int(match.group(1)))
    return f"{prefix}{max_number + 1}.{extension.lower()}"


def image_content_type(extension: str) -> str:
    extension = extension.lower().lstrip(".")
    explicit = {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "gif": "image/gif",
        "bmp": "image/bmp",
        "svg": "image/svg+xml",
        "webp": "image/webp",
    }
    if extension in explicit:
        return explicit[extension]
    guessed, _ = mimetypes.guess_type(f"file.{extension}")
    if guessed and guessed.startswith("image/"):
        return guessed
    raise ValueError(f"Unsupported image extension: {extension}")


def image_dimensions(path: Path) -> tuple[int, int] | None:
    data = path.read_bytes()
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data[:3] == b"\xff\xd8\xff":
        index = 2
        while index + 9 < len(data):
            while index < len(data) and data[index] == 0xFF:
                index += 1
            if index >= len(data):
                return None
            marker = data[index]
            index += 1
            if marker in {0xD8, 0xD9}:
                continue
            if index + 2 > len(data):
                return None
            length = int.from_bytes(data[index : index + 2], "big")
            if length < 2 or index + length > len(data):
                return None
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                height = int.from_bytes(data[index + 3 : index + 5], "big")
                width = int.from_bytes(data[index + 5 : index + 7], "big")
                return width, height
            index += length
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        if len(data) >= 10:
            return struct.unpack("<HH", data[6:10])
    return None


def ensure_default_content_type(root: Path, extension: str, content_type: str) -> bool:
    extension = extension.lower().lstrip(".")
    content_types_path = root / "[Content_Types].xml"
    tree = parse_xml(content_types_path)
    types = tree.getroot()
    for child in types:
        if local_name(child.tag) == "Default" and child.attrib.get("Extension", "").lower() == extension:
            return False
    ET.SubElement(types, ct_q("Default"), {"Extension": extension, "ContentType": content_type})
    write_xml(content_types_path, tree)
    return True
