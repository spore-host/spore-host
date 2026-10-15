package main

// Gate: what spore-bot's code touches must be granted to spore-bot-role in
// infra/tofu/spore-bot/main.tf, and every environment variable it reads must be
// documented in that module's README (#576).
//
// #576 was spore-sms-pending: sms_notify.go writes it, the Tofu role never
// granted it, and the write's error was discarded, so every pending-SMS write
// could fail with nothing in the logs. A hand-written list of tables would have
// had the same blind spot, so both sides are discovered: the code side from the
// AST (os.Getenv and its wrappers, table-name constants and getEnv defaults, and
// every <service>.<Op>Input literal), the Tofu side from a rough parse of the
// policy's statements. Every discovery fails when it finds nothing.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

const (
	tofuMainPath   = "../../infra/tofu/spore-bot/main.tf"
	tofuReadmePath = "../../infra/tofu/spore-bot/README.md"
)

// botSource is the parsed non-test Go source of this package.
type botSource struct {
	fset  *token.FileSet
	files []*ast.File
}

func loadBotSource(t *testing.T) botSource {
	t.Helper()
	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	src := botSource{fset: token.NewFileSet()}
	for _, p := range paths {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(src.fset, p, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", p, err)
		}
		src.files = append(src.files, f)
	}
	if len(src.files) == 0 {
		t.Fatal("found no non-test Go files: discovery is broken")
	}
	return src
}

// importName returns the local name f uses for import path, or "".
func importName(f *ast.File, path string) string {
	for _, imp := range f.Imports {
		p, _ := strconv.Unquote(imp.Path.Value)
		if p != path {
			continue
		}
		if imp.Name != nil {
			return imp.Name.Name
		}
		return filepath.Base(p)
	}
	return ""
}

func strLit(e ast.Expr) (string, bool) {
	if bl, ok := e.(*ast.BasicLit); ok && bl.Kind == token.STRING {
		s, err := strconv.Unquote(bl.Value)
		return s, err == nil
	}
	return "", false
}

// isPkgCall reports whether call is pkgName.fn(...).
func isPkgCall(call *ast.CallExpr, pkgName, fn string) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || pkgName == "" {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && id.Name == pkgName && sel.Sel.Name == fn
}

// envPart is one piece of an env var name: a literal, or a parameter of the
// enclosing function (upper-cased if wrapped in strings.ToUpper).
type envPart struct {
	lit   string
	param string
	upper bool
}

// renderEnvArg turns an os.Getenv argument into parts. Anything that is not a
// literal, a parameter, a concatenation, or strings.ToUpper of one becomes a
// placeholder named after the expression.
func renderEnvArg(e ast.Expr, params map[string]bool, stringsPkg string, upper bool) []envPart {
	switch x := e.(type) {
	case *ast.BinaryExpr:
		if x.Op == token.ADD {
			return append(renderEnvArg(x.X, params, stringsPkg, upper), renderEnvArg(x.Y, params, stringsPkg, upper)...)
		}
	case *ast.CallExpr:
		if isPkgCall(x, stringsPkg, "ToUpper") && len(x.Args) == 1 {
			return renderEnvArg(x.Args[0], params, stringsPkg, true)
		}
	case *ast.Ident:
		if params[x.Name] {
			return []envPart{{param: x.Name, upper: upper}}
		}
		return []envPart{{lit: "<" + strings.ToUpper(x.Name) + ">"}}
	}
	if s, ok := strLit(e); ok {
		if upper {
			s = strings.ToUpper(s)
		}
		return []envPart{{lit: s}}
	}
	return []envPart{{lit: "<?>"}}
}

// envWrapper is a function that reads an env var named from its parameters.
type envWrapper struct {
	params []string
	parts  []envPart
}

