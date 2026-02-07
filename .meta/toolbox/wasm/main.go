//go:build js && wasm

package main

import (
	"syscall/js"

	ast "github.com/axiomhq/axiom/pkg/kirby/apl/parser/ast/v2"
)

func jsValidateAPL(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		result := js.Global().Get("Object").New()
		result.Set("valid", false)
		result.Set("error", "expected 1 string argument")
		return result
	}

	var doc ast.Doc
	err := ast.Parse("query.apl", args[0].String(), &doc)
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
	js.Global().Set("ValidateAPL", js.FuncOf(jsValidateAPL))
	select {}
}
