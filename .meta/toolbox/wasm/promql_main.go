//go:build ignore

// Standalone PromQL validator — built separately with standard Go (not TinyGo)
// because the Prometheus client_golang dependency uses runtime internals
// TinyGo doesn't support.
//
// Build: cd /tmp/promql-validate-wasm && GOOS=js GOARCH=wasm go build -o promql-parser.wasm .
// Requires its own go.mod with github.com/prometheus/prometheus dependency.

package main

import (
	"syscall/js"

	"github.com/prometheus/prometheus/promql/parser"
)

func jsValidatePromQL(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		result := js.Global().Get("Object").New()
		result.Set("valid", false)
		result.Set("error", "expected 1 string argument")
		return result
	}

	_, err := parser.ParseExpr(args[0].String())
	result := js.Global().Get("Object").New()
	if err != nil {
		result.Set("valid", false)
		result.Set("error", err.Error())
	} else {
		result.Set("valid", true)
		result.Set("error", js.Null())
	}
	return result
}

func main() {
	js.Global().Set("ValidatePromQL", js.FuncOf(jsValidatePromQL))
	select {}
}
