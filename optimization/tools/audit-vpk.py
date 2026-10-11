"""Read-only inventory and CRC-checked extraction of small Valve VPK resources.

This never loads game DLLs, reads process memory, or writes into the game.
Only explicitly selected configuration/UI resources are extracted locally.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import zlib

SIGNATURE = 0x55AA1234
MAX_RESOURCE = 4 * 1024 * 1024


def index_vpk(path: Path) -> tuple[dict, list[dict]]:
    with path.open("rb") as handle:
        header = handle.read(12)
        if len(header) != 12:
            raise ValueError(f"Truncated VPK header: {path}")
        signature, version, tree_size = struct.unpack("<III", header)
        if signature != SIGNATURE or version not in (1, 2):
            raise ValueError(f"Unsupported VPK signature/version: {path}")
        header_size = 28 if version == 2 else 12
        if version == 2:
            handle.read(16)
        if tree_size > path.stat().st_size - header_size:
            raise ValueError(f"Invalid VPK directory bounds: {path}")
        tree = handle.read(tree_size)
    position = 0
    entries = []

    def read_string() -> str:
        nonlocal position
        end = tree.find(b"\0", position)
        if end < 0:
            raise ValueError(f"Unterminated directory string: {path}")
        value = tree[position:end].decode("utf-8", errors="strict")
        position = end + 1
        return value

    while (extension := read_string()):
        while (directory := read_string()):
            while (name := read_string()):
                if position + 18 > len(tree):
                    raise ValueError(f"Truncated directory entry: {path}")
                crc, preload_size, archive, offset, length, terminator = struct.unpack_from(
                    "<IHHIIH", tree, position
                )
                position += 18
                if terminator != 0xFFFF or position + preload_size > len(tree):
                    raise ValueError(f"Invalid directory entry: {path}")
                preload_offset = position
                position += preload_size
                resource = ("" if directory == " " else directory + "/") + name
                if extension != " ":
                    resource += "." + extension
                parts = Path(resource.replace("\\", "/")).parts
                if resource.startswith(("/", "\\")) or ".." in parts or ":" in resource:
                    raise ValueError(f"Unsafe resource path in VPK: {resource}")
                entries.append({
                    "path": resource, "crc32": f"{crc:08x}", "archive": archive,
                    "offset": offset, "bytes": length + preload_size,
                    "length": length, "preload_offset": preload_offset,
                    "preload_bytes": preload_size,
                })
    return {
        "directory": str(path), "version": version, "header_bytes": header_size,
        "tree_bytes": tree_size, "tree_sha256": hashlib.sha256(tree).hexdigest(),
    }, entries


def extract(path: Path, header: dict, entry: dict) -> bytes:
    if entry["bytes"] > MAX_RESOURCE:
        raise ValueError("Selected resource exceeds extraction size limit")
    with path.open("rb") as handle:
        handle.seek(header["header_bytes"] + entry["preload_offset"])
        preload = handle.read(entry["preload_bytes"])
    archive = entry["archive"]
    if archive == 0x7FFF:
        data_path = path
        data_offset = header["header_bytes"] + header["tree_bytes"] + entry["offset"]
    else:
        data_path = path.with_name(path.name.replace("_dir.vpk", f"_{archive:03d}.vpk"))
        data_offset = entry["offset"]
    if data_offset + entry["length"] > data_path.stat().st_size:
        raise ValueError(f"Resource extends beyond archive: {entry['path']}")
    with data_path.open("rb") as handle:
        handle.seek(data_offset)
        payload = preload + handle.read(entry["length"])
    if len(payload) != entry["bytes"]:
        raise ValueError(f"Truncated resource: {entry['path']}")
    if f"{zlib.crc32(payload):08x}" != entry["crc32"]:
        raise ValueError(f"CRC mismatch: {entry['path']}")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    game_root = args.game_root.resolve(strict=True)
    output = args.output.resolve()
    if output == game_root or game_root in output.parents:
        raise ValueError("Output must be outside the game installation")
    output.mkdir(parents=True, exist_ok=True)
    records = []
    for relative in ("citadel/pak01_dir.vpk", "core/pak01_dir.vpk"):
        vpk_path = game_root / relative
        header, entries = index_vpk(vpk_path)
        missing_archives = sorted({e["archive"] for e in entries if e["archive"] != 0x7FFF
            and not vpk_path.with_name(vpk_path.name.replace("_dir.vpk", f"_{e['archive']:03d}.vpk")).is_file()})
        summary = {**header, "resources": len(entries), "missing_archives": missing_archives,
                   "indexed_resource_bytes": sum(e["bytes"] for e in entries), "extracted": []}
        for entry in entries:
            resource = entry["path"]
            selected = resource.startswith("cfg/") and resource.endswith((".txt", ".cfg", ".vcfg"))
            selected |= "settings" in resource.lower() and resource.startswith("panorama/")
            if not selected or entry["bytes"] > MAX_RESOURCE:
                continue
            payload = extract(vpk_path, header, entry)
            target = output / relative.split("/")[0] / resource
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            summary["extracted"].append({"path": resource, "bytes": len(payload),
                "crc32": entry["crc32"], "crc_verified": True,
                "sha256": hashlib.sha256(payload).hexdigest()})
        compact_entries = [{k: e[k] for k in ("path", "crc32", "archive", "offset", "bytes")} for e in entries]
        (output / f"{relative.split('/')[0]}-vpk-index.json").write_text(
            json.dumps(compact_entries, separators=(",", ":")), encoding="utf-8")
        records.append(summary)
    report = {"read_only_game": True, "full_archive_integrity_verified": False,
              "scope": "All directory entries in core/citadel pak01; CRC checked for extracted config/UI resources", "vpk": records}
    (output / "vpk-audit.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"resources": sum(r["resources"] for r in records),
        "extracted": sum(len(r["extracted"]) for r in records),
        "missing_archives": [r["missing_archives"] for r in records], "report": str(output / "vpk-audit.json")}))


if __name__ == "__main__":
    main()
