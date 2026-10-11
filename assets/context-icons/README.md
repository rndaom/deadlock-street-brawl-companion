# Offline context templates

This directory contains 278 static recognition templates for client 6745, source revision 11078118: three public portrait variants for each of the 39 supported heroes, 156 signature ability icons, and five HUD glyphs. `manifest.json` pins each file's byte count, dimensions, SHA256, source mapping, and catalogue versions.

Portrait roles are `hero-card`, `hero-small`, and `hero-vertical`; ability slots are zero based (0–3). Portraits and ability PNGs come from the public Deadlock API asset mirror. Its CDN URLs are not client versioned, so the local hashes pin the retrieved images without independently authenticating them as Valve build files.

The `hud-glyph` templates come from the installed Valve static resources with matching client/revision metadata, VPK directory CRC32, resource SHA256, and cached decoder provenance:

| ID | Canvas | Resource |
| --- | --- | --- |
| ability-upgrade-check | 64×64 | ability_upgrade_check_psd.vtex_c |
| ability-pip | 32×32 | hero_ability_pip_psd.vtex_c |
| ability-pip-empty | 32×32 | hero_ability_pip_empty_psd.vtex_c |
| ap-icon | 51×51 | ap_icon.vsvg_c |
| spectator-icon | 24×24 | spec_icon_png.vtex_c |

`valve-resource:` references in the manifest are provenance labels, not download locations. The AP icon is rasterized from its exact decoded single-path SVG using the checked-in Windows WPF conversion script. This cache contains no screenshots, user names, match identifiers, or personal telemetry.

Default verification is offline:

```powershell
node scripts/sync-context-catalog.mjs --verify
node scripts/sync-context-icons.mjs --verify
node scripts/sync-context-glyphs.mjs --verify
```

`sync-context-catalog --rebuild` deterministically regenerates mechanics and lightweight renderer ability labels from the cached sources. `sync-context-icons --refresh` is an explicit build-time repair operation; at most 400 approved public HTTPS requests are allowed, with four concurrent workers and bounded file/total sizes. Existing verified images are reused and static glyphs are copied from cached exports. Gameplay never invokes either operation.

For a matching installed client, explicit static re-extraction needs a VPK index and Source2Viewer CLI:

```powershell
node scripts/sync-context-glyphs.mjs --extract --game-root '<citadel directory>' --decoder '<Source2Viewer-CLI.exe>' --index '<citadel-vpk-index.json>'
```

Static templates and ability definitions do not prove player identity, ownership, unlocks, ability ranks, affordability, or current combat statistics. Recognition must keep missing or ambiguous observations unknown. Valve owns the game assets; this local cache makes no claim about redistribution rights.