// discoverEnvVars returns every env var name the code reads. Calls to
// os.Getenv/os.LookupEnv with a name built from the enclosing function's
// parameters make that function a wrapper (getEnv, oauthEnv,
// twilioProjectNumber); the name is then resolved at each call of the wrapper.
// A part that cannot be resolved to a literal is rendered <IDENT>, so
// oauthEnv(platform, "SLACK_CLIENT_ID") gives <PLATFORM>_SLACK_CLIENT_ID.
func discoverEnvVars(t *testing.T, src botSource) map[string]bool {
	t.Helper()
	wrappers := map[string]envWrapper{}
	var direct [][]envPart

	for _, f := range src.files {
		osPkg := importName(f, "os")
		stringsPkg := importName(f, "strings")
		for _, d := range f.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Body == nil {
				continue
			}
			params := map[string]bool{}
			var order []string
			for _, fld := range fd.Type.Params.List {
				for _, n := range fld.Names {
					params[n.Name] = true
					order = append(order, n.Name)
				}
			}
			ast.Inspect(fd.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok || len(call.Args) == 0 {
					return true
				}
				if !isPkgCall(call, osPkg, "Getenv") && !isPkgCall(call, osPkg, "LookupEnv") {
					return true
				}
				parts := renderEnvArg(call.Args[0], params, stringsPkg, false)
				usesParam := false
				for _, p := range parts {
					usesParam = usesParam || p.param != ""
				}
				if usesParam {
					if fd.Recv != nil {
						t.Errorf("%s: method %s reads an env var named by a parameter; the gate only resolves plain functions", src.fset.Position(call.Pos()), fd.Name.Name)
					}
					wrappers[fd.Name.Name] = envWrapper{params: order, parts: parts}
				} else {
					direct = append(direct, parts)
				}
				return true
			})
		}
	}

	found := map[string]bool{}
	add := func(parts []envPart, args map[string]string, pos token.Pos) {
		var b strings.Builder
		for _, p := range parts {
			if p.param == "" {
				b.WriteString(p.lit)
				continue
			}
			b.WriteString(args[p.param])
		}
		name := b.String()
		if name == "" || strings.Contains(name, "<?>") {
			t.Errorf("%s: env var name %q could not be resolved; make it a literal or teach the gate", src.fset.Position(pos), name)
			return
		}
		found[name] = true
	}
	for _, parts := range direct {
		add(parts, nil, token.NoPos)
	}
	for _, f := range src.files {
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			id, ok := call.Fun.(*ast.Ident)
			if !ok {
				return true
			}
			w, ok := wrappers[id.Name]
			if !ok || len(call.Args) != len(w.params) {
				return true
			}
			args := map[string]string{}
			for i, a := range call.Args {
				var upper bool
				for _, p := range w.parts {
					if p.param == w.params[i] {
						upper = upper || p.upper
					}
				}
				if s, ok := strLit(a); ok {
					if upper {
						s = strings.ToUpper(s)
					}
					args[w.params[i]] = s
					continue
				}
				name := "?"
				switch x := a.(type) {
				case *ast.Ident:
					name = x.Name
				case *ast.SelectorExpr:
					name = x.Sel.Name
				}
				args[w.params[i]] = "<" + strings.ToUpper(name) + ">"
			}
			add(w.parts, args, call.Pos())
			return true
		})
	}
	if len(found) == 0 {
		t.Fatal("discovered no env vars in the code: discovery is broken")
	}
	return found
}

// tableUse is one DynamoDB operation on one table.
type tableUse struct {
	table, op string
	index     bool
	pos       token.Position
}

