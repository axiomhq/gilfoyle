//go:build js && wasm

package main

import (
	"strings"
	"syscall/js"

	ast "github.com/axiomhq/axiom/pkg/kirby/apl/parser/ast/v2"
)

type analysisEnv struct {
	scalarLets       map[string]ast.Expr
	tabularLets      map[string]*ast.TabularExpression
	functionLets     map[string]*ast.FunctionDeclare
	resolvingScalars map[string]bool
	resolvingTables  map[string]bool
}

type timeBoundAnalysis struct {
	scansData   bool
	selfBounded bool
	violations  int
}

func parseDoc(query string) (*ast.Doc, error) {
	var doc ast.Doc
	if err := ast.Parse("query.apl", query, &doc); err != nil {
		return nil, err
	}

	return &doc, nil
}

func newResult() js.Value {
	return js.Global().Get("Object").New()
}

func invalidArgsResult() js.Value {
	result := newResult()
	result.Set("valid", false)
	result.Set("error", "expected 1 string argument")
	return result
}

func jsValidateAPL(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		return invalidArgsResult()
	}

	_, err := parseDoc(args[0].String())
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

func jsAnalyzeAPL(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		return invalidArgsResult()
	}

	doc, err := parseDoc(args[0].String())
	result := newResult()
	if err != nil {
		result.Set("valid", false)
		result.Set("error", err.Error())
		result.Set("requiresTimeBound", false)
		result.Set("hasExplicitTimeBound", false)
		return result
	}

	env := buildAnalysisEnv(doc)
	analysis := env.analyzeDoc(doc)

	result.Set("valid", true)
	result.Set("error", js.Null())
	result.Set("requiresTimeBound", analysis.scansData)
	result.Set("hasExplicitTimeBound", !analysis.scansData || analysis.violations == 0)
	return result
}

func buildAnalysisEnv(doc *ast.Doc) *analysisEnv {
	env := &analysisEnv{
		scalarLets:       map[string]ast.Expr{},
		tabularLets:      map[string]*ast.TabularExpression{},
		functionLets:     map[string]*ast.FunctionDeclare{},
		resolvingScalars: map[string]bool{},
		resolvingTables:  map[string]bool{},
	}

	for _, statement := range doc.Statements {
		switch stmt := statement.(type) {
		case *ast.LetScalar:
			if stmt.Name != nil && stmt.Value != nil {
				env.scalarLets[strings.ToLower(stmt.Name.Name)] = stmt.Value
			}
		case *ast.LetTabular:
			if stmt.Name != nil && stmt.Body != nil {
				env.tabularLets[strings.ToLower(stmt.Name.Name)] = stmt.Body
			}
		case *ast.LetFunction:
			if stmt.Name != nil && stmt.Func != nil {
				env.functionLets[strings.ToLower(stmt.Name.Name)] = stmt.Func
			}
		}
	}

	return env
}

func (env *analysisEnv) analyzeDoc(doc *ast.Doc) timeBoundAnalysis {
	if doc == nil || doc.Body == nil || doc.Body.Source == nil {
		return timeBoundAnalysis{}
	}

	return env.analyzeTabular(doc.Body, true)
}

func (env *analysisEnv) analyzeTabular(expr *ast.TabularExpression, requireOwnBound bool) timeBoundAnalysis {
	return env.analyzeTabularWithInherited(expr, false, false, requireOwnBound)
}

func (env *analysisEnv) analyzeTabularWithInherited(expr *ast.TabularExpression, inheritedBounded, inheritedScans, requireOwnBound bool) timeBoundAnalysis {
	result := timeBoundAnalysis{
		scansData:   inheritedScans,
		selfBounded: inheritedBounded,
	}

	if expr == nil {
		if requireOwnBound && result.scansData && !result.selfBounded {
			result.violations++
		}
		return result
	}

	if expr.Source != nil {
		source := env.analyzeDataSource(expr.Source)
		result.scansData = source.scansData
		result.selfBounded = source.selfBounded
		result.violations += source.violations
	}

	result = env.applyOperations(expr.Operations, result)

	if requireOwnBound && result.scansData && !result.selfBounded {
		result.violations++
	}

	return result
}

