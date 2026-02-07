#!/bin/bash
set -euo pipefail

# Rebuilds APL and PromQL parser WASM binaries.
#
# APL parser: built from axiom1 repo using TinyGo (1.9MB)
# PromQL parser: built from standalone go module using Go (10MB)
#   TinyGo can't compile the Prometheus client_golang dependency.
#
# Usage: ./build.sh /path/to/axiom1

AXIOM_DIR="${1:?Usage: $0 /path/to/axiom1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$AXIOM_DIR/go.mod" ]; then
  echo "error: $AXIOM_DIR doesn't look like the axiom1 repo" >&2
  exit 1
fi

command -v tinygo >/dev/null 2>&1 || {
  echo "error: tinygo not found. brew install tinygo-org/tools/tinygo" >&2
  exit 1
}

AXIOM_COMMIT="$(cd "$AXIOM_DIR" && git rev-parse HEAD)"
GO_VER="$(go version | awk '{print $3}')"
TINYGO_VER="$(tinygo version | awk '{print $3}')"

# ── APL parser (TinyGo) ──────────────────────────────────────────────
echo "Building apl-parser.wasm from axiom1@${AXIOM_COMMIT:0:12} (tinygo $TINYGO_VER)..."
cd "$AXIOM_DIR"
tinygo build -target=wasm -o "$SCRIPT_DIR/apl-parser.wasm" "$SCRIPT_DIR/main.go"

TINYGO_ROOT="$(tinygo env TINYGOROOT)"
cp "$TINYGO_ROOT/targets/wasm_exec.js" "$SCRIPT_DIR/wasm_exec.js"

echo "  apl-parser.wasm: $(wc -c < "$SCRIPT_DIR/apl-parser.wasm" | tr -d ' ') bytes"

# ── PromQL parser (standard Go) ──────────────────────────────────────
echo "Building promql-parser.wasm (go $GO_VER)..."
PROMQL_TMP="$(mktemp -d)"
cp "$SCRIPT_DIR/promql_main.go" "$PROMQL_TMP/main.go"
# Remove the build constraint so it compiles as main
sed -i '' '/^\/\/go:build ignore/d' "$PROMQL_TMP/main.go"

cd "$PROMQL_TMP"
go mod init promql-validate
go mod tidy
GOOS=js GOARCH=wasm go build -o "$SCRIPT_DIR/promql-parser.wasm" .

GOROOT="$(go env GOROOT)"
cp "$GOROOT/lib/wasm/wasm_exec.js" "$SCRIPT_DIR/wasm_exec_go.js"

rm -rf "$PROMQL_TMP"
PROM_VER="$(grep 'prometheus/prometheus' "$PROMQL_TMP/go.mod" 2>/dev/null | awk '{print $2}' || echo 'unknown')"

echo "  promql-parser.wasm: $(wc -c < "$SCRIPT_DIR/promql-parser.wasm" | tr -d ' ') bytes"

# ── VERSION file ─────────────────────────────────────────────────────
cat > "$SCRIPT_DIR/VERSION" <<EOF
apl-parser.wasm:
  source: axiom1 pkg/kirby/apl/parser/ast/v2
  axiom1 commit: $AXIOM_COMMIT
  compiler: tinygo $TINYGO_VER
  built: $(date -u +%Y-%m-%d)

promql-parser.wasm:
  source: github.com/prometheus/prometheus promql/parser
  compiler: $GO_VER
  built: $(date -u +%Y-%m-%d)

wasm_exec.js: tinygo $TINYGO_VER (for apl-parser.wasm)
wasm_exec_go.js: $GO_VER (for promql-parser.wasm)
EOF

echo "Done."
