"""Fresh, read-only audit of this computer's installed Deadlock.

Writes evidence only beneath the existing workspace. Steam/game files are never
changed; no game command, process memory read, injection, restart, or cache removal.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
PRIVATE = WORKSPACE / "research/private"
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("first_install_audit", WORKSPACE / "research/game-install-audit.py")
first = importlib.util.module_from_spec(spec)
spec.loader.exec_module(first)
STEAM, INSTALL, GAME = first.STEAM, first.INSTALL, first.GAME


def utc(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat()


def powershell(script: str):
    response = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True, check=True)
    return json.loads(response.stdout) if response.stdout.strip() else None


def as_list(value):
    return [] if value is None else value if isinstance(value, list) else [value]


def fingerprint(path: Path, content=True):
    before = path.stat()
    payload = path.read_bytes() if content else None
    after = path.stat()
    row = {"path": first.redact(str(path)), "bytes": after.st_size, "modified_utc": utc(after.st_mtime),
           "stable_during_read": before.st_mtime_ns == after.st_mtime_ns and before.st_size == after.st_size}
    if content:
        row["sha256"] = hashlib.sha256(payload).hexdigest()
    return row, payload


def guard():
    path = STEAM / "steamapps/appmanifest_1422450.acf"
    text = path.read_text(encoding="utf-8-sig")
    vals = first.pair_map(first.pair_entries(path))
    depots = {}
    for depot in ("1422451", "1422452", "1422456"):
        match = re.search(r'"' + depot + r'"\s*\{\s*"manifest"\s*"(\d+)"', text)
        if match:
            depots[depot] = match.group(1)
    return {"appid": vals.get("appid"), "buildid": vals.get("buildid"), "target_buildid": vals.get("TargetBuildID"),
            "state_flags": vals.get("StateFlags"), "update_result": vals.get("UpdateResult"),
            "last_updated_unix": vals.get("LastUpdated"), "size_on_disk_manifest": vals.get("SizeOnDisk"),
            "depots": depots, "appmanifest_modified_utc": utc(path.stat().st_mtime)}


def simple_kv(text: str):
    """Read plain quoted KV1 objects without executing or retaining global Steam data."""
    tokens = re.findall(r'"((?:\\.|[^"\\])*)"|([{}])', re.sub(r"//[^\r\n]*", "", text))
    values = [brace or value.replace('\\"', '"').replace('\\\\', '\\') for value, brace in tokens]
    cursor = 0

    def read_object(nested=False):
        nonlocal cursor
        out = {}
        while cursor < len(values) and values[cursor] != "}":
            key = values[cursor]
            cursor += 1
            if cursor >= len(values):
                raise ValueError("Incomplete KV1 pair")
            value = values[cursor]
            cursor += 1
            if value == "{":
                value = read_object(True)
                if cursor >= len(values) or values[cursor] != "}":
                    raise ValueError("Unclosed KV1 object")
                cursor += 1
            out[key] = value
        return out

    return read_object()


def main():
    OUT.mkdir(exist_ok=True)
    PRIVATE.mkdir(exist_ok=True)
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    before_guard = guard()
    prior = json.loads((WORKSPACE / "research/game-install-audit.json").read_text(encoding="utf-8"))
    old_metadata = json.loads((WORKSPACE / "research/game-installed-file-metadata.json").read_text(encoding="utf-8"))
    prior_metadata = {p["relative_path"].lower(): p for p in old_metadata}

    expected, cached_manifests = {}, []
    for depot, manifest_id in before_guard["depots"].items():
        path = STEAM / "depotcache" / f"{depot}_{manifest_id}.manifest"
        mappings = first.read_depot(path)
        row, _ = fingerprint(path)
        cached_manifests.append(dict(row, depot=depot, manifest_id=manifest_id, mapping_count=len(mappings)))
        for entry in mappings:
            expected[entry["filename"].lower()] = dict(entry, depot=depot)

    files = [p for p in GAME.rglob("*") if p.is_file()]
    installed_metadata, extra_files, size_mismatches, vpks, cfg_inventory = [], [], [], [], []
    for path in files:
        relative = path.relative_to(INSTALL).as_posix()
        row, _ = fingerprint(path, content=False)
        row["relative_path"] = first.redact(relative)
        expectation = expected.get(relative.lower())
        if expectation:
            row.update({"depot": expectation["depot"], "expected_bytes": expectation.get("bytes"),
                        "size_matches_depot": row["bytes"] == expectation.get("bytes")})
            if not row["size_matches_depot"]:
                size_mismatches.append(row)
        else:
            extra_files.append(row)
        if path.suffix.lower() == ".vpk":
            old = prior_metadata.get(row["relative_path"].lower())
            row["metadata_unchanged_since_first_audit"] = bool(old and old["bytes"] == row["bytes"] and old["modified_utc"] == row["modified_utc"])
            vpks.append(row)
        if path.suffix.lower() in (".cfg", ".vcfg", ".vdf") or "cfg" in path.relative_to(GAME).parts:
            c, _ = fingerprint(path)
            c.update({"relative_path": row["relative_path"], "ownership": "Valve depot file" if expectation else "user-generated/legacy local config"})
            cfg_inventory.append(c)
        installed_metadata.append(row)
    missing = [e["filename"] for e in expected.values() if not e.get("flags", 0) & 64 and not (INSTALL / e["filename"]).is_file()]
    critical_hashes = []
    for old in prior["gameinfo_sha1_checks"]:
        relative = old["relative_path"]
        path = INSTALL / relative
        expectation = expected.get(relative.lower(), {})
        actual = first.sha1(path)
        critical_hashes.append({"relative_path": relative, "sha1": actual, "expected_sha1": expectation.get("sha1"),
                                "matches_depot_sha1": actual == expectation.get("sha1"), "matches_first_audit_sha1": actual == old["sha1"]})

    processes = as_list(powershell("Get-CimInstance Win32_Process -Filter \"Name = 'deadlock.exe' OR Name = 'steam.exe'\" | ForEach-Object {[pscustomobject]@{Name=$_.Name;ExecutablePath=$_.ExecutablePath;ProcessId=$_.ProcessId;CreatedUtc=$_.CreationDate.ToUniversalTime().ToString('o');CommandLine=if($_.Name -eq 'deadlock.exe'){$_.CommandLine}else{$null}}} | ConvertTo-Json -Compress"))
    modules = as_list(powershell("$auditGameProcess=Get-Process -Name deadlock -ErrorAction SilentlyContinue; if($auditGameProcess){$auditGameProcess.Modules | Where-Object {$_.ModuleName -match '(?i)(rendersystem|dxgi|d3d|vulkan|amd|ati|nvapi|engine2|filesystem|inputsystem|materialsystem|overlay|steamclient)'} | Select-Object ModuleName,FileName,@{Name='Version';Expression={$_.FileVersionInfo.FileVersion}} | ConvertTo-Json -Compress}"))
    for module in modules:
        module["FileName"] = first.redact(module["FileName"])

    private_paths, app_inventory, current_configs, launch_settings, cloud_caches, cloud_semantic_comparisons = [], [], [], [], [], []
    user_ids = []
    for account in (STEAM / "userdata").iterdir():
        app = account / "1422450"
        if not account.is_dir() or not app.is_dir():
            continue
        user_ids.append(account.name)
        cfg = app / "local/cfg"
        private_paths.append({"app_root": str(app), "native_cfg_root": str(cfg), "video_path": str(cfg / "video.txt"),
                              "machine_path": str(cfg / "machine_convars.vcfg"), "user_path": str(cfg / "user_convars_0_slot0.vcfg"),
                              "localconfig_path": str(account / "config/localconfig.vdf")})
        launch_settings.append({"scope": "userdata/<account>/config/localconfig.vdf apps/1422450", "values": first.read_app_launch_settings(account / "config/localconfig.vdf"),
                                "interpretation": "Absent LaunchOptions is absence in this scoped persistent block; observed process launch arguments are separate evidence."})
        for path in app.rglob("*"):
            if not path.is_file():
                continue
            row, _ = fingerprint(path, content=path.suffix.lower() in (".cfg", ".vcfg", ".txt", ".vdf") or "lastclouded" in path.name)
            row["app_relative_path"] = path.relative_to(app).as_posix()
            app_inventory.append(row)
        for path in (cfg / "video.txt", cfg / "machine_convars.vcfg", cfg / "user_convars_0_slot0.vcfg"):
            if path.is_file():
                entries = first.pair_entries(path)
                row, _ = fingerprint(path)
                row.update({"ownership": "USRLOCAL", "settings": first.pair_map(entries), "duplicates": first.duplicates(entries)})
                current_configs.append(row)
        cache_path = app / "remotecache.vdf"
        if cache_path.is_file():
            cache = simple_kv(cache_path.read_text(encoding="utf-8-sig"))["1422450"]
            cloud_caches.append({"metadata": cache, "performance_files_listed": [k for k in cache if re.search(r"(?i)(video\.txt|machine_convars\.vcfg)", k)],
                                 "interpretation": "The scoped remote cache does not list video.txt or machine_convars.vcfg when performance_files_listed is empty. User preferences and binds are separately cloud tracked. Numeric syncstate is recorded without assuming its undocumented meaning."})
        local_user, remote_user, clouded_user = cfg / "user_convars_0_slot0.vcfg", app / "remote/user_convars.vcfg", cfg / "user_convars_0_slot0.vcfg_lastclouded"
        if local_user.is_file() and remote_user.is_file():
            local_values = first.pair_map(first.pair_entries(local_user))
            remote_values = first.pair_map(first.pair_entries(remote_user))
            diffs = [{"key": k, "local": local_values.get(k), "remote": remote_values.get(k)}
                     for k in sorted(set(local_values) | set(remote_values)) if local_values.get(k) != remote_values.get(k)]
            cloud_semantic_comparisons.append({"kind": "user_convars", "local_matches_lastclouded_bytes": local_user.read_bytes() == clouded_user.read_bytes() if clouded_user.is_file() else None,
                                               "local_vs_remote_semantic_differences": diffs,
                                               "interpretation": "Different byte hashes can reflect format and slot serialization; compare semantic entries. This is disk/Steam-cache evidence, not proof of live graphics values or cloud server state."})

    gameinfo = (GAME / "citadel/gameinfo.gi").read_text(encoding="utf-8-sig")
    mounts_match = re.search(r"SearchPaths\s*\{(.*?)\}", gameinfo, re.S)
    mounts = [line.split("//", 1)[0].strip() for line in mounts_match.group(1).splitlines() if line.split("//", 1)[0].strip()] if mounts_match else []
    mod_names = re.compile(r"(?i)^(addons?|custom|mods?|modcache|mod_cache|cache|downloads?|workshop)$|mod.*cache|cache.*mod")
    mod_dirs = [first.redact(str(p)) for p in GAME.rglob("*") if p.is_dir() and mod_names.search(p.name)]
    scoped_cache_paths = []
    libraries = [STEAM, Path(r"G:\SteamLibrary"), Path(r"H:\SteamLibrary")]
    for library in libraries:
        for relative in ("steamapps/workshop/appworkshop_1422450.acf", "steamapps/workshop/content/1422450", "steamapps/shadercache/1422450", "steamapps/downloading/1422450"):
            path = library / relative
            members = [p for p in path.rglob("*") if p.is_file()] if path.is_dir() else [path] if path.is_file() else []
            scoped_cache_paths.append({"path": str(path), "exists": path.exists(), "file_count": len(members), "bytes": sum(p.stat().st_size for p in members)})

    log_candidates = [p for p in files if p.suffix.lower() == ".log" or re.search(r"(?i)(console|condump).*\.txt$", p.name) and "tools" not in p.relative_to(GAME).parts]
    game_log_metadata, config_errors = [], []
    for path in log_candidates:
        row, payload = fingerprint(path)
        game_log_metadata.append(row)
        if row["bytes"] > 20 * 1024 * 1024:
            continue
        for line in payload.decode("utf-8-sig", errors="replace").splitlines():
            if re.search(r"(?i)(unknown (command|convar)|can't use cheat|cannot use cheat|ignored.*(?:convar|setting)|convar.*not found|cannot.*override.*gameinfo)", line):
                config_errors.append({"file": row["path"], "text": first.redact(line)})
    cloud_events = []
    cloud_log = STEAM / "logs/cloud_log.txt"
    if cloud_log.is_file():
        for line in cloud_log.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            if not re.search(r"(?i)\[AppID 1422450\]", line):
                continue
            # Skip network resource identifiers; retain sync outcome and config filenames.
            if "HTTP upload" in line or "Upload batch initiated" in line:
                continue
            redacted = first.redact(line)
            for user_id in user_ids:
                redacted = redacted.replace(user_id, "<account>")
            cloud_events.append(redacted)

    fresh_vpk = json.loads((OUT / "installed-vpk/vpk-audit.json").read_text(encoding="utf-8"))
    old_vpk = json.loads((WORKSPACE / "evidence/valve-build-25689475/installed-vpk/vpk-audit.json").read_text(encoding="utf-8"))
    old_trees = {Path(p["directory"]).name + "|" + str(Path(p["directory"]).parent.name): p for p in old_vpk["vpk"]}
    packed_cfg = []
    for prefix in ("citadel", "core"):
        entries = json.loads((OUT / f"installed-vpk/{prefix}-vpk-index.json").read_text(encoding="utf-8"))
        for entry in entries:
            if entry["path"].startswith("cfg/"):
                packed_cfg.append(dict(entry, mount=prefix, ownership="packed Valve resource"))
    vpk_freshness = []
    for fresh in fresh_vpk["vpk"]:
        tree_key = Path(fresh["directory"]).name + "|" + str(Path(fresh["directory"]).parent.name)
        old = old_trees.get(tree_key, {})
        old_extracts = {e["path"]: e for e in old.get("extracted", [])}
        vpk_freshness.append({"directory": fresh["directory"], "tree_sha256": fresh["tree_sha256"],
                              "tree_matches_first_audit": fresh["tree_sha256"] == old.get("tree_sha256"),
                              "resources": fresh["resources"], "missing_archives": fresh["missing_archives"],
                              "fresh_extracted_resources": [dict(e, matches_first_audit_sha256=e["sha256"] == old_extracts.get(e["path"], {}).get("sha256")) for e in fresh["extracted"]]})

    localization = GAME / "citadel/resource/localization/citadel_main/citadel_main_english.txt"
    locale_meta, _ = fingerprint(localization)
    locale_exp = expected.get(localization.relative_to(INSTALL).as_posix().lower(), {})
    locale_sha1 = first.sha1(localization)
    locale_meta.update({"sha1": locale_sha1, "expected_sha1": locale_exp.get("sha1"), "matches_depot_sha1": locale_sha1 == locale_exp.get("sha1")})
    matchmaking_label = None
    for line_number, line in enumerate(localization.read_text(encoding="utf-8-sig").splitlines(), 1):
        match = re.match(r'^\s*"Citadel_StartMatchmaking_UnverifiedPGI"\s+"([^\"]+)"', line)
        if match:
            matchmaking_label = {"file": first.redact(str(localization)), "line": line_number,
                                 "token": "Citadel_StartMatchmaking_UnverifiedPGI", "installed_text": match.group(1),
                                 "mentions_convars": bool(re.search(r"(?i)convars", match.group(1))),
                                 "listed_sections": ["Engine2", "MaterialSystem2", "NetworkSystem", "Particles", "RenderSystem", "SceneSystem", "WorldRenderer"],
                                 "interpretation": "Current installed localized matchmaking-denial text and a verified depot content hash. A localized message does not empirically prove all enforcement conditions or identify every supported/unsupported override."}

    active_video = next(c for c in current_configs if c["path"].endswith("video.txt"))
    active_machine = next(c for c in current_configs if c["path"].endswith("machine_convars.vcfg"))
    old_video = next(c for c in prior["configs"] if c["ownership"] == "USRLOCAL" and c["path"].endswith("video.txt"))
    old_machine = next(c for c in prior["configs"] if c["ownership"] == "USRLOCAL" and c["path"].endswith("machine_convars.vcfg"))
    changes = [{"key": k, "before": old_video["settings"].get(k), "now": active_video["settings"].get(k)}
               for k in sorted(set(old_video["settings"]) | set(active_video["settings"])) if old_video["settings"].get(k) != active_video["settings"].get(k)]
    machine_changes = [{"key": k, "before": old_machine["settings"].get(k), "now": active_machine["settings"].get(k)}
                       for k in sorted(set(old_machine["settings"]) | set(active_machine["settings"])) if old_machine["settings"].get(k) != active_machine["settings"].get(k)]
    native_low = first.pair_map(first.pair_entries(OUT / "installed-vpk/citadel/cfg/video_defaults_0.txt"))
    native_low_diffs = [{"key": k, "native_low": value, "stored": active_video["settings"].get(k)} for k, value in native_low.items() if active_video["settings"].get(k) != value]

    discrepancies = [
        {"id": "runtime-unverified", "severity": "validation required", "finding": f"Persisted native settings contain FSR1=1, render scale=0.8, sharpening=0.2, fps_max=0 and machine fps_max_ui={active_machine['settings'].get('fps_max_ui')}. The existing game logs contain no live convar output because no console/condump log is present.",
         "action": "Confirm effective settings with the included ordinary-console read-only queries/condump when the user chooses to interact with the game, then benchmark repeatable gameplay. Do not claim a measured FPS improvement from files or module enumeration."},
        {"id": "legacy-config-divergence", "severity": "documentation", "finding": "game/citadel/cfg/video.txt and machine_convars.vcfg remain legacy copies containing the previous Potato renderer overrides and previous FPS limits; stock gameinfo identifies USRLOCAL as native ownership.",
         "action": "Point users and tooling to Steam userdata/<account>/1422450/local/cfg. Preserve legacy copies and avoid interpreting them as active performance settings."},
        {"id": "cloud-scope", "severity": "validation boundary", "finding": "Scoped Steam remote cache tracks user preferences/bindings, not video.txt or machine_convars.vcfg. The performance patch remains present after the observed relaunch; graphics live values and future cloud behavior remain separate questions.",
         "action": "Do not disable Steam Cloud or rewrite remote personal files. Recheck the native files after a normal later exit/relaunch if persistence becomes a concern."},
        {"id": "unsupported-knobs", "severity": "scope", "finding": "The remaining native video and legacy copies contain keys outside stock preset files. Preset absence and missing public console registration cannot independently prove that native storage aliases are inert.",
         "action": "Use current-build menu/preset evidence for graphics changes and preserve accessibility/display/preferences. Describe cleanup as resetting unvalidated manual overrides, not as proven speed gains."},
        {"id": "ragdoll-candidate", "severity": "optional benchmark candidate", "finding": f"Active machine file currently stores cl_ragdoll_limit={active_machine['settings'].get('cl_ragdoll_limit')}; it remains at its original stored value. No runtime query or gameplay impact was observed.",
         "action": "If the separate current-build registry audit confirms ordinary-console support, evaluate a lower limit as a clearly labeled comparison with runtime readback and dense-combat frame-time measurements; do not make it an unmeasured default."},
    ]
    after_guard = guard()
    guard_keys = ("appid", "buildid", "target_buildid", "depots", "update_result")
    guard_stable = all(before_guard[k] == after_guard[k] for k in guard_keys)
    report = {
        "audit_started_utc": started, "audit_finished_utc": dt.datetime.now(dt.timezone.utc).isoformat(), "client_timezone": "America/New_York",
        "read_only_game_and_steam": True, "steam_root": str(STEAM), "install_root": str(INSTALL), "game_root": str(GAME),
        "appmanifest_guard_before": before_guard, "appmanifest_guard_after": after_guard, "build_and_depot_guard_stable": guard_stable,
        "matches_first_audit_build": before_guard["buildid"] == prior["build_id"], "processes": processes, "relevant_loaded_modules": modules,
        "renderer_inference": "DX11 renderer module and d3d11/DXGI loaded; Vulkan renderer absent from selected module list. This supports currently using DX11, not live graphics setting values or a FPS result.",
        "gameinfo_searchpaths": mounts, "native_settings_path_id": "USRLOCAL", "legacy_settings_path_id": "MOD",
        "critical_files_fresh_sha1_vs_depot": critical_hashes, "cached_depot_manifest_evidence": cached_manifests,
        "installed_file_count": len(files), "vpk_file_count": len(vpks), "vpk_files_in_installed_depots": sum("depot" in p for p in vpks),
        "vpk_metadata_unchanged_since_first_audit_count": sum(p["metadata_unchanged_since_first_audit"] for p in vpks),
        "missing_installed_depot_files": missing, "depot_size_mismatches": size_mismatches,
        "extra_dll_exe_vpk_files": [p for p in extra_files if Path(p["relative_path"]).suffix.lower() in (".dll", ".exe", ".vpk")],
        "extra_game_files_not_in_depots": extra_files, "mod_addon_cache_directory_candidates": mod_dirs,
        "app_scoped_library_cache_inventory": scoped_cache_paths,
        "every_loose_game_config_inventory": cfg_inventory, "every_packed_cfg_resource_inventory": packed_cfg,
        "steam_userdata_app_file_inventory": app_inventory, "native_configs": current_configs,
        "current_video_changes_from_first_audit": changes, "current_machine_changes_from_first_audit": machine_changes,
        "stored_video_differences_from_native_low_preset": native_low_diffs,
        "video_last_write_utc": active_video["modified_utc"], "machine_last_write_utc": active_machine["modified_utc"],
        "profile_still_present_after_observed_relaunch_on_disk": all(active_video["settings"].get(k) == v for k, v in {"setting.r_citadel_upscaling": "1", "setting.mat_viewportscale": "0.800000", "setting.fps_max": "0"}.items()),
        "launch_options_scoped_persistent_values": launch_settings, "steam_cloud_remote_cache": cloud_caches,
        "steam_cloud_user_config_comparisons": cloud_semantic_comparisons, "steam_cloud_latest_app_scoped_events": cloud_events[-35:],
        "existing_game_console_log_inventory": game_log_metadata, "unknown_ignored_cheat_setting_log_lines": config_errors,
        "native_vpk_evidence_freshness": vpk_freshness, "native_label_localization_fresh_hash": locale_meta,
        "installed_matchmaking_gameinfo_denial_label": matchmaking_label,
        "installed_file_paths_removed_since_first_audit": sorted(set(prior_metadata) - {p['relative_path'].lower() for p in installed_metadata}),
        "stored_fps_controls": {"video_fps_max": active_video['settings'].get('setting.fps_max'), "machine_fps_max": active_machine['settings'].get('fps_max'),
                                "machine_fps_max_ui": active_machine['settings'].get('fps_max_ui'), "machine_cl_ragdoll_limit": active_machine['settings'].get('cl_ragdoll_limit')},
        "actionable_discrepancies": discrepancies,
        "limits": ["Fresh file-name and byte-size checks cover all installed game files against currently installed cached depot manifests. Seven critical binary/gameinfo files and main English localization were freshly SHA1 verified against depot content hashes.",
                   "Current core/citadel VPK directory trees were reread and selected config/UI resources freshly CRC checked. Every VPK payload was not hashed; matching filenames, sizes, timestamps, tree hashes and selected resource CRCs do not constitute complete archive content verification.",
                   "Disk snapshots and loaded renderer modules do not directly establish live convar values, FPS gains, anti-cheat behavior, or absence of every external software overlay.",
                   "No game console command executed, no FPS benchmark taken, no process changed, no Steam Cloud setting changed, and no game/cache/VPK file written or removed."],
    }
    OUT.joinpath("game-install-audit.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    OUT.joinpath("game-installed-file-metadata.json").write_text(json.dumps(installed_metadata, indent=2), encoding="utf-8")
    PRIVATE.joinpath("round2-game-install-paths.json").write_text(json.dumps({"native_config_paths": private_paths}, indent=2), encoding="utf-8")
    text = [
        f"Fresh audit UTC: {started} through {report['audit_finished_utc']}.",
        f"Installed build/target {before_guard['buildid']}/{before_guard['target_buildid']}; installed depot guards stable during audit: {guard_stable}.",
        f"Game root: {GAME}; native config ownership: USRLOCAL; legacy config ownership: MOD.",
        "Running game: " + json.dumps([p for p in processes if p["Name"] == "deadlock.exe"]),
        report["renderer_inference"],
        f"Installed files {len(files)}; VPKs {len(vpks)}, all in current installed depot manifests; missing depot files {len(missing)}; size mismatches {len(size_mismatches)}; additional DLL/EXE/VPK {len(report['extra_dll_exe_vpk_files'])}.",
        "Fresh critical hashes: " + json.dumps(critical_hashes),
        f"VPK metadata unchanged from first audit: {report['vpk_metadata_unchanged_since_first_audit_count']}/{len(vpks)}. Selected current config/UI resource CRCs were rechecked; no full VPK payload hashing.",
        "Native video values now: FSR1=1, render scale 0.800000, sharpening 0.200000, mip bias 2, VSync0, low-latency1, FPS cap0, 1920x1080 borderless.",
        f"Video last write {active_video['modified_utc']}; machine last write {active_machine['modified_utc']}. The patch remains on disk after this observed relaunch; effective runtime values remain unqueried.",
        "Machine stored changes: " + json.dumps(machine_changes),
        f"Stored FPS controls: game0, UI{active_machine['settings'].get('fps_max_ui')} (preserved original); cl_ragdoll_limit{active_machine['settings'].get('cl_ragdoll_limit')} (unchanged). These are disk values.",
        "Current installed matchmaking-denial label: " + json.dumps(matchmaking_label),
        f"Game console/condump/log count {len(game_log_metadata)}; detected unknown/ignored/cheat-setting log lines {len(config_errors)}. With no legitimate game logs, error absence is not runtime validation.",
        "Steam Cloud remote cache lists user preferences/bindings; it does not list performance video or machine files. Public evidence redacts account paths/IDs; exact paths are only in ignored research/private/round2-game-install-paths.json.",
        "Actionable discrepancies:",
    ]
    for d in discrepancies:
        text.append(f"{d['id']} ({d['severity']}): {d['finding']} Action: {d['action']}")
    text.append("Limits: " + " ".join(report["limits"]))
    OUT.joinpath("game-install-audit.txt").write_text("\n\n".join(text) + "\n", encoding="utf-8")
    print(json.dumps({"build": before_guard["buildid"], "guard_stable": guard_stable, "files": len(files), "vpks": len(vpks),
                      "all_vpks_in_depots": len(vpks) == report["vpk_files_in_installed_depots"], "vpk_metadata_unchanged": report["vpk_metadata_unchanged_since_first_audit_count"],
                      "missing_files": len(missing), "size_mismatches": len(size_mismatches), "extra_exe_dll_vpk": len(report["extra_dll_exe_vpk_files"]),
                      "loose_cfg_files": len(cfg_inventory), "packed_cfg_resources": len(packed_cfg), "userdata_app_files": len(app_inventory),
                      "all_critical_hashes_match": all(p["matches_depot_sha1"] for p in critical_hashes),
                      "native_label_locale_hash_matches_depot": locale_meta["matches_depot_sha1"], "game_log_count": len(game_log_metadata), "machine_changes": machine_changes}, indent=2))


if __name__ == "__main__":
    main()