func (env *analysisEnv) applyOperations(operations ast.Operations, result timeBoundAnalysis) timeBoundAnalysis {
	for _, operation := range operations {
		switch op := operation.(type) {
		case *ast.Where:
			if env.exprEnforcesTimeBound(op.Predicate) {
				result.selfBounded = true
			}
		case *ast.Search:
			searchInputs := env.analyzeSearchInputs(op.In)
			result.violations += searchInputs.violations
			if len(op.In) > 0 {
				result.scansData = searchInputs.scansData
				result.selfBounded = searchInputs.selfBounded
			}
			if env.exprEnforcesTimeBound(op.Predicate) {
				result.scansData = true
				result.selfBounded = true
			}
		case *ast.MakeSeries:
			if env.makeSeriesHasTimeBound(op) {
				result.selfBounded = true
			}
		case *ast.Union:
			unionTables := env.analyzeUnionTables(op.Tables)
			result.scansData = result.scansData || unionTables.scansData
			result.violations += unionTables.violations
			result.selfBounded = result.selfBounded && unionTables.selfBounded
		case *ast.Join:
			right := env.analyzeTabular(op.RightTable, true)
			result.scansData = result.scansData || right.scansData
			result.violations += right.violations
		case *ast.Lookup:
			right := env.analyzeTabular(op.RightTable, true)
			result.scansData = result.scansData || right.scansData
			result.violations += right.violations
		case *ast.Invoke:
			invoked := env.analyzeInvoke(op, result.selfBounded, result.scansData)
			result.scansData = invoked.scansData
			result.selfBounded = invoked.selfBounded
			result.violations += invoked.violations
		case *ast.Fork:
			forked := env.analyzeFork(op, result.selfBounded, result.scansData)
			result.scansData = forked.scansData
			result.selfBounded = forked.selfBounded
			result.violations += forked.violations
		}
	}

	return result
}

func (env *analysisEnv) analyzeDataSource(source ast.DataSource) timeBoundAnalysis {
	switch src := source.(type) {
	case *ast.Dataset:
		if src.Module == nil && src.Name != nil {
			if resolved, ok := env.analyzeNamedTabular(src.Name.Name, false); ok {
				return resolved
			}
		}
		return timeBoundAnalysis{scansData: true}
	case *ast.TabularExpression:
		return env.analyzeTabular(src, false)
	case *ast.Union:
		return env.analyzeUnionTables(src.Tables)
	case *ast.Search:
		inputs := env.analyzeSearchInputs(src.In)
		return timeBoundAnalysis{
			scansData:   true,
			selfBounded: env.exprEnforcesTimeBound(src.Predicate) || inputs.selfBounded,
			violations:  inputs.violations,
		}
	case *ast.CallExpr:
		return env.analyzeCallSource(src)
	case *ast.DataTable, *ast.ExternalData, *ast.Print:
		return timeBoundAnalysis{}
	default:
		return timeBoundAnalysis{}
	}
}

func (env *analysisEnv) analyzeSearchInputs(tables ast.TabularExpressions) timeBoundAnalysis {
	result := timeBoundAnalysis{selfBounded: true}
	for _, table := range tables {
		child := env.analyzeTabular(table, false)
		result.scansData = result.scansData || child.scansData
		result.violations += child.violations
		if child.scansData && !child.selfBounded {
			result.selfBounded = false
		}
	}

	if !result.scansData {
		result.selfBounded = false
	}

	return result
}

func (env *analysisEnv) analyzeUnionTables(tables ast.TabularExpressions) timeBoundAnalysis {
	result := timeBoundAnalysis{selfBounded: true}
	for _, table := range tables {
		child := env.analyzeTabular(table, false)
		result.scansData = result.scansData || child.scansData
		result.violations += child.violations
		if child.scansData && !child.selfBounded {
			result.selfBounded = false
		}
	}

	if !result.scansData {
		result.selfBounded = false
	}

	return result
}

func (env *analysisEnv) analyzeFork(fork *ast.Fork, inheritedBounded, inheritedScans bool) timeBoundAnalysis {
	result := timeBoundAnalysis{
		scansData:   inheritedScans,
		selfBounded: inheritedBounded,
	}

	if fork == nil {
		return result
	}

	allBounded := true
	for _, table := range fork.Tables {
		if table == nil {
			continue
		}

		branch := env.analyzeTabularWithInherited(table.Body, inheritedBounded, inheritedScans, false)
		result.scansData = result.scansData || branch.scansData
		result.violations += branch.violations
		if branch.scansData && !branch.selfBounded {
			allBounded = false
		}
	}

	result.selfBounded = allBounded
	return result
}

