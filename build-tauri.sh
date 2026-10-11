#!/usr/bin/env bash
# ============================================================
# Build LomoAgent — Tauri v2 Desktop App (macOS, or GitBash on Windows)
# ============================================================
# Usage:
#   ./build-tauri.sh              # Full build (web + proxy + tauri)
#   ./build-tauri.sh --skip-web   # Skip web frontend rebuild
#   ./build-tauri.sh --skip-proxy # Skip proxy rebuild
#   ./build-tauri.sh --dev        # Debug build (faster, no installer)
#   ./build-tauri.sh --build-lomod  # macOS: also build lomod (scripts/build-lomod-macos.sh)
#   ./build-tauri.sh --bundles dmg  # Only these bundle types (default: tauri.<os>.conf.json)
#   ./build-tauri.sh --help       # Show help
#
# On macOS it builds for the host architecture (arm64 on Apple Silicon, x86_64 on Intel).
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
export PATH="$HOME/.cargo/bin:$PATH"

SKIP_WEB=false
SKIP_PROXY=false
DEV_BUILD=false
BUILD_LOMOD=false
BUNDLES=""

# Platform-specific names: pkg target, sharp's prebuilt package, bundled executables.
case "$(uname -s)" in
  Darwin)
    IS_MACOS=true
    case "$(uname -m)" in
      arm64)  PKG_TARGET=node22-macos-arm64; SHARP_PLATFORM=darwin-arm64 ;;
      x86_64) PKG_TARGET=node22-macos-x64;   SHARP_PLATFORM=darwin-x64 ;;
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    EXE_SUFFIX="" ;;
  *)
    IS_MACOS=false
    PKG_TARGET=node22-win-x64
    SHARP_PLATFORM=win32-x64
    EXE_SUFFIX=".exe" ;;
esac
PROXY_EXE="proxy${EXE_SUFFIX}"
LOMOD_EXE="lomod${EXE_SUFFIX}"

# ---- helpers ----
info() { echo -e "\033[36m$*\033[0m"; }
step() { echo -e "\n\033[33m--- $* ---\033[0m"; }
ok()   { echo -e "\033[32m$*\033[0m"; }
err()  { echo -e "\033[31mERROR: $*\033[0m" >&2; }

while [ $# -gt 0 ]; do
  arg="$1"
  shift
  case $arg in
    --skip-web)   SKIP_WEB=true ;;
    --skip-proxy) SKIP_PROXY=true ;;
    --dev)        DEV_BUILD=true ;;
    --build-lomod) BUILD_LOMOD=true ;;
    --bundles)
      [ $# -gt 0 ] || { err "--bundles needs a value, e.g. --bundles dmg"; exit 1; }
      BUNDLES="$1"
      shift ;;
    --help|-h)
      echo "Build LomoAgent Tauri App"
      echo ""
      echo "Usage: ./build-tauri.sh [options]"
      echo ""
      echo "Options:"
      echo "  --skip-web    Skip rebuilding the Immich web frontend"
      echo "  --skip-proxy  Skip rebuilding the proxy executable"
      echo "  --dev         Build in debug mode (faster, no installer)"
      echo "  --build-lomod macOS: build lomod from submodules/lomod first"
      echo "                (scripts/build-lomod-macos.sh; needs go + Homebrew vips etc.)"
      echo "  --bundles <b> Only build these bundle types, e.g. dmg or app,dmg"
      echo "  --help        Show this help message"
      echo ""
      echo "Prerequisites:"
      echo "  - Node.js 20+, pnpm, npm"
      echo "  - Rust toolchain (rustup)"
      echo "  - cargo tauri-cli v2  (cargo install tauri-cli --version '^2')"
      echo ""
      echo "src-tauri/resources/lomod/$LOMOD_EXE must exist: on Windows extract it from"
      echo "lomoagent.msi; on macOS build it with --build-lomod"
      exit 0 ;;
    *)
      err "Unknown option: $arg  (use --help for usage)"
      exit 1 ;;
  esac
done

info "=== Building LomoAgent Tauri App ==="

