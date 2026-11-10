// Tokens-only lint (brief §5: "components use tokens only, enforced by a lint
// against raw hex/px/rem outside the token file"). Pure.
//
// Fails on a hex colour, rgb()/hsl(), or a px/rem/em length anywhere in a
// stylesheet except tokens.css. Media and container query conditions are
// exempt, because custom properties cannot appear in them.

export interface RawValue {
  line: number;
  value: string;
  text: string;
}

const RAW = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(|(?<![\w-])-?\d*\.?\d+(?:px|rem|em)\b/gi;

export function rawValues(css: string): RawValue[] {
  const out: RawValue[] = [];
  // Blank out comments but keep line numbers.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  clean.split("\n").forEach((text, i) => {
    if (/^\s*@(media|container|supports)\b/.test(text)) return;
    for (const m of text.matchAll(RAW)) out.push({ line: i + 1, value: m[0], text: text.trim() });
  });
  return out;
}