func (env *analysisEnv) analyzeInvoke(invoke *ast.Invoke, inheritedBounded, inheritedScans bool) timeBoundAnalysis {
	result := timeBoundAnalysis{
		scansData:   inheritedScans,
		selfBounded: inheritedBounded,
	}

	if invoke == nil {
		return result
	}

	call, ok := invoke.Call.(*ast.CallExpr)
	if !ok {
		return result
	}

	name, ok := calledFunctionName(call.Func)
	if !ok {
		return result
	}

	fn := env.functionLets[strings.ToLower(name)]
	if fn == nil {
		return result
	}

	block, ok := fn.Body.(*ast.TabularBlock)
	if !ok {
		return result
	}

	return env.analyzeTabularWithInherited(block.Body, inheritedBounded, inheritedScans, false)
}

func (env *analysisEnv) analyzeCallSource(call *ast.CallExpr) timeBoundAnalysis {
	name, ok := calledFunctionName(call.Func)
	if !ok {
		return timeBoundAnalysis{scansData: true}
	}

	if resolved, ok := env.analyzeNamedTabular(name, false); ok {
		return resolved
	}

	return timeBoundAnalysis{scansData: true}
}

func (env *analysisEnv) analyzeNamedTabular(name string, requireOwnBound bool) (timeBoundAnalysis, bool) {
	key := strings.ToLower(name)
	if env.resolvingTables[key] {
		return timeBoundAnalysis{scansData: true}, true
	}

	if table := env.tabularLets[key]; table != nil {
		env.resolvingTables[key] = true
		defer delete(env.resolvingTables, key)
		return env.analyzeTabular(table, requireOwnBound), true
	}

	if fn := env.functionLets[key]; fn != nil {
		block, ok := fn.Body.(*ast.TabularBlock)
		if !ok {
			return timeBoundAnalysis{}, false
		}

		env.resolvingTables[key] = true
		defer delete(env.resolvingTables, key)
		return env.analyzeTabularWithInherited(block.Body, false, false, requireOwnBound), true
	}

	return timeBoundAnalysis{}, false
}

func (env *analysisEnv) makeSeriesHasTimeBound(series *ast.MakeSeries) bool {
	if series == nil || series.AxisField == nil {
		return false
	}

	return strings.EqualFold(series.AxisField.Name, "_time") &&
		env.isExplicitTimeExpr(series.AxisFrom) &&
		env.isExplicitTimeExpr(series.AxisTo)
}