// discoverAWSCalls returns the DynamoDB operations per table, and the other IAM
// actions the bot's own role needs. Tables are resolved from constants whose
// name ends in "Table" and from getEnv("..._TABLE", "<default>") assigned to a
// struct field, so a TableName of aws.String(smsPendingTable) or
// aws.String(r.registryTable) resolves to the table name.
func discoverAWSCalls(t *testing.T, src botSource) ([]tableUse, map[string]bool) {
	t.Helper()
	consts := map[string]string{} // const ident -> table
	fields := map[string]string{} // struct field -> default table
	for _, f := range src.files {
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.GenDecl:
				if x.Tok != token.CONST {
					return true
				}
				for _, s := range x.Specs {
					vs := s.(*ast.ValueSpec)
					for i, nm := range vs.Names {
						if i < len(vs.Values) && strings.HasSuffix(nm.Name, "Table") {
							if v, ok := strLit(vs.Values[i]); ok {
								consts[nm.Name] = v
							}
						}
					}
				}
			case *ast.KeyValueExpr:
				key, ok := x.Key.(*ast.Ident)
				call, ok2 := x.Value.(*ast.CallExpr)
				if !ok || !ok2 || len(call.Args) != 2 {
					return true
				}
				if fn, ok := call.Fun.(*ast.Ident); !ok || fn.Name != "getEnv" {
					return true
				}
				env, ok1 := strLit(call.Args[0])
				def, ok2 := strLit(call.Args[1])
				if ok1 && ok2 && strings.HasSuffix(env, "_TABLE") {
					fields[key.Name] = def
				}
			}
			return true
		})
	}
	if len(consts)+len(fields) == 0 {
		t.Fatal("discovered no table names in the code: discovery is broken")
	}

	resolve := func(e ast.Expr) (string, bool) {
		for {
			switch x := e.(type) {
			case *ast.CallExpr: // aws.String(x)
				if len(x.Args) != 1 {
					return "", false
				}
				e = x.Args[0]
				continue
			case *ast.UnaryExpr: // &r.registryTable
				e = x.X
				continue
			case *ast.StarExpr:
				e = x.X
				continue
			case *ast.Ident:
				v, ok := consts[x.Name]
				return v, ok
			case *ast.SelectorExpr:
				v, ok := fields[x.Sel.Name]
				return v, ok
			}
			return strLit(e)
		}
	}

	var uses []tableUse
	other := map[string]bool{}
	for _, f := range src.files {
		pkgs := map[string]string{} // local name -> service
		for _, imp := range f.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			const svc = "github.com/aws/aws-sdk-go-v2/service/"
			if !strings.HasPrefix(p, svc) || strings.HasSuffix(p, "/types") {
				continue
			}
			service := strings.TrimPrefix(p, svc)
			switch service {
			case "dynamodb", "lambda", "sts":
			case "ec2":
				// EC2 runs on credentials assumed into SpawnBotCrossAccount in the
				// user's account (crossAccountEC2); spawn's
				// bot-cross-account-role.yaml grants it, not spore-bot-role.
				continue
			default:
				t.Errorf("%s imports %s: the gate does not know which role grants it; extend iam_gate_test.go", src.fset.Position(f.Package).Filename, p)
				continue
			}
			name := filepath.Base(p)
			if imp.Name != nil {
				name = imp.Name.Name
			}
			pkgs[name] = service
		}
		stscredsPkg := importName(f, "github.com/aws/aws-sdk-go-v2/credentials/stscreds")
		ast.Inspect(f, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok && isPkgCall(call, stscredsPkg, "NewAssumeRoleProvider") {
				other["sts:AssumeRole"] = true
			}
			cl, ok := n.(*ast.CompositeLit)
			if !ok {
				return true
			}
			sel, ok := cl.Type.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			id, ok := sel.X.(*ast.Ident)
			if !ok {
				return true
			}
			service, ok := pkgs[id.Name]
			if !ok || !strings.HasSuffix(sel.Sel.Name, "Input") {
				return true
			}
			op := strings.TrimSuffix(sel.Sel.Name, "Input")
			pos := src.fset.Position(cl.Pos())
			if service != "dynamodb" {
				if service == "lambda" && op == "Invoke" {
					op = "InvokeFunction" // the IAM action differs from the API name
				}
				other[service+":"+op] = true
				return true
			}
			var tables []string
			index := false
			for _, el := range cl.Elts {
				kv, ok := el.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				switch kv.Key.(*ast.Ident).Name {
				case "TableName":
					tbl, ok := resolve(kv.Value)
					if !ok {
						t.Errorf("%s: dynamodb.%s TableName does not resolve to a known table name", pos, sel.Sel.Name)
					}
					tables = append(tables, tbl)
				case "IndexName":
					index = true
				case "RequestItems":
					m, ok := kv.Value.(*ast.CompositeLit)
					if !ok {
						t.Errorf("%s: dynamodb.%s RequestItems is not a map literal", pos, sel.Sel.Name)
						continue
					}
					for _, me := range m.Elts {
						tbl, ok := resolve(me.(*ast.KeyValueExpr).Key)
						if !ok {
							t.Errorf("%s: dynamodb.%s RequestItems key does not resolve to a known table name", pos, sel.Sel.Name)
						}
						tables = append(tables, tbl)
					}
				}
			}
			if len(tables) == 0 {
				t.Errorf("%s: dynamodb.%s names no table the gate can find", pos, sel.Sel.Name)
			}
			for _, tbl := range tables {
				uses = append(uses, tableUse{table: tbl, op: op, index: index, pos: pos})
			}
			return true
		})
	}
	if len(uses) == 0 {
		t.Fatal("discovered no DynamoDB operations in the code: discovery is broken")
	}
	return uses, other
}

