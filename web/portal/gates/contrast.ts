// Token contrast gate (brief §5, §7 SC 1.4.3 / 1.4.11).
//
// Reads the custom properties out of tokens.css, resolves var() aliases, and
// checks every pair in contrast-pairs.json against its WCAG 2.x minimum:
// 4.5 for text, 3 for non-text (control boundaries, focus rings, status
// graphics). It also fails when a --color-* token appears in no pair and is not
// explicitly exempted with a reason, so a colour cannot be added to the
// palette without someone deciding what it must contrast with.
//
// Pure functions: the gate test runs them on the real files, the unit tests on
// deliberately broken inputs.

export interface ContrastPair {
  fg: string;
  bg: string;
  min: number;
  use: string;
}

export interface PairsFile {
  pairs: ContrastPair[];
  exempt: Record<string, string>;
}

export interface ContrastResult {
  pair: ContrastPair;
  ratio: number;
  ok: boolean;
}

/** Parse `--name: value;` declarations out of a stylesheet. Comments are stripped first. */
export function parseTokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

/** Follow var(--x) aliases to a literal value. Throws on a cycle or a missing token. */
export function resolveToken(tokens: Map<string, string>, name: string, seen: string[] = []): string {
  if (seen.includes(name)) throw new Error(`token cycle: ${[...seen, name].join(" -> ")}`);
  const v = tokens.get(name);
  if (v === undefined) throw new Error(`unknown token ${name}`);
  const alias = v.match(/^var\((--[a-z0-9-]+)\)$/i);
  return alias ? resolveToken(tokens, alias[1], [...seen, name]) : v;
}

/** #rgb or #rrggbb to [r,g,b] 0-255. Only opaque hex is accepted: a translucent colour has no single contrast ratio. */
export function parseHex(hex: string): [number, number, number] {
  const m = hex.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) throw new Error(`not an opaque hex colour: ${hex}`);
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2.x relative luminance. */
export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseHex(a));
  const lb = luminance(parseHex(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Check every pair. A pair below its minimum is ok:false; the caller decides what to do with it. */
export function checkPairs(tokens: Map<string, string>, pairs: ContrastPair[]): ContrastResult[] {
  return pairs.map((pair) => {
    const ratio = contrastRatio(resolveToken(tokens, pair.fg), resolveToken(tokens, pair.bg));
    // Compare at two decimals, the precision WCAG tools report; a raw 4.4999
    // rounding up to "4.50" on screen must still fail, so floor, don't round.
    const floored = Math.floor(ratio * 100) / 100;
    return { pair, ratio, ok: floored >= pair.min };
  });
}

/** Colour tokens that no pair checks and no exemption explains. */
export function uncheckedColourTokens(tokens: Map<string, string>, file: PairsFile): string[] {
  const used = new Set(file.pairs.flatMap((p) => [p.fg, p.bg]));
  return [...tokens.keys()]
    .filter((t) => t.startsWith("--color-"))
    .filter((t) => !used.has(t) && !(t in file.exempt))
    .sort();
}

/** Every problem, as human-readable lines. Empty means the gate passes. */
export function contrastProblems(css: string, file: PairsFile): string[] {
  const tokens = parseTokens(css);
  const problems: string[] = [];
  for (const r of checkPairs(tokens, file.pairs)) {
    if (!r.ok) {
      problems.push(
        `${r.pair.fg} on ${r.pair.bg} is ${r.ratio.toFixed(2)}:1, needs ${r.pair.min}:1 (${r.pair.use})`,
      );
    }
  }
  for (const t of uncheckedColourTokens(tokens, file)) {
    problems.push(`${t} is in no contrast pair and not exempted: add a pair to contrast-pairs.json`);
  }
  for (const [t, why] of Object.entries(file.exempt)) {
    if (!tokens.has(t)) problems.push(`exemption for ${t} names a token that does not exist`);
    if (!why.trim()) problems.push(`exemption for ${t} gives no reason`);
  }
  return problems;
}
