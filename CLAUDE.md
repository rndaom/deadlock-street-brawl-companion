# Deadlock Street Brawl Companion

A Windows companion for Deadlock's Street Brawl mode (Electron + Vite + TypeScript, with a .NET `native/ScreenReader`). See `README.md` and `NOTES.md`.

## Cleanup

- **Disposable build output (all gitignored):** `node_modules/` (~615 MB), `dist/`, `dist-electron/`, `native/ScreenReader/bin`, `obj` and `publish`, `artifacts/local-*.json`, `coverage/`, and `release/` except what is listed below. Rebuild with `npm ci`, the build scripts and `dotnet build`.
- **Keep `release/win-unpacked`:** `Start Companion.cmd` launches it. Remove the old release zips (`release/*.zip`, ~220 MB) and `release/next` once a newer package is verified. Stop the companion before you rebuild or delete anything under `release/`.
- **Diagnostics are written outside the repo:** the app writes frames, JSON and `reader-log.jsonl` to `Documents\Street Brawl Companion\diagnostics` (from `electron/main.ts`). It is app output, not source. Clear it after a test session, and don't copy it into the repo.
- **Local evidence (gitignored, treat as precious):** `evidence/`, `research/` (including `research/private`), `optimization/local`, `optimization/captures`, `optimization/backups`, and `data/` hold captures and profiles that are slow to recreate. Don't delete them as cleanup.
- **No remote, many uncommitted changes:** this repo has one commit and a large dirty tree, so the working tree is the only copy. Don't reset, checkout, clean or stash. Ask the owner before any git operation that could drop changes, and push or back it up first when asked.
- **Temp files:** screenshots, scratch scripts and test captures go in the session scratchpad. A new generated path gets a `.gitignore` entry in the same change. Stop the Vite and Electron processes you started.
- **Log what you leave:** the local, git-excluded `CLEANUP.md` at the repo root tracks leftovers and pending items. Read it when you start and offer to clear items that are due.
