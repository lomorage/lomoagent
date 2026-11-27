# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What This Is

A Tauri v2 desktop app that wraps [lomo-backend](https://github.com/lomoware/lomo-backend) (`lomod.exe`) with the Immich web frontend. Three moving parts run together:

1. **Tauri (Rust)** — `src-tauri/src/main.rs` — launches lomod and proxy as child processes, exposes IPC commands, manages `config.json`
2. **Proxy (Node.js/Express)** — `proxy/` — translates Immich HTTP API calls into lomo-backend API calls; bundles the Immich SPA; runs on port 3001
3. **Immich web frontend (SvelteKit)** — `submodules/immich/web/` — the photo viewer UI; built to a static SPA and zipped into `src-tauri/resources/web.zip`

At runtime, `tauri.conf.json` points `frontendDist` at `http://localhost:3001` (the proxy). The Tauri WebView loads from the proxy, which serves the Immich SPA and intercepts all `/api/*` calls.

## Build

### Full build (Windows)
```powershell
.\build-tauri.ps1              # web + proxy + tauri (release)
.\build-tauri.ps1 -SkipWeb     # skip Immich frontend rebuild
.\build-tauri.ps1 -SkipProxy   # skip proxy rebuild
.\build-tauri.ps1 -DevBuild    # debug build (no installer)
```

Build steps in order:
1. `pnpm build` in `submodules/immich/web/` → zipped to `src-tauri/resources/web.zip`
2. `esbuild` bundles `proxy/server.ts` → `pkg` packages to `proxy/dist/proxy.exe` → copied to `src-tauri/resources/proxy.exe`
3. Sharp native modules zipped to `src-tauri/resources/sharp.zip` (preserves directory structure — Tauri flattens resources otherwise)
4. `cargo tauri build` (or `--debug`)

**Prerequisite**: `src-tauri/resources/lomod/lomod.exe` must exist (extract from `lomoagent.msi`).

### Dev iteration (quick)

After changing proxy TypeScript:
```bash
cd proxy
npx esbuild server.ts --bundle --platform=node --target=node20 --outfile=dist/server.cjs --external:sharp
npx pkg dist/server.cjs --targets node22-win-x64 --output dist/proxy.exe
cp dist/proxy.exe ../src-tauri/target/debug/proxy.exe
```

After changing Rust:
```bash
cd src-tauri && cargo build
```

After changing Immich web source:
```bash
cd submodules/immich/web && pnpm build
# Then repackage web.zip:
cd build && powershell -Command "Compress-Archive -Path * -DestinationPath '../../../src-tauri/target/debug/web.zip' -Force"
# Delete extracted web dir so Tauri re-extracts:
rm -rf "C:/Users/$USER/AppData/Roaming/com.lomoware.photoviewer/web"
```

Run the built binary directly (bypasses `cargo tauri dev`'s dev-server wait):
```bash
./src-tauri/target/debug/lomo-photo-viewer.exe
```

### Immich web dev (frontend only)
```bash
cd submodules/immich/web
pnpm install --force
pnpm run build          # production build
pnpm run check:code     # eslint + prettier
pnpm run check:all      # lint + typecheck + tests
pnpm test               # vitest
```

## Architecture Details

### Proxy API translation
The proxy in `proxy/routes/` maps Immich REST API → lomo-backend API:
- **auth.ts** — `/api/auth/login` → `POST /login` on lomo (Basic Auth with Argon2-hashed password)
- **assets.ts** — thumbnails, metadata, HEIC decoding via `heic-convert` + `sharp`
- **timeline.ts** — merkletree-based date buckets; exports `clearAlbumBucketCache()`
- **albums.ts** — album CRUD
- **stubs.ts** — returns stub responses for Immich API endpoints lomo doesn't support; also hosts the settings page HTML and `GET/PUT /api/lomo/settings`

`/admin/*` routes and `/lomo-settings` are served by `settingsRouter` (defined in `stubs.ts`, mounted at root in `server.ts`).

### Session management
`proxy/session.ts` stores a `Map<sessionId, Session>` in memory. Each session holds the lomo `token`, `userId`, `username`, and `serverUrl`. The cookie `lomo_session` carries the session ID; the proxy reads it on every request to authenticate calls to lomo-backend.

### Tauri IPC commands
Three commands registered via `invoke_handler`:
- `get_app_settings` — returns `{ photos_dir }` from `config.json`
- `pick_folder` — opens native folder dialog via `rfd`
- `save_app_settings(photos_dir)` — writes `config.json`, kills lomod, starts new lomod with updated `mount-dir`

`withGlobalTauri: true` in `tauri.conf.json` + `remote.urls` in `capabilities/default.json` enable `window.__TAURI__` in the proxy-served pages.

### One lomod, one database (Lomoagent on the same computer)
When Lomoagent (the Windows tray app, `%LOCALAPPDATA%\Lomoware\Lomoagent\lomoagent.exe`) is installed, it runs lomod on port 8000 with `--base %LOCALAPPDATA%\lomoware\`, and the phones back up to it. In local mode the viewer then uses **that** lomod and **that** database (`src-tauri/src/lomoagent.rs`, `agent_backend()` in `main.rs`): it never starts a lomod of its own, never kills Lomoagent's (only a lomod it started itself, by `lomod.pid`), never copies the database for itself (adopting Lomoagent's library or one of its copies in a user's folder, recognised by `conf.uuid`, just uses the running backend), and leaves creating libraries and changing the photo folder to Lomoagent. Two lomods on two copies of one database hand out the same asset ids twice and make phones upload photos again. Without Lomoagent the viewer runs its bundled lomod on its own database as before, and never while another lomod answers on port 8000.

### Config persistence
`C:\Users\<user>\AppData\Roaming\com.lomoware.photoviewer\config.json`:
```json
{ "photos_dir": "C:\\path\\to\\photos" }
```
If absent, defaults to `<AppData>/com.lomoware.photoviewer/photos`.

### lomo-backend asset identity
Lomo identifies assets by **filename** (e.g. `IMG_1234.jpg`), not UUID. The proxy uses filenames as asset IDs throughout. `isFavorite` status comes from `Status & 8` in the merkletree day response. Favorites are set via `POST /assets/favorite` and removed via `DELETE /assets/favorite`.

### HEIC thumbnails
Sharp's Windows prebuilt lacks the HEVC decoder. HEIC/HEIF files are decoded via `heic-convert` (pure JS) to JPEG first, then resized by sharp. See `sharpFallbackThumbnail()` in `proxy/routes/assets.ts`.

### Resource extraction at runtime
Tauri extracts `web.zip` and `sharp.zip` to `<AppData>/com.lomoware.photoviewer/` on first launch (or when the zip is newer than the extracted marker). The proxy reads `WEB_DIR`, `LOMO_BACKEND_URL`, `NODE_PATH`, and `CONFIG_PATH` env vars set by Tauri.
