"""Read-only extraction of current hideout UI evidence; writes this research folder only."""
from pathlib import Path
import hashlib
import importlib.util
import json
import urllib.error
import urllib.request

OUT = Path(__file__).resolve().parent
WORKSPACE = OUT.parents[2]
GAME = Path(r"C:\Program Files (x86)\Steam\steamapps\common\Deadlock\game")
COMMIT = "4c6431ccdb816d2911bbbaa4335169cc34140386"
PREFIX = f"https://raw.githubusercontent.com/SteamTracking/GameTracking-Deadlock/{COMMIT}/game/citadel/pak01_dir/"
SPEC = importlib.util.spec_from_file_location("read_only_vpk_audit", WORKSPACE / "optimization/tools/audit-vpk.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
VPK = GAME / "citadel/pak01_dir.vpk"
HEADER, ENTRIES = AUDIT.index_vpk(VPK)
NAMES = [
    "cfg/citadel_keys.lst", "panorama/citadel_keybinds.cfg",
    "panorama/layout/hud_hideout.vxml_c", "panorama/layout/hud_escape_menu.vxml_c",
    "panorama/layout/dashboard.vxml_c", "panorama/layout/citadel_db_page_watch.vxml_c",
    "panorama/layout/hideout/hideout_in_world_label.vxml_c",
    "panorama/layout/hideout/hideout_in_world_text_label.vxml_c",
]
RECORDS = []
for name in NAMES:
    entry = next(e for e in ENTRIES if e["path"] == name)
    payload = AUDIT.extract(VPK, HEADER, entry)
    destination = OUT / "installed" / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)
    record = {"installed_resource": name, "crc_verified": True, "crc32": entry["crc32"],
              "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    mirror_name = name.replace(".vxml_c", ".xml")
    url = PREFIX + mirror_name
    try:
        mirrored = urllib.request.urlopen(url, timeout=25).read()
    except urllib.error.HTTPError as error:
        record.update({"mirror_attempted_url": url, "mirror_http_status": error.code})
    else:
        mirror_destination = OUT / "mirror" / mirror_name
        mirror_destination.parent.mkdir(parents=True, exist_ok=True)
        mirror_destination.write_bytes(mirrored)
        record.update({"mirror_url": url, "mirror_bytes": len(mirrored),
                       "mirror_sha256": hashlib.sha256(mirrored).hexdigest(),
                       "byte_identical_to_installed": mirrored == payload})
    RECORDS.append(record)
MANIFEST = {"read_only_game": True, "build_id": 25689475, "tracking_commit": COMMIT,
            "reconstruction_limit": "XML is pinned third-party VRF reconstruction. This audit CRC-checks the actual installed compiled resources but does not newly decompile them.",
            "records": RECORDS}
(OUT / "manifest.json").write_text(json.dumps(MANIFEST, indent=2), encoding="utf-8")
print(json.dumps({"records": len(RECORDS), "manifest": str(OUT / "manifest.json")}))
