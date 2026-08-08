#!/bin/bash
# Builds one release tarball for one target, plus the manifest the publish step
# reads. The tree it stages mirrors the repo — dist/, assets/, config/ — so the
# same __dirname resolution finds the install root from a checkout and from an
# install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-dev}"
CHANNEL="${2:-dev}"
TARGET="${3:-darwin-arm64}"
OUT="$ROOT/dist-release"
STAGE="$OUT/tode"

# The terminal-browser build tode is written against, read from the source so
# the pin lives in exactly one place.
PINNED="$(node -e '
  const fs = require("fs");
  const src = fs.readFileSync(process.argv[1], "utf8");
  const found = src.match(/PINNED_VERSION\s*=\s*"([^"]+)"/);
  if (!found) { console.error("no PINNED_VERSION in release.ts"); process.exit(1); }
  console.log(found[1]);
' "$ROOT/src/runtime/release.ts")"

echo "tode $VERSION ($CHANNEL) for $TARGET, terminal-browser $PINNED"

rm -rf "$OUT"
mkdir -p "$STAGE"

echo "==> compiling"
(cd "$ROOT" && npx tsc -p tsconfig.json)

echo "==> staging"
cp -R "$ROOT/dist" "$STAGE/dist"
cp -R "$ROOT/assets" "$STAGE/assets"
[ -d "$ROOT/config" ] && cp -R "$ROOT/config" "$STAGE/config"
echo "$VERSION" > "$STAGE/VERSION"
echo "$CHANNEL" > "$STAGE/CHANNEL"

# The shim the installer copies to $XDG_BIN_HOME. It runs the CLI with the
# Electron helper in node mode: the helper's Info.plist sets LSUIElement, so no
# icon ever appears in the Dock while the CLI runs.
mkdir -p "$STAGE/bin"
cat > "$STAGE/bin/tode" <<'SHIM'
#!/bin/sh
ROOT="${TODE_INSTALL_ROOT:-$HOME/.local/lib/tode}"
APP="$ROOT/vendor/terminal-browser/electron/terminal-browser.app/Contents"
HELPER="$APP/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"
[ -x "$HELPER" ] || HELPER="$APP/MacOS/terminal-browser"
export ELECTRON_RUN_AS_NODE=1
exec "$HELPER" "$ROOT/dist/main.js" "$@"
SHIM
chmod +x "$STAGE/bin/tode"

echo "==> fetching terminal-browser $PINNED"
# The pinned installer carries the download url and the hash, so one request is
# enough to fetch the build and know the bytes are right.
INSTALLER="$(curl -fsSL "https://terminal-browser.sh/install/v/$PINNED")"
field() { printf '%s\n' "$INSTALLER" | sed -n "s/^$1=\"\([^\"]*\)\".*/\1/p" | head -1; }
# Newer installers carry a table of "target url sha256 size"; older ones, and
# the single-target ones, carry DOWNLOAD_URL and SHA256 at the top instead.
TB_ROW="$(printf '%s\n' "$INSTALLER" | awk -v t="$TARGET" '$1 == t && NF == 4')"
if [ -n "$TB_ROW" ]; then
  TB_URL="$(printf '%s\n' "$TB_ROW" | awk '{print $2}')"
  TB_SHA="$(printf '%s\n' "$TB_ROW" | awk '{print $3}')"
else
  TB_URL="$(field DOWNLOAD_URL)"
  TB_SHA="$(field SHA256)"
  case "$TB_URL" in
    *"$TARGET"*) ;;
    *) echo "the pinned installer only offers $TB_URL, which is not $TARGET" >&2; exit 1 ;;
  esac
fi
[ -n "$TB_URL" ] || { echo "could not resolve a terminal-browser url for $TARGET" >&2; exit 1; }

TB_TAR="$OUT/terminal-browser.tar.gz"
curl -fL --retry 3 --retry-delay 2 --progress-bar "$TB_URL" -o "$TB_TAR"
if command -v sha256sum >/dev/null 2>&1; then CHECK="sha256sum -c -"; else CHECK="shasum -a 256 -c -"; fi
if [ -n "$TB_SHA" ]; then
  echo "$TB_SHA  $TB_TAR" | $CHECK >/dev/null \
    || { echo "terminal-browser download did not match its hash" >&2; exit 1; }
fi
mkdir -p "$STAGE/vendor/terminal-browser"
tar -xzf "$TB_TAR" -C "$STAGE/vendor/terminal-browser" --strip-components 1
rm -f "$TB_TAR"

# resolveRuntime() checks for these two before it trusts the tree
[ -f "$STAGE/vendor/terminal-browser/cli/dist/main.js" ] \
  && [ -d "$STAGE/vendor/terminal-browser/electron/terminal-browser.app" ] \
  || { echo "the unpacked terminal-browser is missing pieces" >&2; exit 1; }

echo "==> packing"
TARBALL="$OUT/tode-$TARGET.tar.gz"
tar -czf "$TARBALL" -C "$OUT" tode

if command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
else
  SHA256="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
fi
SIZE="$(wc -c < "$TARBALL" | tr -d ' ')"

cat > "$OUT/manifest-$TARGET.json" <<EOF
{
  "version": "$VERSION",
  "channel": "$CHANNEL",
  "platform": "$TARGET",
  "file": "$(basename "$TARBALL")",
  "sha256": "$SHA256",
  "size": $SIZE,
  "terminalBrowser": "$PINNED",
  "published": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

rm -rf "$STAGE"
echo "built $(basename "$TARBALL") — $((SIZE / 1000000)) MB"
