// The banned-words copy lint (brief §6 rule 3: "A test greps the rendered
// basic-mode copy for banned words"). Pure: give it text and the glossary,
// get back every banned term it contains. Used by gates/copy-lint.test.ts on
// the error catalogue and by e2e/copy.spec.ts on every rendered route.
import glossaryJson from "./glossary.json" with { type: "json" };

export interface GlossaryTerm {
  concept: string;
  say: string;
  dontSay: string[];
  cli: string;
  note?: string;
}

export interface Glossary {
  terms: GlossaryTerm[];
  toolNames: { terms: string[] };
  patterns: { name: string; regex: string; say: string }[];
}

export const glossary = glossaryJson as unknown as Glossary;

export interface Banned {
  /** What the copy said. */
  match: string;
  /** Why it is banned. */
  rule: string;
  /** What to say instead. */
  say: string;
}

interface Matcher {
  re: RegExp;
  rule: string;
  say: string;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A phrase as a whole-word, case-insensitive regex. Spaces and hyphens are interchangeable: "on demand" catches "on-demand". */
export function phraseRegex(term: string): RegExp {
  const body = term
    .trim()
    .split(/[\s-]+/)
    .map(escape)
    .join("[\\s\\u00a0-]+");
  // \b fails next to non-word characters; use lookarounds so "$X" style terms still anchor.
  // The terms come from the checked-in glossary, escaped above, and the lint runs
  // only in the gates, never in the shipped bundle: no user input reaches it.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "giu");
}

export function compile(g: Glossary = glossary): Matcher[] {
  const out: Matcher[] = [];
  const seen = new Set<string>();
  const push = (m: Matcher) => {
    // "on-demand" and "on demand" compile to the same regex; count a hit once.
    if (seen.has(m.re.source)) return;
    seen.add(m.re.source);
    out.push(m);
  };
  for (const t of g.terms) {
    for (const d of t.dontSay) push({ re: phraseRegex(d), rule: `glossary, ${t.concept}`, say: t.say });
  }
  for (const name of g.toolNames.terms) {
    push({ re: phraseRegex(name), rule: "tool or AWS service name in body copy (brief §6 rule 4)", say: "the task word; tool names go in the command-line footer" });
  }
  // Patterns are regexes by design, from the checked-in glossary; gates only.
  for (const p of g.patterns) {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    push({ re: new RegExp(p.regex, "g"), rule: p.name, say: p.say });
  }
  return out;
}

const DEFAULT_MATCHERS = compile();

/** Every banned term in `text`. Empty means clean. */
export function lintCopy(text: string, matchers: Matcher[] = DEFAULT_MATCHERS): Banned[] {
  const found: Banned[] = [];
  for (const m of matchers) {
    m.re.lastIndex = 0;
    for (const hit of text.matchAll(m.re)) found.push({ match: hit[0], rule: m.rule, say: m.say });
  }
  return found;
}

/** One line per finding, with a little context, for a test failure message. */
export function describeFindings(where: string, text: string, found: Banned[]): string[] {
  return found.map((f) => {
    const i = text.toLowerCase().indexOf(f.match.toLowerCase());
    const ctx = i < 0 ? "" : text.slice(Math.max(0, i - 30), i + f.match.length + 30).replace(/\s+/g, " ");
    return `${where}: "${f.match}" (${f.rule}; say ${f.say}) in "…${ctx}…"`;
  });
}
