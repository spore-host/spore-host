package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The goroutine gate (#572). Lambda freezes the execution environment as soon
// as a handler returns, so a goroutine still running then is suspended until
// the next invocation of that environment, or lost if there is none. #566 lost
// /notify DMs and SMS that way; #572 lost audit records and chat-triggered
// actions. So, in every Lambda module under lambda/:
//
//   - every `go` statement must be joined in the function that starts it: that
//     function declares a sync.WaitGroup or errgroup.Group, the goroutine
//     references it, and the function calls its Wait();
//   - every Go(...) on a WaitGroup or errgroup.Group declared in a function must
//     be matched by its Wait() in that same function.
//
// Work that cannot finish before the handler returns goes through a durable
// queue instead (spore-bot: the async self-invocation, invokeAsync).
//
// "Reachable from a handler" is taken conservatively as all non-test code in
// the module: the handler is the only way into a Lambda binary, so anything not
// reachable from it is dead code, and dead code with a stray goroutine is just
// as easily revived.
//
// The gate runs from this module but covers every module beside it, since CI
// runs this module's tests on every PR.

// goroutineAllowlist holds goroutines exempt from the gate, keyed
// "<module>/<file>:<function>", each with the reason it is safe to outlive the
// handler. Keep it empty: a justified entry needs to explain why losing the
// work at a freeze is acceptable. Every entry must still match a goroutine.
var goroutineAllowlist = map[string]string{}

// goViolation is a goroutine, or a group's Go(...), not joined in its function.
type goViolation struct {
	pos  token.Position
	fn   string // enclosing function, e.g. "Auditor.Log" or "handler.func1"
	what string
}

// goGateStats counts what the gate looked at, so an empty discovery fails.
type goGateStats struct {
	goStmts  int // `go` statements
	groupGos int // Go(...) calls on a local WaitGroup / errgroup.Group
}

// checkGoroutines reports every unjoined goroutine in f.
func checkGoroutines(fset *token.FileSet, f *ast.File, st *goGateStats) []goViolation {
	var out []goViolation
	for _, d := range f.Decls {
		switch d := d.(type) {
		case *ast.FuncDecl:
			if d.Body != nil {
				out = append(out, checkFuncBody(fset, funcDeclName(d), d.Body, st)...)
			}
		default:
			// Function literals at package level (var x = func() { ... }).
			n := 0
			ast.Inspect(d, func(node ast.Node) bool {
				if lit, ok := node.(*ast.FuncLit); ok {
					n++
					out = append(out, checkFuncBody(fset, "pkg.func"+strconv.Itoa(n), lit.Body, st)...)
					return false
				}
				return true
			})
		}
	}
	return out
}

func funcDeclName(d *ast.FuncDecl) string {
	if d.Recv == nil || len(d.Recv.List) == 0 {
		return d.Name.Name
	}
	t := d.Recv.List[0].Type
	if s, ok := t.(*ast.StarExpr); ok {
		t = s.X
	}
	if ix, ok := t.(*ast.IndexExpr); ok {
		t = ix.X
	}
	if id, ok := t.(*ast.Ident); ok {
		return id.Name + "." + d.Name.Name
	}
	return d.Name.Name
}

// inspectShallow walks body without entering function literals, calling lit
// for each one it skips.
func inspectShallow(body ast.Node, visit func(ast.Node), lit func(*ast.FuncLit)) {
	ast.Inspect(body, func(n ast.Node) bool {
		if n == nil {
			return false
		}
		if fl, ok := n.(*ast.FuncLit); ok && n != body {
			if lit != nil {
				lit(fl)
			}
			return false
		}
		visit(n)
		return true
	})
}

// checkFuncBody checks one function body, then each function literal in it as
// a function of its own: a goroutine is joined by the function that starts it.
func checkFuncBody(fset *token.FileSet, name string, body *ast.BlockStmt, st *goGateStats) []goViolation {
	groups := map[string]bool{} // WaitGroup / errgroup.Group variables declared here
	waited := map[string]bool{} // x for each x.Wait() called here
	var goStmts []*ast.GoStmt
	var groupGos []*ast.CallExpr
	var lits []*ast.FuncLit

	inspectShallow(body, func(n ast.Node) {
		switch n := n.(type) {
		case *ast.ValueSpec:
			if isGroupType(n.Type) {
				for _, id := range n.Names {
					groups[id.Name] = true
				}
			} else if len(n.Values) > 0 && len(n.Names) > 0 && isGroupConstructor(n.Values[0]) {
				groups[n.Names[0].Name] = true
			}
		case *ast.AssignStmt:
			if len(n.Rhs) >= 1 && len(n.Lhs) >= 1 && isGroupConstructor(n.Rhs[0]) {
				if id, ok := n.Lhs[0].(*ast.Ident); ok {
					groups[id.Name] = true
				}
			}
		case *ast.GoStmt:
			goStmts = append(goStmts, n)
		case *ast.CallExpr:
			if sel, ok := n.Fun.(*ast.SelectorExpr); ok {
				if id, ok := sel.X.(*ast.Ident); ok {
					switch sel.Sel.Name {
					case "Wait":
						waited[id.Name] = true
					case "Go":
						groupGos = append(groupGos, n)
					}
				}
			}
		}
	}, func(fl *ast.FuncLit) { lits = append(lits, fl) })

	var out []goViolation
	for _, g := range goStmts {
		st.goStmts++
		joined := false
		for v := range groups {
			if waited[v] && references(g.Call, v) {
				joined = true
				break
			}
		}
		if !joined {
			out = append(out, goViolation{fset.Position(g.Pos()), name,
				"`go` statement not joined: no WaitGroup/errgroup declared in this function that the goroutine uses and the function Waits on"})
		}
	}
	for _, c := range groupGos {
		v := c.Fun.(*ast.SelectorExpr).X.(*ast.Ident).Name
		if !groups[v] {
			continue // not a group declared here (some other type's Go method)
		}
		st.groupGos++
		if !waited[v] {
			out = append(out, goViolation{fset.Position(c.Pos()), name,
				v + ".Go(...) without " + v + ".Wait() in the same function"})
		}
	}
	// A goroutine inside a function literal belongs to the literal, whose
	// joins are its own; the go statement's own func literal is checked too.
	for i, fl := range lits {
		out = append(out, checkFuncBody(fset, name+".func"+strconv.Itoa(i+1), fl.Body, st)...)
	}
	return out
}

// references reports whether n mentions identifier name.
func references(n ast.Node, name string) bool {
	found := false
	ast.Inspect(n, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok && id.Name == name {
			found = true
		}
		return !found
	})
	return found
}

