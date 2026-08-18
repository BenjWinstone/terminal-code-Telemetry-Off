#!/bin/bash
set -euo pipefail

# Builds the working tree and installs it exactly the way a release lands:
# the same staged layout (dist/, assets/, config/, vendor/, bin/), the same
# atomic swap into ~/.local/lib/tode, the same ~/.local/bin/tode shim. The
# one shortcut: the vendored terminal-browser comes from the pin the checkout
# already resolved (~/.local/share/tode/runtime), so iterating costs a local
# clone, never a download.

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
LIB_HOME="$HOME/.local/lib"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"
APP="${TODE_INSTALL_ROOT:-$LIB_HOME/tode}"
VERSION="dev-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)-dirty"

echo "==> building"
(cd "$ROOT" && npm run -s build)

echo "==> staging $VERSION"
STAGE="$APP.new"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$ROOT/dist" "$STAGE/dist"
cp -R "$ROOT/assets" "$STAGE/assets"
[ -d "$ROOT/config" ] && cp -R "$ROOT/config" "$STAGE/config"
echo "$VERSION" > "$STAGE/VERSION"
echo "dev" > "$STAGE/CHANNEL"

echo "==> vendoring terminal-browser (cached pin)"
TB_ROOT="$(cd "$ROOT" && node -e '
require("./dist/runtime/release.js").resolveRuntime()
  .then((r) => { console.log(r.root); })
  .catch((e) => { console.error(e.message); process.exit(1); });
')"
mkdir -p "$STAGE/vendor"
# APFS clones for free; plain copy elsewhere
cp -Rc "$TB_ROOT" "$STAGE/vendor/terminal-browser" 2>/dev/null \
  || cp -R "$TB_ROOT" "$STAGE/vendor/terminal-browser"

# the same shims release.sh ships, chosen by this machine's platform
mkdir -p "$STAGE/bin"
case "$(uname -s)" in
  Darwin)
    cat > "$STAGE/bin/tode" <<'SHIM'
#!/bin/sh
ROOT="${TODE_INSTALL_ROOT:-$HOME/.local/lib/tode}"
APP="$ROOT/vendor/terminal-browser/electron/terminal-browser.app/Contents"
HELPER="$APP/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"
[ -x "$HELPER" ] || HELPER="$APP/MacOS/terminal-browser"
export ELECTRON_RUN_AS_NODE=1
exec "$HELPER" "$ROOT/dist/main.js" "$@"
SHIM
    ;;
  Linux)
    cat > "$STAGE/bin/tode" <<'SHIM'
#!/bin/sh
ROOT="${TODE_INSTALL_ROOT:-$HOME/.local/lib/tode}"
export ELECTRON_RUN_AS_NODE=1
exec "$ROOT/vendor/terminal-browser/electron/electron" "$ROOT/dist/main.js" "$@"
SHIM
    ;;
esac
chmod +x "$STAGE/bin/tode"

echo "==> installing to $APP"
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mkdir -p "$(dirname "$APP")"
mv "$STAGE" "$APP"
rm -rf "$APP.old"

mkdir -p "$BIN_HOME"
cp "$APP/bin/tode" "$BIN_HOME/tode"
chmod +x "$BIN_HOME/tode"

echo "installed $VERSION"
echo "  app  $APP"
echo "  bin  $BIN_HOME/tode"