// tofuStatement is one statement of the spore-bot-permissions policy.
type tofuStatement struct {
	sid     string
	actions map[string]bool
	tables  map[string]bool // tables the Resource covers
	indexes map[string]bool // tables whose /index/* the Resource covers
}

var (
	reLocalsBlock = regexp.MustCompile(`(?m)^locals\s*\{`)
	reScalar      = regexp.MustCompile(`(?m)^\s*([a-z_]+)\s*=\s*"([^"$]*)"\s*$`)
	reQuoted      = regexp.MustCompile(`"([^"]*)"`)
	reTableARN    = regexp.MustCompile(`:table/([^"/]+)(/index/\*)?"`)
)

// block returns the text between the bracket at s[open] and its match.
func block(t *testing.T, s string, open int) string {
	t.Helper()
	o, c := s[open], map[byte]byte{'{': '}', '[': ']'}[s[open]]
	depth := 0
	for i := open; i < len(s); i++ {
		switch s[i] {
		case o:
			depth++
		case c:
			depth--
			if depth == 0 {
				return s[open+1 : i]
			}
		}
	}
	t.Fatalf("unbalanced %q in %s", o, tofuMainPath)
	return ""
}

// parseTofuPolicy roughly parses main.tf: the scalar locals, local.tables, and
// the statements of the spore_bot role policy. Only the shapes main.tf uses are
// understood; anything else fails the test rather than being skipped.
func parseTofuPolicy(t *testing.T) []tofuStatement {
	t.Helper()
	raw, err := os.ReadFile(tofuMainPath)
	if err != nil {
		t.Fatalf("read %s: %v", tofuMainPath, err)
	}
	tf := string(raw)

	loc := reLocalsBlock.FindStringIndex(tf)
	if loc == nil {
		t.Fatalf("%s has no locals block", tofuMainPath)
	}
	locals := block(t, tf, loc[1]-1)
	scalars := map[string]string{}
	for _, m := range reScalar.FindAllStringSubmatch(locals, -1) {
		scalars[m[1]] = m[2]
	}
	i := regexp.MustCompile(`(?m)^\s*tables\s*=\s*\{`).FindStringIndex(locals)
	if i == nil {
		t.Fatalf("%s locals has no tables map", tofuMainPath)
	}
	var botTables []string
	for _, m := range reQuoted.FindAllStringSubmatch(block(t, locals, i[1]-1), -1) {
		botTables = append(botTables, m[1])
	}
	if len(botTables) == 0 {
		t.Fatalf("%s local.tables is empty", tofuMainPath)
	}
	// local.table_arns is built from local.tables; read which ARN shapes it
	// produces rather than assuming the table and its /index/* are both there.
	ta := regexp.MustCompile(`(?m)^\s*table_arns\s*=\s*flatten\(`).FindStringIndex(locals)
	if ta == nil {
		t.Fatalf("%s locals has no table_arns = flatten(...)", tofuMainPath)
	}
	taBody := block(t, locals, strings.Index(locals[ta[1]:], "[")+ta[1])
	arnTables := strings.Contains(taBody, `:table/${t}"`)
	arnIndexes := strings.Contains(taBody, `:table/${t}/index/*"`)
	if !arnTables && !arnIndexes {
		t.Fatalf("%s local.table_arns produces no table ARN the gate recognises", tofuMainPath)
	}

	r := regexp.MustCompile(`resource\s+"aws_iam_role_policy"\s+"spore_bot"\s*\{`).FindStringIndex(tf)
	if r == nil {
		t.Fatalf("%s has no aws_iam_role_policy.spore_bot", tofuMainPath)
	}
	res := block(t, tf, r[1]-1)
	sl := regexp.MustCompile(`Statement\s*=\s*\[`).FindStringIndex(res)
	if sl == nil {
		t.Fatalf("aws_iam_role_policy.spore_bot has no Statement list")
	}
	stmts := block(t, res, sl[1]-1)

	var out []tofuStatement
	for j := 0; j < len(stmts); j++ {
		if stmts[j] != '{' {
			continue
		}
		body := block(t, stmts, j)
		j += len(body) + 1
		// Interpolate ${local.x} so a literal table ARN can name a local.
		body = regexp.MustCompile(`\$\{local\.([a-z_]+)\}`).ReplaceAllStringFunc(body, func(m string) string {
			k := m[len("${local.") : len(m)-1]
			if v, ok := scalars[k]; ok {
				return v
			}
			return m
		})
		st := tofuStatement{actions: map[string]bool{}, tables: map[string]bool{}, indexes: map[string]bool{}}
		if m := regexp.MustCompile(`Sid\s*=\s*"([^"]+)"`).FindStringSubmatch(body); m != nil {
			st.sid = m[1]
		}
		if !regexp.MustCompile(`Effect\s*=\s*"Allow"`).MatchString(body) {
			continue
		}
		am := regexp.MustCompile(`(?m)^\s*Action\s*=\s*(\[[^\]]*\]|"[^"]*")`).FindStringSubmatch(body)
		if am == nil {
			t.Fatalf("statement %q has no Action the gate can read", st.sid)
		}
		for _, a := range reQuoted.FindAllStringSubmatch(am[1], -1) {
			st.actions[a[1]] = true
		}
		rm := regexp.MustCompile(`(?m)^\s*Resource\s*=\s*(.+)$`).FindStringSubmatch(body)
		if rm == nil {
			t.Fatalf("statement %q has no Resource the gate can read", st.sid)
		}
		if strings.TrimSpace(rm[1]) == "local.table_arns" {
			for _, tb := range botTables {
				st.tables[tb], st.indexes[tb] = arnTables, arnIndexes
			}
		}
		for _, m := range reTableARN.FindAllStringSubmatch(rm[1], -1) {
			if m[2] != "" {
				st.indexes[m[1]] = true
			} else {
				st.tables[m[1]] = true
			}
		}
		out = append(out, st)
	}
	if len(out) == 0 {
		t.Fatalf("parsed no Allow statements from %s: the parse is broken", tofuMainPath)
	}
	return out
}

