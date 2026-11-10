// The CLI⇄GUI matrix check (#645: "a GUI control with no CLI command fails,
// and a basic CLI command with no GUI entry fails"). Pure functions over the
// matrix, the generated CLI reference and the set of controls the app
// rendered. The static half runs in gates/matrix-static.test.ts; the rendered
// half in e2e/matrix.spec.ts, which collects data-control ids from every route.

/** Slice issues a basic row may be pending on (spore-host/spore-host). */
export const SLICE_ISSUES: ReadonlySet<number> = new Set([684, 685, 686, 687, 688, 689]);

export interface MatrixRow {
  id: string;
  cli: string;
  flags?: string[];
  level: "basic" | "advanced";
  gui: string[];
  pending?: number;
  note?: string;
}

export interface Matrix {
  rows: MatrixRow[];
  chrome: Record<string, string>;
}

/** Reads a generated CLI reference file: `docs/gen/<cli>/<file>.md`. Returns null when missing. */
export type DocReader = (cli: string, file: string) => string | null;

function chromeIds(m: Matrix): string[] {
  return Object.keys(m.chrome).filter((k) => !k.startsWith("$"));
}

/** Structure: unique ids, one row per control, valid pending, chrome reasons. */
export function structuralProblems(m: Matrix): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const owner = new Map<string, string>();
  const chrome = new Set(chromeIds(m));
  for (const r of m.rows) {
    if (ids.has(r.id)) out.push(`row id "${r.id}" is used twice`);
    ids.add(r.id);
    if (!/^(spawn|truffle|lagotto) [a-z][a-z-]*( [a-z][a-z-]*)?$/.test(r.cli)) out.push(`row "${r.id}": "${r.cli}" is not a spawn, truffle or lagotto command`);
    if (r.level !== "basic" && r.level !== "advanced") out.push(`row "${r.id}": level must be basic or advanced`);
    if (r.pending !== undefined && !SLICE_ISSUES.has(r.pending)) {
      out.push(`row "${r.id}": pending ${r.pending} is not a slice issue (${[...SLICE_ISSUES].join(", ")})`);
    }
    for (const c of r.gui) {
      if (chrome.has(c)) out.push(`control "${c}" is both chrome and in row "${r.id}"`);
      const prev = owner.get(c);
      if (prev && prev !== r.id) out.push(`control "${c}" is in rows "${prev}" and "${r.id}"; one control maps to one command`);
      owner.set(c, r.id);
    }
    if (r.level === "basic" && r.gui.length === 0 && r.pending === undefined) {
      out.push(`basic row "${r.id}" (${r.cli}) has no GUI control and is not pending on a slice`);
    }
  }
  for (const k of chromeIds(m)) if (!m.chrome[k]?.trim()) out.push(`chrome control "${k}" gives no reason`);
  return out;
}

/** The section of a generated reference file under `## \`<command>\``, up to the next heading of any level. */
export function commandSection(doc: string, command: string): string | null {
  const lines = doc.split("\n");
  const heading = (l: string) => (/^#{2,4} `/.test(l) ? l.replace(/^#{2,4} /, "").trim() : null);
  const start = lines.findIndex((l) => heading(l) === `\`${command}\``);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (heading(lines[i]) !== null) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Every row's command and flags exist in the generated CLI reference. */
export function cliProblems(m: Matrix, read: DocReader): string[] {
  const out: string[] = [];
  for (const r of m.rows) {
    const [cli, top] = r.cli.split(" ");
    const doc = read(cli, top);
    if (doc === null) {
      out.push(`row "${r.id}": no generated reference for "${cli} ${top}" (docs/gen/${cli}/${top}.md)`);
      continue;
    }
    const section = commandSection(doc, r.cli);
    if (section === null) {
      out.push(`row "${r.id}": "${r.cli}" is not documented in docs/gen/${cli}/${top}.md`);
      continue;
    }
    const global = read(cli, "_global-flags") ?? "";
    for (const f of r.flags ?? []) {
      const cell = `| \`${f}\` |`;
      if (!section.includes(cell) && !global.includes(cell)) out.push(`row "${r.id}": "${r.cli}" has no flag ${f}`);
    }
  }
  return out;
}

/**
 * The rendered half. `observed` maps each control id the app rendered to
 * where it was seen; `unlabelled` lists interactive elements with no
 * data-control at all.
 */
export function renderedProblems(m: Matrix, observed: Map<string, string[]>, unlabelled: string[] = []): string[] {
  const out: string[] = [];
  const known = new Set([...chromeIds(m), ...m.rows.flatMap((r) => r.gui)]);
  // One line per element, not per page it appears on.
  const byWhat = new Map<string, string[]>();
  for (const u of unlabelled) {
    const [what, where = ""] = u.split(" on ");
    byWhat.set(what, [...(byWhat.get(what) ?? []), where].filter(Boolean));
  }
  for (const [what, where] of byWhat) {
    out.push(`interactive element with no data-control: ${what}${where.length ? ` (on ${where.slice(0, 3).join(", ")}${where.length > 3 ? ` and ${where.length - 3} more` : ""})` : ""}`);
  }
  for (const [c, where] of observed) {
    if (!known.has(c)) {
      const shown = where.slice(0, 3).join(", ") + (where.length > 3 ? ` and ${where.length - 3} more` : "");
      out.push(`GUI control "${c}" (on ${shown}) has no CLI row and is not chrome`);
    }
  }
  for (const r of m.rows) {
    if (r.level !== "basic" || r.pending !== undefined) continue;
    const missing = r.gui.filter((c) => !observed.has(c));
    if (r.gui.length === 0) out.push(`basic row "${r.id}" (${r.cli}) has no GUI control`);
    else if (missing.length) out.push(`basic row "${r.id}" (${r.cli}) names controls no route renders: ${missing.join(", ")}`);
  }
  return out;
}
