from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

from .author import create_deck_from_scene
from .capabilities import build_capabilities
from .explorer import write_explore
from .indexer import write_index
from .ooxml import pack_pptx, safe_extract_pptx, write_json
from .patcher import apply_patch_file
from .validator import validate_package


def _print_json(data) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def cmd_unpack(args: argparse.Namespace) -> int:
    safe_extract_pptx(args.input, args.out, overwrite=args.force)
    _print_json({"ok": True, "out": str(args.out)})
    return 0


def cmd_index(args: argparse.Namespace) -> int:
    index = write_index(args.deck, args.out)
    _print_json({"ok": True, "out": str(args.out), "counts": index["counts"]})
    return 0


def cmd_explore(args: argparse.Namespace) -> int:
    data = write_explore(args.deck, args.out, include_xml=args.include_xml)
    _print_json(
        {
            "ok": True,
            "out": str(args.out),
            "summary": data["summary"],
            "schemaInventory": data["schemaInventory"],
        }
    )
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    report = validate_package(args.deck)
    if args.out:
        write_json(args.out, report)
    _print_json(report)
    return 0 if report["ok"] else 2


def cmd_patch(args: argparse.Namespace) -> int:
    report = apply_patch_file(args.deck, args.patch, validate=not args.no_validate)
    if args.out:
        write_json(args.out, report)
    _print_json(report)
    return 0 if report["ok"] else 2


def cmd_pack(args: argparse.Namespace) -> int:
    pack_pptx(args.deck, args.out)
    with zipfile.ZipFile(args.out) as archive:
        bad = archive.testzip()
    report = {"ok": bad is None, "out": str(args.out), "zipTest": "ok" if bad is None else bad}
    _print_json(report)
    return 0 if bad is None else 2


def cmd_create(args: argparse.Namespace) -> int:
    report = create_deck_from_scene(args.scene, args.out, overwrite=args.force)
    _print_json(report)
    return 0


def cmd_capabilities(args: argparse.Namespace) -> int:
    caps = build_capabilities()
    if args.out:
        write_json(args.out, caps)
    _print_json(caps)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pptx-native", description="Native PPTX-as-code pipeline.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="Compile a JSON scene spec into a native PPTX package directory.")
    create.add_argument("scene", type=Path)
    create.add_argument("--out", type=Path, required=True)
    create.add_argument("--force", action="store_true", help="Replace the output directory if it already exists.")
    create.set_defaults(func=cmd_create)

    unpack = subparsers.add_parser("unpack", help="Extract a .pptx into an editable package directory.")
    unpack.add_argument("input", type=Path)
    unpack.add_argument("--out", type=Path, required=True)
    unpack.add_argument("--force", action="store_true", help="Replace the output directory if it already exists.")
    unpack.set_defaults(func=cmd_unpack)

    index = subparsers.add_parser("index", help="Build a scene/index JSON for an unpacked deck.")
    index.add_argument("deck", type=Path)
    index.add_argument("--out", type=Path, required=True)
    index.set_defaults(func=cmd_index)

    explore = subparsers.add_parser("explore", help="Build an exhaustive native control/property map.")
    explore.add_argument("deck", type=Path)
    explore.add_argument("--out", type=Path, required=True)
    explore.add_argument("--include-xml", action="store_true", help="Include raw XML for each native control.")
    explore.set_defaults(func=cmd_explore)

    validate = subparsers.add_parser("validate", help="Validate package relationships, content types, and timing targets.")
    validate.add_argument("deck", type=Path)
    validate.add_argument("--out", type=Path)
    validate.set_defaults(func=cmd_validate)

    patch = subparsers.add_parser("patch", help="Apply structured patch operations.")
    patch.add_argument("deck", type=Path)
    patch.add_argument("patch", type=Path)
    patch.add_argument("--out", type=Path)
    patch.add_argument("--no-validate", action="store_true")
    patch.set_defaults(func=cmd_patch)

    pack = subparsers.add_parser("pack", help="Pack an unpacked deck directory back into a .pptx.")
    pack.add_argument("deck", type=Path)
    pack.add_argument("--out", type=Path, required=True)
    pack.set_defaults(func=cmd_pack)

    caps = subparsers.add_parser("capabilities", help="Emit the machine-readable capability manifest.")
    caps.add_argument("--out", type=Path)
    caps.set_defaults(func=cmd_capabilities)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