// isGroupType reports whether t is sync.WaitGroup or errgroup.Group, or a
// pointer to one.
func isGroupType(t ast.Expr) bool {
	if s, ok := t.(*ast.StarExpr); ok {
		t = s.X
	}
	sel, ok := t.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	if !ok {
		return false
	}
	return (pkg.Name == "sync" && sel.Sel.Name == "WaitGroup") ||
		(pkg.Name == "errgroup" && sel.Sel.Name == "Group")
}

// isGroupConstructor reports whether e builds a group: T{}, &T{}, new(T), or
// errgroup.WithContext(...).
func isGroupConstructor(e ast.Expr) bool {
	if u, ok := e.(*ast.UnaryExpr); ok && u.Op == token.AND {
		e = u.X
	}
	switch e := e.(type) {
	case *ast.CompositeLit:
		return isGroupType(e.Type)
	case *ast.CallExpr:
		if id, ok := e.Fun.(*ast.Ident); ok && id.Name == "new" && len(e.Args) == 1 {
			return isGroupType(e.Args[0])
		}
		if sel, ok := e.Fun.(*ast.SelectorExpr); ok {
			if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == "errgroup" && sel.Sel.Name == "WithContext" {
				return true
			}
		}
	}
	return false
}

// lambdaModule is one Go module under lambda/.
type lambdaModule struct {
	name     string // directory name, e.g. "spore-bot"
	files    []string
	handlers int  // lambda.Start(...) calls
	isMain   bool // has package main (a Lambda binary, not a library)
}

// discoverLambdaModules finds every module under lambdaDir and its non-test Go
// files, failing the test if any part of the discovery comes up empty.
func discoverLambdaModules(t *testing.T, lambdaDir string) []lambdaModule {
	t.Helper()
	gomods, err := filepath.Glob(filepath.Join(lambdaDir, "*", "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	if len(gomods) == 0 {
		t.Fatalf("no Lambda modules (*/go.mod) found under %s", lambdaDir)
	}
	var mods []lambdaModule
	for _, gm := range gomods {
		dir := filepath.Dir(gm)
		m := lambdaModule{name: filepath.Base(dir)}
		err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				base := d.Name()
				if p != dir && (base == "vendor" || base == "testdata" || strings.HasPrefix(base, ".") || strings.HasPrefix(base, "_")) {
					return filepath.SkipDir
				}
				// A nested module is its own module, discovered on its own.
				if p != dir {
					if _, err := os.Stat(filepath.Join(p, "go.mod")); err == nil {
						return filepath.SkipDir
					}
				}
				return nil
			}
			if strings.HasSuffix(p, ".go") && !strings.HasSuffix(p, "_test.go") {
				m.files = append(m.files, p)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", dir, err)
		}
		if len(m.files) == 0 {
			t.Fatalf("Lambda module %s has no non-test Go files", m.name)
		}
		mods = append(mods, m)
	}
	return mods
}