# ---- Step 1: Build Immich web frontend ----
if [ "$SKIP_WEB" = false ]; then
  step "Step 1: Building Immich web frontend"
  cd "$SCRIPT_DIR/submodules/immich/web"

  echo "Installing dependencies..."
  # Only the web app and its workspace dependencies (@immich/sdk), not the whole monorepo.
  # engine-strict=false: web/.npmrc turns it on, which makes pnpm fail on Windows over
  # exiftool-vendored.pl (os: !win32), a dependency of server/e2e that the web app never uses.
  pnpm install --filter "immich-web..." --config.engine-strict=false

  # CRITICAL: clean both build/ and .svelte-kit/ to prevent stale cache
  # The web app imports @immich/sdk from its compiled build/ dir, which a fresh clone lacks
  echo "Building @immich/sdk..."
  pnpm --filter "@immich/sdk" run build

  echo "Cleaning previous build..."
  rm -rf build .svelte-kit

  echo "Building static SPA..."
  pnpm run build

  echo "Creating web.zip in src-tauri/resources/..."
  WEB_ZIP="$SCRIPT_DIR/src-tauri/resources/web.zip"
  rm -f "$WEB_ZIP"
  cd build
  zip -r "$WEB_ZIP" .
  cd "$SCRIPT_DIR"

  for target_dir in "$SCRIPT_DIR/src-tauri/target/release" "$SCRIPT_DIR/src-tauri/target/debug"; do
    if [ -d "$target_dir" ]; then
      cp "$WEB_ZIP" "$target_dir/web.zip"
    fi
  done
  ok "Web build zipped to src-tauri/resources/web.zip (synced to target dirs)"
else
  step "Step 1: Skipping web frontend build"
  WEB_ZIP="$SCRIPT_DIR/src-tauri/resources/web.zip"
  if [ ! -f "$WEB_ZIP" ] && [ -f "$SCRIPT_DIR/src-tauri/target/release/web.zip" ]; then
    cp "$SCRIPT_DIR/src-tauri/target/release/web.zip" "$WEB_ZIP"
    ok "Restored missing src-tauri/resources/web.zip from target/release"
  fi
fi

