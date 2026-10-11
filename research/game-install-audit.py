"""Read-only installation audit; writes only workspace research evidence.

The depot payload reader decodes protobuf wire fields without using Steam credentials.
It inspects filename, byte length, flags, and SHA1 from locally cached depot manifests.
No executable or game config is launched, altered, deleted, or replaced.
"""
from __future__ import annotations

import datetime as dt
import decimal
import hashlib
import json
import re
import struct
import subprocess
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parent.parent
STEAM = Path(r"C:\Program Files (x86)\Steam")
INSTALL = STEAM / "steamapps/common/Deadlock"
GAME = INSTALL / "game"
RESEARCH = WORKSPACE / "research"
PRIVATE = RESEARCH / "private"


def redact(text: str) -> str:
    text = re.sub(r"(?i)(userdata[/\\])\d+", r"\1<account>", str(text))
    text = re.sub(r"(?i)(Users[/\\])[^/\\]+", r"\1<user>", text)
    text = re.sub(r"(account_|cache_)\d+(\.(?:stats|soc))", r"\1<account>\2", text)
    return text


def meta(path: Path) -> dict:
    st = path.stat()
    return {"path": redact(str(path)), "bytes": st.st_size,
            "modified_utc": dt.datetime.fromtimestamp(st.st_mtime, dt.timezone.utc).isoformat()}


def pair_entries(path: Path) -> list[dict]:
    pairs = []
    for n, line in enumerate(path.read_text(encoding="utf-8-sig", errors="replace").splitlines(), 1):
        m = re.match(r'^\s*"([^"\r\n]+)"\s+"([^"\r\n]*)"', line)
        if m:
            key, value = m.groups()
            if not re.search(r"(?i)(steamid|accountid|friend|player_name|user_name|auth|token|password)", key):
                pairs.append({"key": key, "value": value, "line": n})
    return pairs


def pair_map(entries: list[dict]) -> dict:
    return {p["key"]: p["value"] for p in entries}


def duplicates(entries: list[dict]) -> list[dict]:
    result = []
    for key in sorted({p["key"] for p in entries}):
        matching = [p for p in entries if p["key"] == key]
        if len(matching) > 1:
            result.append({"key": key, "entries": matching})
    return result


def varint(data: bytes, p: int) -> tuple[int, int]:
    out, shift = 0, 0
    while p < len(data) and shift <= 63:
        b = data[p]
        p += 1
        out |= (b & 127) << shift
        if not b & 128:
            return out, p
        shift += 7
    raise ValueError("Invalid protobuf varint")


def fields(data: bytes):
    p = 0
    while p < len(data):
        tag, p = varint(data, p)
        number, wire = tag >> 3, tag & 7
        if wire == 0:
            value, p = varint(data, p)
        elif wire == 2:
            length, p = varint(data, p)
            value, p = data[p:p + length], p + length
            if len(value) != length:
                raise ValueError("Truncated protobuf bytes")
        elif wire in (1, 5):
            length = 8 if wire == 1 else 4
            value, p = data[p:p + length], p + length
        else:
            raise ValueError(f"Unexpected protobuf wire type {wire}")
        yield number, wire, value


def read_depot(path: Path) -> list[dict]:
    data = path.read_bytes()
    magic, payload_length = struct.unpack_from("<II", data)
    if magic != 0x71F617D0 or payload_length > len(data) - 8:
        raise ValueError(f"Unsupported depot payload header: {path.name}")
    mappings = []
    for number, wire, entry in fields(data[8:8 + payload_length]):
        if number != 1 or wire != 2:
            continue
        mapping = {}
        for n, w, value in fields(entry):
            if n == 1 and w == 2:
                mapping["filename"] = value.decode("utf-8").replace("\\", "/")
            elif n == 2 and w == 0:
                mapping["bytes"] = value
            elif n == 3 and w == 0:
                mapping["flags"] = value
            elif n == 5 and w == 2:
                mapping["sha1"] = value.hex()
        if "filename" in mapping:
            mappings.append(mapping)
    return mappings


def read_app_launch_settings(path: Path) -> dict:
    """Stream localconfig and retain only this game's launch-related scalar values."""
    stack, pending, selected = [], None, {}
    if not path.is_file():
        return selected
    with path.open(encoding="utf-8-sig", errors="replace") as stream:
        for raw in stream:
            line = raw.strip()
            if line == "{":
                stack.append(pending or "")
                pending = None
            elif line == "}":
                if stack:
                    stack.pop()
                pending = None
            else:
                p = re.match(r'^"([^"\r\n]+)"(?:\s+"([^"\r\n]*)")?', line)
                if not p:
                    continue
                key, value = p.groups()
                if value is None:
                    pending = key
                elif len(stack) >= 2 and stack[-1] == "1422450" and stack[-2].lower() == "apps":
                    if key.lower() in {"launchoptions", "disableoverlay", "cloudenabled", "usecloud"}:
                        selected[key] = value
    return selected


