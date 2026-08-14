#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"
SHIM="$BIN_HOME/tode"

mkdir -p "$BIN_HOME"
# An older shim may be a symlink, and writing through a dangling one fails.
rm -f "$SHIM"
cat > "$SHIM" <<EOF
#!/bin/sh
# tode dev shim — always runs the working tree at $ROOT.
# Rebuilds only when a source file is newer than the build, so an unchanged
# tree costs one find and nothing else.
ROOT='$ROOT'
if [ ! -f "\$ROOT/dist/main.js" ] || [ -n "\$(find "\$ROOT/src" -name '*.ts' -newer "\$ROOT/dist/main.js" -print -quit 2>/dev/null)" ]; then
  (cd "\$ROOT" && npx --no-install tsc -p tsconfig.json) || exit 1
fi
exec node "\$ROOT/dist/main.js" "\$@"
EOF
chmod +x "$SHIM"

(cd "$ROOT" && npx --no-install tsc -p tsconfig.json)

echo "tode -> $ROOT"
echo "shim  $SHIM"
case ":$PATH:" in
  *":$BIN_HOME:"*) ;;
  *)
    echo; echo "add $BIN_HOME to your PATH:"
    case "${SHELL:-}" in
      */zsh)  echo "  echo 'export PATH=\"$BIN_HOME:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
      */bash) echo "  echo 'export PATH=\"$BIN_HOME:\$PATH\"' >> ~/.bashrc && exec bash" ;;
      *)      echo "  export PATH=\"$BIN_HOME:\$PATH\"  (add it to your shell's rc file)" ;;
    esac
    ;;
esac