// TestLambdaGoroutinesJoined is the gate: no Lambda module may start work that
// can outlive its handler (#572).
func TestLambdaGoroutinesJoined(t *testing.T) {
	mods := discoverLambdaModules(t, "..")

	var st goGateStats
	handlers := 0
	seenSelf := false
	matched := map[string]bool{}
	for i := range mods {
		m := &mods[i]
		if m.name == "spore-bot" {
			seenSelf = true
		}
		for _, p := range m.files {
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, p, nil, parser.SkipObjectResolution)
			if err != nil {
				t.Fatalf("parse %s: %v", p, err)
			}
			if f.Name.Name == "main" {
				m.isMain = true
			}
			ast.Inspect(f, func(n ast.Node) bool {
				if c, ok := n.(*ast.CallExpr); ok {
					if sel, ok := c.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Start" {
						if id, ok := sel.X.(*ast.Ident); ok && id.Name == "lambda" {
							m.handlers++
						}
					}
				}
				return true
			})
			for _, v := range checkGoroutines(fset, f, &st) {
				key := m.name + "/" + filepath.Base(p) + ":" + v.fn
				if _, ok := goroutineAllowlist[key]; ok {
					matched[key] = true
					continue
				}
				t.Errorf("%s (%s, in %s): %s. Lambda freezes the environment when the handler returns, so join it, or queue the work durably (#572)",
					v.pos, m.name, v.fn, v.what)
			}
		}
		if m.isMain && m.handlers == 0 {
			t.Errorf("Lambda module %s is package main but has no lambda.Start(...) handler", m.name)
		}
		handlers += m.handlers
	}

	if !seenSelf {
		t.Fatal("the gate did not discover its own module, spore-bot: discovery is broken")
	}
	if handlers == 0 {
		t.Fatal("no lambda.Start(...) handler found in any Lambda module: discovery is broken")
	}
	// spore-bot's /notify fan-out uses wg.Go, so a working gate always checks
	// something. Zero means it is looking at nothing.
	if st.goStmts+st.groupGos == 0 {
		t.Fatal("the gate found no goroutines at all (expected at least /notify's wg.Go): discovery is broken")
	}
	var stale []string
	for k := range goroutineAllowlist {
		if !matched[k] {
			stale = append(stale, k)
		}
	}
	sort.Strings(stale)
	for _, k := range stale {
		t.Errorf("goroutineAllowlist entry %q matches no unjoined goroutine; remove it", k)
	}
	t.Logf("checked %d modules, %d handlers, %d go statements, %d group Go calls",
		len(mods), handlers, st.goStmts, st.groupGos)
}

// TestGoroutineGateCatches checks the checker itself on known shapes, so the
// gate cannot pass by failing to recognise a goroutine.
func TestGoroutineGateCatches(t *testing.T) {
	tests := []struct {
		name string
		src  string
		want int // violations
	}{
		{"bare go", `func f() { go g() }`, 1},
		{"bare go func literal", `func f() { go func() { g() }() }`, 1},
		{"method go", `func (a *A) Log() { go func() { a.put() }() }`, 1},
		{"WaitGroup joined", `func f() {
			var wg sync.WaitGroup
			wg.Add(1)
			go func() { defer wg.Done(); g() }()
			wg.Wait()
		}`, 0},
		{"WaitGroup passed as arg, joined", `func f() {
			wg := &sync.WaitGroup{}
			wg.Add(1)
			go worker(wg)
			wg.Wait()
		}`, 0},
		{"WaitGroup never waited", `func f() {
			var wg sync.WaitGroup
			wg.Add(1)
			go func() { defer wg.Done() }()
		}`, 1},
		{"goroutine not using the waited group", `func f() {
			var wg, other sync.WaitGroup
			go func() { defer other.Done() }()
			wg.Wait()
		}`, 1},
		{"wg.Go with deferred Wait", `func f() {
			var wg sync.WaitGroup
			defer wg.Wait()
			wg.Go(func() { g() })
		}`, 0},
		{"wg.Go without Wait", `func f() {
			var wg sync.WaitGroup
			wg.Go(func() { g() })
		}`, 1},
		{"errgroup joined", `func f(ctx context.Context) error {
			eg, ctx := errgroup.WithContext(ctx)
			eg.Go(func() error { return g(ctx) })
			return eg.Wait()
		}`, 0},
		{"errgroup not waited", `func f() {
			eg := new(errgroup.Group)
			eg.Go(func() error { return nil })
		}`, 1},
		{"Wait only inside a nested literal", `func f() {
			var wg sync.WaitGroup
			go func() { defer wg.Done() }()
			h(func() { wg.Wait() })
		}`, 1},
		{"go inside a joined goroutine's body", `func f() {
			var wg sync.WaitGroup
			wg.Go(func() { go g() })
			wg.Wait()
		}`, 1},
		{"go joined inside a literal", `func f() {
			h(func() {
				var wg sync.WaitGroup
				go func() { defer wg.Done() }()
				wg.Wait()
			})
		}`, 0},
		{"package-level literal", `var f = func() { go g() }`, 1},
		{"unrelated Go method", `func f(r *Runner) { r.Go() }`, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, "x.go", "package p\n"+tt.src, parser.SkipObjectResolution)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			var st goGateStats
			if got := checkGoroutines(fset, f, &st); len(got) != tt.want {
				t.Errorf("got %d violations, want %d: %+v", len(got), tt.want, got)
			}
		})
	}
}