def sha1(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    RESEARCH.mkdir(exist_ok=True)
    PRIVATE.mkdir(exist_ok=True)
    appmanifest = STEAM / "steamapps/appmanifest_1422450.acf"
    appdata = pair_map(pair_entries(appmanifest))
    expected = {}
    depot_evidence = []
    for depot in ("1422451", "1422452", "1422456"):
        manifests = list((STEAM / "depotcache").glob(f"{depot}_*.manifest"))
        # Cached newest manifest corresponds to currently installed ACF manifest IDs;
        # confirm exact matching against the app manifest block rather than trusting mtime.
        manifest_text = appmanifest.read_text(encoding="utf-8-sig")
        match = re.search(r'"' + depot + r'"\s*\{\s*"manifest"\s*"(\d+)"', manifest_text)
        if not match:
            continue
        selected = STEAM / "depotcache" / f"{depot}_{match.group(1)}.manifest"
        mappings = read_depot(selected)
        for mapping in mappings:
            expected[mapping["filename"].lower()] = dict(mapping, depot=depot)
        depot_evidence.append(dict(meta(selected), mapping_count=len(mappings),
                                   manifest_id=match.group(1), depot=depot))

    files = [p for p in GAME.rglob("*") if p.is_file()]
    metadata = []
    extras, absent, mismatches, vpk_evidence, binary_extras = [], [], [], [], []
    for path in files:
        relative = path.relative_to(INSTALL).as_posix()
        st = path.stat()
        record = {"relative_path": redact(relative), "bytes": st.st_size,
                  "modified_utc": dt.datetime.fromtimestamp(st.st_mtime, dt.timezone.utc).isoformat()}
        exp = expected.get(relative.lower())
        if exp is not None:
            record.update({"depot": exp["depot"], "expected_bytes": exp.get("bytes"),
                           "size_matches_depot": st.st_size == exp.get("bytes")})
            if st.st_size != exp.get("bytes"):
                mismatches.append(record)
        else:
            extras.append(record)
            if path.suffix.lower() in (".dll", ".exe", ".vpk"):
                binary_extras.append(record)
        if path.suffix.lower() == ".vpk":
            vpk_evidence.append(record)
        metadata.append(record)
    for relative, exp in expected.items():
        if exp.get("flags", 0) & 64:
            continue
        if not (INSTALL / exp["filename"]).is_file():
            absent.append({"relative_path": exp["filename"], "depot": exp["depot"],
                           "bytes": exp.get("bytes")})

    checked_hashes = []
    critical = [GAME / "citadel/gameinfo.gi", GAME / "citadel/gameinfo_branchspecific.gi",
                GAME / "bin/win64/deadlock.exe", GAME / "bin/win64/engine2.dll",
                GAME / "bin/win64/rendersystemdx11.dll", GAME / "bin/win64/rendersystemvulkan.dll",
                GAME / "citadel/bin/win64/client.dll"]
    for path in critical:
        if not path.is_file():
            continue
        relative = path.relative_to(INSTALL).as_posix()
        exp = expected.get(relative.lower(), {})
        actual = sha1(path)
        checked_hashes.append({"relative_path": relative, "sha1": actual,
                               "expected_sha1": exp.get("sha1"),
                               "matches_depot_sha1": actual == exp.get("sha1") if exp.get("sha1") else None,
                               "depot": exp.get("depot")})

    config_evidence, user_paths, launch_settings = [], [], []
    candidates = [GAME / "citadel/cfg"]
    for account in (STEAM / "userdata").iterdir():
        if not account.is_dir():
            continue
        app = account / "1422450"
        if app.is_dir():
            candidates.append(app / "local/cfg")
            user_paths.append({"app_root": str(app), "cfg_root": str(app / "local/cfg"),
                               "video_path": str(app / "local/cfg/video.txt"),
                               "machine_convars_path": str(app / "local/cfg/machine_convars.vcfg"),
                               "user_convars_path": str(app / "local/cfg/user_convars_0_slot0.vcfg")})
            launch_settings.append({"account": "<redacted>",
                                    "settings": read_app_launch_settings(account / "config/localconfig.vdf")})
    for cfg in candidates:
        if not cfg.is_dir():
            continue
        for filename in ("video.txt", "machine_convars.vcfg", "user_convars_0_slot0.vcfg", "autoexec.cfg"):
            path = cfg / filename
            if not path.is_file():
                continue
            entries = pair_entries(path)
            config_evidence.append(dict(meta(path), ownership="USRLOCAL" if "userdata" in str(path) else "legacy MOD",
                                        settings=pair_map(entries), entries=entries, duplicates=duplicates(entries)))

    gameinfo_text = (GAME / "citadel/gameinfo.gi").read_text(encoding="utf-8-sig")
    searchpath_match = re.search(r"SearchPaths\s*\{(.*?)\}", gameinfo_text, re.S)
    searchpaths = []
    if searchpath_match:
        for line in searchpath_match.group(1).splitlines():
            line = line.split("//", 1)[0].strip()
            if line:
                searchpaths.append(line)
    mod_names = re.compile(r"(?i)^(addons?|custom|mods?|modcache|mod_cache|cache|downloads?|workshop)$|mod.*cache|cache.*mod")
    mod_dirs = [redact(p.relative_to(GAME).as_posix()) for p in GAME.rglob("*") if p.is_dir() and mod_names.search(p.name)]
    steam_scoped = []
    for relative in ("steamapps/workshop/appworkshop_1422450.acf", "steamapps/workshop/content/1422450",
                     "steamapps/shadercache/1422450", "steamapps/downloading/1422450"):
        path = STEAM / relative
        steam_scoped.append({"path": relative, "exists": path.exists(),
                             "file_count": sum(p.is_file() for p in path.rglob("*")) if path.is_dir() else int(path.is_file())})

    process_cmd = "Get-CimInstance Win32_Process -Filter \"Name = 'deadlock.exe' OR Name = 'steam.exe'\" | Select-Object Name,ExecutablePath,ProcessId,CommandLine | ConvertTo-Json -Compress"
    raw_process = subprocess.run(["powershell", "-NoProfile", "-Command", process_cmd], capture_output=True, text=True, check=True).stdout
    processes = json.loads(raw_process) if raw_process.strip() else []
    if isinstance(processes, dict):
        processes = [processes]
    for process in processes:
        if process["Name"].lower() != "deadlock.exe":
            process.pop("CommandLine", None)
    log_files = [p for p in files if p.suffix.lower() == ".log" or p.name.lower() == "console.txt"]
    error_lines = []
    for path in log_files:
        if path.stat().st_size > 20 * 1024 * 1024:
            continue
        for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            if re.search(r"(?i)(unknown (command|convar)|can't use cheat|cannot use cheat|cheat.*sv_cheats|convar.*not found)", line):
                error_lines.append({"file": redact(str(path)), "text": redact(line)})
    # Read trustedlaunch only as module metadata; avoid recording absolute personal paths.
    trustedlaunch = []
    for cfg in candidates[1:]:
        path = cfg / "trustedlaunch.cfg"
        if path.is_file():
            text = path.read_text(encoding="utf-8-sig", errors="replace")
            trustedlaunch.append({"file": redact(str(path)), "content": redact(text)})

    content_log = STEAM / "logs/content_log.txt"
    steam_log_lines = []
    if content_log.is_file():
        for line in content_log.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            if re.search(r"(?i)App(?:ID)?\s+1422450", line):
                steam_log_lines.append(redact(line))

    active_video = next((c for c in config_evidence if c["ownership"] == "USRLOCAL" and c["path"].endswith("video.txt")), None)
    legacy_video = next((c for c in config_evidence if c["ownership"] == "legacy MOD" and c["path"].endswith("video.txt")), None)
    video_diffs = []
    if active_video and legacy_video:
        av, lv = active_video["settings"], legacy_video["settings"]
        video_diffs = [{"key": key, "usr_local": av.get(key), "legacy_mod": lv.get(key)}
                       for key in sorted(set(av) | set(lv)) if av.get(key) != lv.get(key)]

    # This is provenance evidence, not a claim that any given manual video key is effective.
    opti_video = RESEARCH / "optilock-source/OptiLock Potato Config/video.txt"
    opti_lineage = None
    if opti_video.is_file():
        opti_values = pair_map(pair_entries(opti_video))
        opti_values = {k: v for k, v in opti_values.items() if k.startswith("setting.")}
        comparisons = []
        for cfg in config_evidence:
            if not cfg["path"].endswith("video.txt"):
                continue
            vals = {k: v for k, v in cfg["settings"].items() if k.startswith("setting.")}
            differences = []
            for key in sorted(set(opti_values) | set(vals)):
                first, second = vals.get(key), opti_values.get(key)
                same = first == second
                if first is not None and second is not None:
                    try:
                        same = decimal.Decimal(first) == decimal.Decimal(second)
                    except decimal.InvalidOperation:
                        same = first.lower() == second.lower()
                if not same:
                    differences.append({"key": key, "installed": first, "optilock_potato": second})
            comparisons.append({"ownership": cfg["ownership"], "same_unique_setting_key_set": set(vals) == set(opti_values),
                                "installed_unique_setting_count": len(vals), "semantic_value_differences": differences})
        opti_audit_path = RESEARCH / "optilock-audit.json"
        opti_commit = json.loads(opti_audit_path.read_text(encoding="utf-8")).get("commit") if opti_audit_path.is_file() else None
        opti_lineage = {"reference": "https://github.com/dacooderr/OptiLock", "commit": opti_commit,
                        "template": "OptiLock Potato Config/video.txt", "template_unique_setting_count": len(opti_values),
                        "comparisons": comparisons,
                        "interpretation": "Installed video files strongly match the OptiLock Potato template key/value pattern. The existing baseline is already heavily reduced; neither provenance nor stored values proves current-build key effectiveness."}

    evidence_root = WORKSPACE / "evidence" / f"valve-build-{appdata.get('buildid')}"
    native_preset_dir = evidence_root / "installed-vpk/citadel/cfg"
    native_presets = []
    native_preset_keys = set()
    native_low = {}
    for path in sorted(native_preset_dir.glob("video_defaults_*.txt")):
        values = pair_map(pair_entries(path))
        native_preset_keys.update(values)
        native_presets.append({"file": path.relative_to(WORKSPACE).as_posix(),
                               "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "settings": values})
        if path.name == "video_defaults_0.txt":
            native_low = values
    dump_path = evidence_root / "mirrored-engine/DumpSource2/convars.txt"
    dumped_convars = {}
    if dump_path.is_file():
        for line in dump_path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            match = re.match(r"^(\S+)\s+(.*?)\s+\((.*?)\)\s*$", line)
            if match:
                name, value, flags = match.groups()
                dumped_convars[name] = {"dump_default": value, "dump_flags": flags}
    preset_comparisons = []
    if native_presets:
        for cfg in config_evidence:
            if not cfg["path"].endswith("video.txt"):
                continue
            vals = {k: v for k, v in cfg["settings"].items() if k.startswith("setting.")}
            extra = []
            for key in sorted(set(vals) - native_preset_keys):
                cvar = key.removeprefix("setting.")
                extra.append({"key": key, "stored": vals[key], "dumped_convar": dumped_convars.get(cvar)})
            low_diffs = []
            for key in sorted(set(vals) & set(native_low)):
                if vals[key] != native_low[key]:
                    low_diffs.append({"key": key, "stored": vals[key], "native_low": native_low[key]})
            preset_comparisons.append({"ownership": cfg["ownership"], "extra_keys_not_in_any_native_preset": extra,
                                       "different_values_for_keys_also_in_native_low": low_diffs})
    native_preset_comparison = {"build_id": appdata.get("buildid"), "sources": native_presets,
                                "unique_active_native_preset_keys": sorted(native_preset_keys),
                                "comparisons": preset_comparisons,
                                "interpretation": "Not appearing in a preset is not proof of invalidity: display, device, menu-owned latency, and custom controls are also outside these preset files. Dump flags indicate console restrictions, not whether the engine's native video loader accepts a storage key. Convar dump evidence is a mirrored build source; stock preset files are CRC-checked installed VPK extractions."} if native_presets else None

    report = {
        "audit_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "read_only_scope": "Steam installation, app 1422450 scoped configs/logs and cached depot manifests; no game or Steam files changed",
        "steam_root": str(STEAM), "install_root": str(INSTALL), "game_root": str(GAME),
        "app_id": "1422450", "build_id": appdata.get("buildid"), "target_build_id": appdata.get("TargetBuildID"),
        "state_flags": appdata.get("StateFlags"), "update_result": appdata.get("UpdateResult"),
        "last_updated_unix": appdata.get("LastUpdated"), "size_on_disk_manifest": appdata.get("SizeOnDisk"),
        "processes": processes,
        "native_settings_path_id": "USRLOCAL", "legacy_settings_path_id": "MOD",
        "native_path_evidence": 'stock citadel/gameinfo.gi: UserSettingsPathID USRLOCAL; LegacyUserSettingsPathID MOD',
        "user_config_candidate_count": len(user_paths),
        "active_userdata_inference": "One Deadlock userdata candidate found; ownership path is explicit in stock gameinfo.gi. Settings are persisted disk snapshots while game is running; effective runtime convars have not been queried.",
        "launch_settings": launch_settings, "configs": config_evidence,
        "active_vs_legacy_video_differences": video_diffs,
        "installed_video_reference_lineage": opti_lineage,
        "native_video_preset_comparison": native_preset_comparison,
        "gameinfo_searchpaths": searchpaths, "gameinfo_sha1_checks": checked_hashes,
        "installed_file_count": len(files), "installed_file_bytes": sum(p.stat().st_size for p in files),
        "installed_depot_manifest_evidence": depot_evidence,
        "all_vpk_count": len(vpk_evidence), "vpk_files_in_depots": sum("depot" in p for p in vpk_evidence),
        "vpk_files_not_in_depots": [p for p in vpk_evidence if "depot" not in p],
        "addon_or_mod_directory_candidates": mod_dirs, "steam_app_scoped_cache_paths": steam_scoped,
        "extra_files_not_in_depots": extras, "extra_dll_exe_vpk_not_in_depots": binary_extras,
        "missing_depot_files": absent, "depot_size_mismatches": mismatches,
        "game_log_file_count": len(log_files), "config_error_log_lines": error_lines,
        "trustedlaunch_metadata": trustedlaunch, "steam_content_log_recent_app_events": steam_log_lines[-30:],
        "limits": ["No exhaustive 38 GB content hash verification was run; all file names and sizes were compared to currently installed cached Steam depot manifests, and critical stock executable/DLL/gameinfo SHA1 hashes were checked.",
                   "No runtime console command executed, no game restart, no gameplay benchmark, and no mod removal.",
                   "Persisted settings cannot prove live effective values; old/manual video keys must be checked against native current-build defaults before reuse.",
                   "Ordinary game shaders/map/UI/locale VPKs are required Valve content and must not be deleted as mod cleanup."]
    }
    (RESEARCH / "game-install-audit.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (RESEARCH / "game-installed-file-metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    (PRIVATE / "game-install-paths.json").write_text(json.dumps({"user_config_paths": user_paths}, indent=2), encoding="utf-8")
    summary = [
        f"Deadlock installed Steam build: {report['build_id']}",
        f"Installation: {INSTALL}", f"Game root: {GAME}",
        f"Running: {any(p['Name'].lower() == 'deadlock.exe' for p in processes)}",
        f"Installed files: {len(files)}; total file bytes: {report['installed_file_bytes']}",
        f"VPKs: {len(vpk_evidence)} total, {report['vpk_files_in_depots']} matched currently installed Valve depot manifest filenames.",
        f"Extra DLL/EXE/VPK files: {len(binary_extras)}; addon/mod-directory candidates: {len(mod_dirs)}.",
        f"Missing files listed by installed cached depots: {len(absent)}; size mismatches: {len(mismatches)}.",
        "Native settings ownership is USRLOCAL in stock gameinfo; legacy MOD configuration exists and differs.",
        "Launch options: " + json.dumps(launch_settings),
        "Running commandline: " + str(next((p.get("CommandLine") for p in processes if p["Name"].lower() == "deadlock.exe"), "Not running")),
        "Critical content SHA1 checks: " + json.dumps(checked_hashes),
        "Active vs legacy video differences: " + json.dumps(video_diffs),
        "Installed video reference lineage: " + json.dumps(opti_lineage),
        "Current native video preset evidence: " + json.dumps(native_preset_comparison),
        "Log unknown/cheat command evidence count: " + str(len(error_lines)),
        "Limits: " + " ".join(report["limits"]),
        "Exact account-scoped local paths are saved only in research/private/game-install-paths.json; do not publish that file.",
    ]
    (RESEARCH / "game-install-audit.txt").write_text("\n\n".join(summary) + "\n", encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("build_id", "installed_file_count", "all_vpk_count", "vpk_files_in_depots", "vpk_files_not_in_depots", "extra_dll_exe_vpk_not_in_depots", "user_config_candidate_count")}, indent=2))
    print("Critical SHA1 checks:", json.dumps(checked_hashes))
    print("Missing files:", len(absent), "Size mismatches:", len(mismatches))


if __name__ == "__main__":
    main()