// TestTofuRoleGrantsEveryDynamoDBCallTheBotMakes is the #576 gate: every
// DynamoDB operation in the code must be allowed on its table (and index, for a
// Query on a GSI) by spore-bot-role's policy.
func TestTofuRoleGrantsEveryDynamoDBCallTheBotMakes(t *testing.T) {
	uses, _ := discoverAWSCalls(t, loadBotSource(t))
	stmts := parseTofuPolicy(t)
	seen := map[string]bool{}
	for _, u := range uses {
		action := "dynamodb:" + u.op
		ok := false
		for _, s := range stmts {
			if s.actions[action] && s.tables[u.table] && (!u.index || s.indexes[u.table]) {
				ok = true
			}
		}
		key := action + " " + u.table
		if !ok && !seen[key] {
			seen[key] = true
			what := "table/" + u.table
			if u.index {
				what += " and its /index/*"
			}
			t.Errorf("%s: %s on %s is not granted to spore-bot-role in %s", u.pos, action, what, tofuMainPath)
		}
	}
}

// TestTofuRoleGrantsTheBotsOtherAWSCalls covers the non-DynamoDB calls the bot
// makes under its own role: the async self-invoke and the cross-account assume.
func TestTofuRoleGrantsTheBotsOtherAWSCalls(t *testing.T) {
	_, other := discoverAWSCalls(t, loadBotSource(t))
	if len(other) == 0 {
		t.Fatal("discovered no non-DynamoDB AWS calls: discovery is broken (the bot self-invokes and assumes roles)")
	}
	stmts := parseTofuPolicy(t)
	for action := range other {
		ok := false
		for _, s := range stmts {
			ok = ok || s.actions[action]
		}
		if !ok {
			t.Errorf("the code calls %s, which spore-bot-role is not granted in %s", action, tofuMainPath)
		}
	}
}

