# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

**Prerequisite**: `src-tauri/resources/lomod/lomod.exe` must exist. Either build it from `submodules/lomod` with `.\build-tauri.ps1 -BuildLomod` (runs `scripts/build-lomod-windows.ps1`; needs `go` and a mingw-w64 **UCRT** toolchain on PATH, e.g. MSYS2 UCRT64 — see the script header), or extract it from `lomoagent.msi`.

### CI
`.github/workflows/build-windows.yml` builds everything (lomod included) on `windows-latest`, and uploads the NSIS installer as a workflow artifact (MSI is skipped in CI: WiX's `light.exe` fails on the hosted runner; `.\build-tauri.ps1 -Bundles nsis` does the same locally). It then installs that package on the runner, starts the app and runs `scripts/ci/smoke-test.mjs` (web UI, create admin, login, upload, timeline, thumbnail, preview); the same script runs against any lomod + proxy pair via `PROXY_URL` / `LOMOD_URL` / `ADMIN_HOME`. **Both CI workflows (this one and the Docker one) run only on pushes to `release/**` branches (creating one included) and on manual runs** — not on `main`, other branches, PRs or tag pushes. A manual run (`workflow_dispatch`) with input `release_tag` also publishes a release, tagging the commit it built: `vX.Y.Z` matching `version` in `src-tauri/tauri.conf.json` makes a **draft** GitHub Release with the installer and `install.ps1` (publish it manually); `vX.Y.Z-<suffix>` (e.g. `v1.0.21-test.1`) publishes a pre-release, which `install.ps1` (latest release) never installs unless given `-Tag`.

### macOS (Apple Silicon)
`./build-tauri.sh --build-lomod --bundles app,dmg` on an Apple Silicon Mac (it builds for the host architecture). `--build-lomod` runs `scripts/build-lomod-macos.sh`: builds lomod from `submodules/lomod` (with `-checklinkname=0`: lomod's vendored x/net linknames into `syscall`) and bundles libvips, ffmpeg/ffprobe and exiftool from Homebrew via lomod's `scripts/macos/collect-deps.sh` (needs `brew install vips pkgconf ffmpeg exiftool dylibbundler`), then fails if anything still links into Homebrew and starts lomod once. On macOS the bundled executables are `proxy` and `lomod/lomod` (`PROXY_EXE`/`LOMOD_EXE` in `main.rs`); the per-platform proxy resource and bundle targets are in `src-tauri/tauri.windows.conf.json` / `tauri.macos.conf.json`, which Tauri merges over `tauri.conf.json`. The app is ad-hoc signed (no Developer ID / notarization), so a downloaded copy needs `xattr -dr com.apple.quarantine /Applications/lomorage.app`. `.github/workflows/build-macos.yml` builds on `macos-14` (the bundled Homebrew dylibs need the runner's macOS or later, so that is the app's minimum; the build fails if any bundled binary needs newer than the matrix's `min_macos`), installs the `.dmg` and runs `scripts/ci/smoke-test.mjs`; a manual run with `release_tag` `macos-vX.Y.Z[-pre]` publishes a (pre-)release with the `.dmg`, never marked latest (the Docker workflow does the same; `install.ps1` uses releases/latest). **Intel** builds the same way (`macos-15-intel`), but lomod crashes at startup on darwin/amd64 until `submodules/lomod` vendors golang.org/x/sys a76c4d0 or later.

### Docker (Linux server)
`docker/Dockerfile` (build from the repo root: `docker build -f docker/Dockerfile .`) packages lomod (built from `submodules/lomod` on Ubuntu 24.04 + libvips, with exiftool and ffmpeg from apt), the Immich web build and the proxy (Node, esbuild bundle) into one image; `docker/entrypoint.sh` runs lomod (`/data/lomod` base, `/photos` mount dir) and the proxy (port 3001, `WEB_DIR=/app/web`, `CONFIG_PATH=/data/proxy/config.json`), and the first account (`LOMO_ADMIN_USER`, default `admin`) is set up in the browser: with `LOMO_WEB_SETUP=1` (entrypoint only) `proxy/web-setup.ts` redirects page loads to `/lomo-setup` until lomod has an account (lomod's `/welcome` answers 200 only then) and `POST /api/lomo/setup` creates it via lomod `POST /user`; `docker/create-admin.mjs` creates it on first start instead when `LOMO_ADMIN_PASSWORD` is set. In the browser the web app sends `X-Lomo-Server: http://<page host>:8000`; the entrypoint sets `LOMO_PIN_BACKEND=1` so the proxy ignores it and always uses the bundled lomod (`LOMO_BACKEND_URL`), which may be on another port (`LOMOD_PORT`). Host networking in `docker/docker-compose.yml` is for mDNS discovery by the mobile app and real LAN IPs in the addresses/QR codes the app shows. `docker/install.sh` is the curl-pipe installer (writes `~/lomo/{docker-compose.yml,.env}`, moves a default port that is taken to a free one). User docs: `docker/README.md` (Chinese). `.github/workflows/docker.yml` builds, runs `scripts/ci/docker-smoke.sh`, then pushes `ghcr.io/<owner>/lomo-photo-viewer`; a manual run with `release_tag` `docker-vX.Y.Z[-pre]` publishes a (pre-)release. The credential derivation shared by the smoke test and first-start setup is `scripts/lib/lomo-credential.mjs`.

`submodules/immich` (fork `lomolomo2/immich`) and `submodules/lomod` (`lomorage/lomod`, the lomo-backend server source) are git submodules tracking `main`; after cloning run `git submodule update --init submodules/immich submodules/lomod` (`git submodule update --remote <path>` pulls the latest `main`). After pushing changes in either, commit the updated submodule pointer here so each release records the commits it was built from.

### Dev iteration (quick)

After changing proxy TypeScript:
```bash
cd proxy
npx esbuild server.ts --bundle --platform=node --target=node20 --outfile=dist/server.cjs --external:sharp
npx pkg --public --no-bytecode dist/server.cjs --targets node22-win-x64 --output dist/proxy.exe
cp dist/proxy.exe ../src-tauri/target/debug/proxy.exe
```

After changing Rust:
```bash
cd src-tauri && cargo build
```

After changing Immich web source (ALL THREE steps are MANDATORY — skipping any one causes stale UI):
```bash
# 1. Clean build (rm -rf prevents stale .svelte-kit cache)
cd submodules/immich/web && rm -rf build .svelte-kit && pnpm build
# 2. Repackage web.zip into BOTH debug dir and resources
cd build && powershell -Command "Compress-Archive -Path * -DestinationPath '../../../../src-tauri/target/debug/web.zip' -Force"
cp ../../../../src-tauri/target/debug/web.zip ../../../../src-tauri/resources/web.zip
# 3. Delete extracted web dir so Tauri re-extracts on next launch
rm -rf "C:/Users/$USER/AppData/Roaming/com.lomoware.photoviewer/web"
```
**CRITICAL**: If step 3 is skipped, the app will use the OLD extracted files and your changes will NOT appear. Always verify by checking Tauri output for "Extracting web.zip" on next launch.

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

## Development Rules

### Local vs Remote: every change must support both modes

This project supports two deployment modes:
1. **Local mode** — Tauri desktop app launches `lomod.exe` as a child process; proxy talks to `localhost:8000`
2. **Remote mode** — proxy connects to a remote lomo-backend server specified by the user at login

**Every proxy/backend modification MUST work in both modes.** Follow these guidelines:

**Pre-edit checklist** — run through this before any edit to `proxy/**` or `src-tauri/**`:

- [ ] Does this code build a backend URL? If yes, does it use `session.serverUrl` (never hardcoded `localhost`)?
- [ ] Does this read/write files? If yes, is the path a proxy-owned resource (`WEB_DIR`, `sharp`, `web.zip`, `config.json`) — NOT user photos?
- [ ] Does this call a Tauri IPC command? If yes, is it guarded by `hasTauri` / `window.__TAURI__` / `getTauriInvoke()`?
- [ ] Have I traced both paths: (a) local Tauri+lomod, (b) remote user-URL — and confirmed both work?

A harness-level pre/post-edit hook (`scripts/hooks/dual-mode-check.js`, registered in `.claude/settings.json`) also emits warnings for common violations. The hook is warn-only — it does not block edits; treat any warning it prints as a signal to re-check the code path.

- **Never hardcode `localhost` or assume lomod is local.** Always use `session.serverUrl` (from `getLomoToken()`) to build backend URLs. The `DEFAULT_LOMO_URL` in `session.ts` is only a fallback for session creation.
- **Isolate mode-specific code.** If behavior differs between local and remote (e.g., file-system access, process management, path resolution), use a clear abstraction or strategy pattern — not scattered `if/else` checks. Put local-only logic behind an interface so remote mode never touches it.
- **Tauri IPC is local-only.** Commands like `pick_folder`, `save_app_settings`, and process management (`kill lomod`, `start lomod`) only apply in local/Tauri mode. The proxy layer must not depend on Tauri IPC being available. Guard Tauri-dependent code paths and provide graceful fallbacks for remote/web-only usage.
- **No local filesystem assumptions in proxy routes.** Proxy routes must fetch assets over HTTP from `serverUrl`, never read from local disk paths. The only local file access allowed is for extracted resources (`WEB_DIR`, `sharp`, `web.zip`).
- **Test both paths mentally.** Before submitting a change, trace the code path for: (a) local Tauri desktop with lomod on localhost, and (b) remote server URL entered at login. If either path breaks, fix it before merging.

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
