#!/bin/bash
set -euo pipefail

# Rebuilds apl-parser.wasm from the axiom1 repo using TinyGo.
# Usage: ./build.sh /path/to/axiom1

AXIOM_DIR="${1:?Usage: $0 /path/to/axiom1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WASM_SRC="$SCRIPT_DIR/main.go"

if [ ! -f "$AXIOM_DIR/go.mod" ]; then
  echo "error: $AXIOM_DIR doesn't look like the axiom1 repo" >&2
  exit 1
fi

command -v tinygo >/dev/null 2>&1 || {
  echo "error: tinygo not found. brew install tinygo-org/tools/tinygo" >&2
  exit 1
}

COMMIT="$(cd "$AXIOM_DIR" && git rev-parse HEAD)"
GO_VER="$(go version | awk '{print $3}')"
TINYGO_VER="$(tinygo version | awk '{print $3}')"

echo "Building apl-parser.wasm from axiom1@${COMMIT:0:12} (tinygo $TINYGO_VER)..."
cd "$AXIOM_DIR"
tinygo build -target=wasm -o "$SCRIPT_DIR/apl-parser.wasm" "$WASM_SRC"

TINYGO_ROOT="$(tinygo env TINYGOROOT)"
cp "$TINYGO_ROOT/targets/wasm_exec.js" "$SCRIPT_DIR/wasm_exec.js"

cat > "$SCRIPT_DIR/VERSION" <<EOF
axiom1 commit: $COMMIT
go version: $GO_VER
tinygo version: $TINYGO_VER
built: $(date -u +%Y-%m-%d)
source: pkg/kirby/apl/parser/ast/v2
EOF

SIZE=$(wc -c < "$SCRIPT_DIR/apl-parser.wasm" | tr -d ' ')
echo "Done. $SIZE bytes."