# ---- Step 2: Build proxy executable ----
if [ "$SKIP_PROXY" = false ]; then
  step "Step 2: Building proxy executable"
  cd "$SCRIPT_DIR/proxy"

  echo "Installing dependencies..."
  # Use sharp's prebuilt binaries (bundled into sharp.zip): with a libvips on the system (e.g.
  # Homebrew's, which lomod's macOS build needs) sharp would otherwise build itself from source
  # against that one.
  SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install

  echo "Bundling with esbuild..."
  # --external:sharp keeps the native module out of the bundle (loaded at runtime from sharp.zip)
  npx esbuild server.ts --bundle --platform=node --target=node20 \
    --outfile=dist/server.cjs --external:sharp

  echo "Packaging with pkg ($PKG_TARGET)..."
  # --no-bytecode (needs --public): pkg's bytecode step, which runs each file through a
  # separate node process, has hung a CI build for an hour; the bundle is plain JS anyway.
  npx pkg --public --no-bytecode dist/server.cjs --targets "$PKG_TARGET" --output "dist/$PROXY_EXE"
  if [ "$IS_MACOS" = true ] && ! codesign --verify "dist/$PROXY_EXE" 2>/dev/null; then
    # Apple Silicon won't run an unsigned binary; ad-hoc sign it if pkg didn't.
    codesign --force --sign - "dist/$PROXY_EXE"
  fi

  cp "dist/$PROXY_EXE" "$SCRIPT_DIR/src-tauri/resources/$PROXY_EXE"
  ok "$PROXY_EXE copied to src-tauri/resources/"

  # ---- Create sharp.zip (preserves node_modules directory structure) ----
  echo "Creating sharp.zip..."
  SHARP_ZIP="$SCRIPT_DIR/src-tauri/resources/sharp.zip"
  SHARP_STAGING="$SCRIPT_DIR/proxy/dist/sharp_staging"
  rm -rf "$SHARP_STAGING"
  mkdir -p "$SHARP_STAGING/node_modules/sharp/lib"
  mkdir -p "$SHARP_STAGING/node_modules/@img/sharp-$SHARP_PLATFORM/lib"

  cp node_modules/sharp/lib/*             "$SHARP_STAGING/node_modules/sharp/lib/"
  cp node_modules/sharp/package.json      "$SHARP_STAGING/node_modules/sharp/"
  cp node_modules/@img/sharp-$SHARP_PLATFORM/lib/* \
                                          "$SHARP_STAGING/node_modules/@img/sharp-$SHARP_PLATFORM/lib/"
  cp node_modules/@img/sharp-$SHARP_PLATFORM/package.json \
                                          "$SHARP_STAGING/node_modules/@img/sharp-$SHARP_PLATFORM/"

  # On macOS, libvips itself is a separate package (Windows has it in sharp-win32-x64/lib).
  for dep in detect-libc semver @img/colour "@img/sharp-libvips-$SHARP_PLATFORM"; do
    src="node_modules/$dep"
    if [ -e "$src" ]; then
      mkdir -p "$SHARP_STAGING/node_modules/$(dirname "$dep")"
      cp -r "$src" "$SHARP_STAGING/node_modules/$dep"
    fi
  done

  rm -f "$SHARP_ZIP"
  (cd "$SHARP_STAGING" && zip -r "$SHARP_ZIP" .)
  rm -rf "$SHARP_STAGING"
  ok "sharp.zip created at src-tauri/resources/sharp.zip"

  cd "$SCRIPT_DIR"
else
  step "Step 2: Skipping proxy build"
fi

# Sync proxy resources to existing target dirs
for target_dir in "$SCRIPT_DIR/src-tauri/target/release" "$SCRIPT_DIR/src-tauri/target/debug"; do
  if [ -d "$target_dir" ]; then
    [ -f "$SCRIPT_DIR/src-tauri/resources/$PROXY_EXE" ] && \
      cp "$SCRIPT_DIR/src-tauri/resources/$PROXY_EXE" "$target_dir/$PROXY_EXE"
    [ -f "$SCRIPT_DIR/src-tauri/resources/sharp.zip" ] && \
      cp "$SCRIPT_DIR/src-tauri/resources/sharp.zip" "$target_dir/sharp.zip"
  fi
done
ok "Proxy resources synced to existing target directories"

# ---- Step 3: Verify lomo-backend files ----
if [ "$BUILD_LOMOD" = true ]; then
  if [ "$IS_MACOS" != true ]; then
    err "--build-lomod is for macOS; on Windows use .\\build-tauri.ps1 -BuildLomod"
    exit 1
  fi
  step "Step 3: Building lomod from submodules/lomod"
  "$SCRIPT_DIR/scripts/build-lomod-macos.sh"
fi
step "Step 3: Verifying lomo-backend files"
LOMOD_PATH="$SCRIPT_DIR/src-tauri/resources/lomod/$LOMOD_EXE"
if [ -f "$LOMOD_PATH" ]; then
  ok "$LOMOD_EXE: OK"
elif [ "$IS_MACOS" = true ]; then
  err "$LOMOD_EXE not found at $LOMOD_PATH -- build it with --build-lomod"
  exit 1
else
  err "$LOMOD_EXE not found at $LOMOD_PATH"
  echo "Extract lomoagent.msi and copy lomod/ contents to src-tauri/resources/lomod/:"
  echo "  msiexec /a lomoagent.msi /qn TARGETDIR=C:\\temp\\msi-extract"
  echo "  cp -r /c/temp/msi-extract/PFiles/Lomoware/Lomoagent/lomod/* src-tauri/resources/lomod/"
  exit 1
fi

# ---- Step 4: Build Tauri app ----
step "Step 4: Building Tauri application"
cd "$SCRIPT_DIR"

TAURI_ARGS=()
[ "$DEV_BUILD" = true ] && TAURI_ARGS+=(--debug)
[ -n "$BUNDLES" ] && TAURI_ARGS+=(--bundles "$BUNDLES")
if [ "$DEV_BUILD" = true ]; then
  echo "Building in debug mode..."
else
  echo "Building release..."
fi
# ${arr[@]+...}: an empty array trips set -u in macOS's bash 3.2
cargo tauri build ${TAURI_ARGS[@]+"${TAURI_ARGS[@]}"}

# ---- Done ----
info "\n=== Build complete! ==="
if [ "$DEV_BUILD" = false ]; then
  ls -lh src-tauri/target/release/bundle/msi/*.msi      2>/dev/null || true
  ls -lh src-tauri/target/release/bundle/nsis/*-setup.exe 2>/dev/null || true
  ls -lh src-tauri/target/release/bundle/dmg/*.dmg        2>/dev/null || true
  ls -ld src-tauri/target/release/bundle/macos/*.app      2>/dev/null || true
fi
