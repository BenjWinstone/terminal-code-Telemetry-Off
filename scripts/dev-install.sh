#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"
SHIM="$BIN_HOME/tode-dev"

mkdir -p "$BIN_HOME"
# An older shim may be a symlink, and writing through a dangling one fails.
rm -f "$SHIM"
cat > "$SHIM" <<EOF
#!/bin/sh
# tode-dev — always runs the working tree at $ROOT, never a stale build.
#
# Staleness is judged against a stamp file recorded at the moment the last
# successful build *started*, so a file edited while that build ran still
# counts as newer and triggers a rebuild next launch. Build outputs
# (dist/, assets/pages/) are excluded from the check or every rebuild
# would mark itself stale. An unchanged tree costs one find and nothing else.
ROOT='$ROOT'
STAMP="\$ROOT/dist/.dev-build-stamp"

# Dependencies: install when node_modules is missing or the lockfile moved.
if [ ! -d "\$ROOT/node_modules" ] || \\
   [ "\$ROOT/package-lock.json" -nt "\$ROOT/node_modules/.package-lock.json" ]; then
  echo "tode-dev: installing dependencies..." >&2
  (cd "\$ROOT" && npm install) || exit 1
fi

stale=no
if [ ! -f "\$STAMP" ] || [ ! -f "\$ROOT/dist/main.js" ]; then
  stale=yes
elif [ -n "\$(find "\$ROOT/src" "\$ROOT/assets" "\$ROOT/package.json" "\$ROOT/package-lock.json" "\$ROOT/tsconfig.json" "\$ROOT/vite.config.mts" \\
        \\( -path "\$ROOT/assets/pages" -prune \\) -o -newer "\$STAMP" -print -quit 2>/dev/null)" ]; then
  stale=yes
fi

if [ "\$stale" = yes ]; then
  echo "tode-dev: rebuilding..." >&2
  mkdir -p "\$ROOT/dist"
  touch "\$STAMP.new"
  (cd "\$ROOT" && npm run -s build) || { rm -f "\$STAMP.new"; exit 1; }
  mv "\$STAMP.new" "\$STAMP"
fi

exec node "\$ROOT/dist/main.js" "\$@"
EOF
chmod +x "$SHIM"

echo "tode-dev -> $ROOT"
echo "shim      $SHIM"
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