// TestTofuRoleGrantsNoTableTheCodeDoesNotUse keeps the grant least-privilege:
// a table granted but never touched is stale.
func TestTofuRoleGrantsNoTableTheCodeDoesNotUse(t *testing.T) {
	uses, _ := discoverAWSCalls(t, loadBotSource(t))
	used := map[string]bool{}
	for _, u := range uses {
		used[u.table] = true
	}
	for _, s := range parseTofuPolicy(t) {
		for tbl := range s.tables {
			if !used[tbl] {
				t.Errorf("statement %q grants table %s, which the code never uses", s.sid, tbl)
			}
		}
	}
}

var reReadmeEnvRow = regexp.MustCompile("(?m)^\\|\\s*`([A-Z0-9_<>]+)`\\s*\\|")

// TestReadmeDocumentsEveryEnvVarTheBotReads: Tofu ignores the function's
// environment (it holds secrets), so the README's table is the only record of
// what must be set. It must list exactly what the code reads.
func TestReadmeDocumentsEveryEnvVarTheBotReads(t *testing.T) {
	code := discoverEnvVars(t, loadBotSource(t))
	raw, err := os.ReadFile(tofuReadmePath)
	if err != nil {
		t.Fatalf("read %s: %v", tofuReadmePath, err)
	}
	readme := string(raw)
	start := strings.Index(readme, "\n## Environment variables")
	if start < 0 {
		t.Fatalf("%s has no \"## Environment variables\" section", tofuReadmePath)
	}
	section := readme[start+1:]
	if end := strings.Index(section, "\n## "); end >= 0 {
		section = section[:end]
	}
	doc := map[string]bool{}
	for _, m := range reReadmeEnvRow.FindAllStringSubmatch(section, -1) {
		doc[m[1]] = true
	}
	if len(doc) == 0 {
		t.Fatalf("%s lists no env vars: the parse is broken", tofuReadmePath)
	}
	var missing, stale []string
	for v := range code {
		if !doc[v] {
			missing = append(missing, v)
		}
	}
	for v := range doc {
		if !code[v] {
			stale = append(stale, v)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)
	if len(missing) > 0 {
		t.Errorf("env vars read by lambda/spore-bot but not in %s: %v", tofuReadmePath, missing)
	}
	if len(stale) > 0 {
		t.Errorf("env vars in %s that lambda/spore-bot no longer reads: %v", tofuReadmePath, stale)
	}
}