func (env *analysisEnv) exprEnforcesTimeBound(expr ast.Expr) bool {
	switch value := expr.(type) {
	case *ast.ParenExpr:
		return env.exprEnforcesTimeBound(value.Expr)
	case *ast.BinaryExpr:
		if env.isTimeComparison(value) {
			return true
		}

		switch {
		case strings.EqualFold(value.Op, "and"):
			return env.exprEnforcesTimeBound(value.Left) || env.exprEnforcesTimeBound(value.Right)
		case strings.EqualFold(value.Op, "or"):
			return env.exprEnforcesTimeBound(value.Left) && env.exprEnforcesTimeBound(value.Right)
		default:
			return false
		}
	case *ast.BetweenExpr:
		return env.isTimeFieldExpr(value.Left) &&
			env.isExplicitTimeExpr(value.LeftRange) &&
			env.isExplicitTimeExpr(value.RightRange)
	case *ast.InExpr:
		if !env.isTimeFieldExpr(value.Left) {
			return false
		}
		if value.RightAsExpr != nil {
			return env.isExplicitTimeExpr(value.RightAsExpr)
		}
		list, ok := value.Right.(*ast.ExprList)
		if !ok || len(list.List) == 0 {
			return false
		}
		for _, candidate := range list.List {
			if !env.isExplicitTimeExpr(candidate) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func (env *analysisEnv) isTimeComparison(expr *ast.BinaryExpr) bool {
	if expr == nil || !isTimeComparisonOp(expr.Op) {
		return false
	}

	return (env.isTimeFieldExpr(expr.Left) && env.isExplicitTimeExpr(expr.Right)) ||
		(env.isTimeFieldExpr(expr.Right) && env.isExplicitTimeExpr(expr.Left))
}

func isTimeComparisonOp(op string) bool {
	switch op {
	case ">", ">=", "<", "<=", "==":
		return true
	default:
		return false
	}
}

func (env *analysisEnv) isTimeFieldExpr(expr ast.Expr) bool {
	switch value := expr.(type) {
	case *ast.Entity:
		return strings.EqualFold(value.Name, "_time")
	case *ast.ParenExpr:
		return env.isTimeFieldExpr(value.Expr)
	default:
		return false
	}
}

func (env *analysisEnv) isExplicitTimeExpr(expr ast.Expr) bool {
	switch value := expr.(type) {
	case nil:
		return false
	case *ast.ParenExpr:
		return env.isExplicitTimeExpr(value.Expr)
	case *ast.DateTime:
		return true
	case *ast.Entity:
		return env.isExplicitTimeEntity(value.Name)
	case *ast.CallExpr:
		name, ok := calledFunctionName(value.Func)
		if !ok {
			return false
		}
		switch strings.ToLower(name) {
		case "ago", "datetime", "time", "now":
			return true
		default:
			return false
		}
	case *ast.BinaryExpr:
		switch value.Op {
		case "+", "-":
			return (env.isExplicitTimeExpr(value.Left) && env.isExplicitDurationExpr(value.Right)) ||
				(value.Op == "+" && env.isExplicitDurationExpr(value.Left) && env.isExplicitTimeExpr(value.Right))
		default:
			return false
		}
	default:
		return false
	}
}

func (env *analysisEnv) isExplicitDurationExpr(expr ast.Expr) bool {
	switch value := expr.(type) {
	case nil:
		return false
	case *ast.ParenExpr:
		return env.isExplicitDurationExpr(value.Expr)
	case *ast.TimeSpan:
		return true
	case *ast.Entity:
		return env.isExplicitDurationEntity(value.Name)
	case *ast.BinaryExpr:
		switch value.Op {
		case "+", "-":
			return env.isExplicitDurationExpr(value.Left) && env.isExplicitDurationExpr(value.Right)
		case "*", "/":
			return (env.isNumericExpr(value.Left) && env.isExplicitDurationExpr(value.Right)) ||
				(env.isExplicitDurationExpr(value.Left) && env.isNumericExpr(value.Right))
		default:
			return false
		}
	case *ast.UnaryExpr:
		return env.isExplicitDurationExpr(value.Expr)
	default:
		return false
	}
}

func (env *analysisEnv) isNumericExpr(expr ast.Expr) bool {
	switch value := expr.(type) {
	case *ast.Long, *ast.Real, *ast.Hex:
		return true
	case *ast.ParenExpr:
		return env.isNumericExpr(value.Expr)
	case *ast.UnaryExpr:
		return env.isNumericExpr(value.Expr)
	case *ast.Entity:
		return env.isNumericEntity(value.Name)
	default:
		return false
	}
}

func (env *analysisEnv) isExplicitTimeEntity(name string) bool {
	key := strings.ToLower(name)
	value, ok := env.scalarLets[key]
	if !ok || env.resolvingScalars[key] {
		return false
	}

	env.resolvingScalars[key] = true
	defer delete(env.resolvingScalars, key)
	return env.isExplicitTimeExpr(value)
}

func (env *analysisEnv) isExplicitDurationEntity(name string) bool {
	key := strings.ToLower(name)
	value, ok := env.scalarLets[key]
	if !ok || env.resolvingScalars[key] {
		return false
	}

	env.resolvingScalars[key] = true
	defer delete(env.resolvingScalars, key)
	return env.isExplicitDurationExpr(value)
}

func (env *analysisEnv) isNumericEntity(name string) bool {
	key := strings.ToLower(name)
	value, ok := env.scalarLets[key]
	if !ok || env.resolvingScalars[key] {
		return false
	}

	env.resolvingScalars[key] = true
	defer delete(env.resolvingScalars, key)
	return env.isNumericExpr(value)
}

func calledFunctionName(expr ast.Expr) (string, bool) {
	switch value := expr.(type) {
	case *ast.Entity:
		return value.Name, true
	case *ast.ParenExpr:
		return calledFunctionName(value.Expr)
	default:
		return "", false
	}
}

func main() {
	js.Global().Set("ValidateAPL", js.FuncOf(jsValidateAPL))
	js.Global().Set("AnalyzeAPL", js.FuncOf(jsAnalyzeAPL))
	select {}
}
