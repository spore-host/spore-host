// The truffle surface: a standalone EC2 instance-type catalog search, offline
// and auth-free. truffle-ts ships pure logic + a bundled catalog (no UI), so this
// mounts a thin search box over find() and renders the ranked results + match
// reasons. No AWS creds, no network — browse/compare before you ever sign in.
//
// Disclosure: at `guided` this surface is NOT a search box at all. A free-text
// query is the wrong first question — "gpu with 80gb for training" is only
// writable by someone who already knows what they need — so guided mode shows the
// curated picker instead. `standard` and up get the query box.
import { find, describePriceOrigin, CATALOG_AS_OF, type FindResult } from "@spore-host/truffle-ts";
import type { Disposable, SurfaceContext, ToolSurface } from "./types.js";
import { describeFindError } from "../finderror.js";
import { priceFor } from "../pricing.js";
import { atLeast, type DisclosureLevel } from "../disclosure.js";
import { mountGuidedPicker } from "../guided/picker.js";
import { readHashParam, writeHashParams } from "../hashstate.js";

export const truffleSurface: ToolSurface = {
  id: "truffle",
  label: "Find instances",
  accent: "--truffle",
  requiresAuth: false,

  async mount(host: HTMLElement, ctx: SurfaceContext): Promise<Disposable> {
    if (!atLeast(ctx.level, "standard")) {
      return mountGuided(host, ctx);
    }
    const root = document.createElement("div");
    root.className = "truffle-surface";
    root.innerHTML = `
      <div class="truffle-search">
        <h2>Find an instance type</h2>
        <!-- Examples must be queries that actually work today. "gpu with 80gb for
             training" was pulled from this list because it silently returned
             CPU-only Graviton instances: bare "gpu" parsed to an unknown token and
             "80gb" filtered system RAM, not VRAM. truffle-ts#37/#38 fixed both in
             0.5.0 (bare "gpu" now sets requireGpu, and a bare memory figure beside
             it reads as VRAM **per card**), so it's restored — it's the example
             worth leading with, being the one a researcher would actually type. -->
        <p class="truffle-hint">Natural language — e.g. <code>gpu with 80gb for training</code>,
          <code>nvidia h100</code>, <code>8 gpus a100</code>, <code>32 vcpus arm</code>.
          Offline catalog (as of ${escapeHtml(CATALOG_AS_OF)}); prices are static
          figures for <b>${escapeHtml(ctx.session.region)}</b>.</p>
        <form class="truffle-form">
          <input class="truffle-q" type="search" placeholder="describe what you need…" autocomplete="off" />
          <button type="submit">Search</button>
        </form>
      </div>
      <div class="truffle-results" aria-live="polite"></div>`;
    host.appendChild(root);

    const form = root.querySelector<HTMLFormElement>(".truffle-form")!;
    const input = root.querySelector<HTMLInputElement>(".truffle-q")!;
    const results = root.querySelector<HTMLElement>(".truffle-results")!;

    // Guard against out-of-order async results if the user searches rapidly.
    let seq = 0;
    async function run(query: string): Promise<void> {
      const mine = ++seq;
      if (!query.trim()) {
        results.innerHTML = "";
        return;
      }
      results.innerHTML = `<div class="truffle-status">searching…</div>`;
      try {
        const found = await find(query);
        if (mine !== seq) return; // a newer search superseded this one
        renderResults(results, found, ctx.level, ctx.session.region);
      } catch (err) {
        if (mine !== seq) return;
        results.innerHTML = findErrorHtml(err);
      }
    }

    const onSubmit = (e: Event) => {
      e.preventDefault();
      writeHashParams({ q: input.value.trim() || null });
      void run(input.value);
    };
    form.addEventListener("submit", onSubmit);

    // Restore a query from the hash and re-run it.
    //
    // This is the state loss that mattered most, and it's the *common* path: type a
    // query, get rows, want the expert detail on them, raise the mode → the shell
    // re-mounts this surface with an empty box and the query gone. The mode change is
    // most often triggered at exactly that moment, on exactly those results.
    const initialQ = readHashParam("q");
    if (initialQ) {
      input.value = initialQ;
      void run(initialQ);
    }

    return {
      dispose() {
        form.removeEventListener("submit", onSubmit);
        root.remove();
      },
    };
  },
};

/**
 * Guided mode: the curated picker instead of a query box.
 *
 * Choosing a shape here can't launch anything — this surface is auth-free by
 * design and there's no session to launch into — so it hands the user to the
 * instances surface, which mounts the same picker with a live client behind it.
 */
function mountGuided(host: HTMLElement, ctx: SurfaceContext): Disposable {
  const root = document.createElement("div");
  root.className = "truffle-surface guided";
  host.appendChild(root);

  const dispose = mountGuidedPicker(root, {
    region: ctx.session.region,
    // Carry the chosen shape across. Navigating bare discarded the GuidedChoice, so
    // "A big GPU for training" landed the user on a fresh picker demanding the same
    // choice they had just made (or, unsigned-in, on a sign-in gate that forgets it).
    // The shape id in the hash survives both.
    onChoose: (choice) => ctx.navigate(`instances?shape=${encodeURIComponent(choice.shape.id)}`),
    // The escape hatch raises the level rather than navigating: the user is saying
    // "show me more", and the query box is one level up on this very surface.
    onEscape: () => ctx.session.setLevel("standard"),
  });

  return {
    dispose() {
      dispose();
      root.remove();
    },
  };
}

/**
 * A `find()` failure, as the error line and, under it, the parser's hint.
 *
 * From truffle-ts 0.6 a query of only unknown words (`zzqx`) throws
 * `UnrecognizedQueryError` rather than returning all 231 types, so this is now a
 * state a user reaches by mistyping. Its message is "what was wrong" then "try a
 * vendor (…)"; one run of text made the hint read as part of the error.
 */
function findErrorHtml(err: unknown): string {
  const e = describeFindError(err);
  const lead = e.unrecognized ? "Couldn't read that query: " : "";
  const suggest = e.suggestions.length
    ? `<div class="truffle-status hint">Did you mean ${e.suggestions
        .map(([from, to]) => `<code>${escapeHtml(to)}</code> for <code>${escapeHtml(from)}</code>`)
        .join(", ")}?</div>`
    : "";
  const hint = e.hint ? `<div class="truffle-status hint">${escapeHtml(e.hint)}</div>` : "";
  return `<div class="truffle-status error">${escapeHtml(lead + e.message)}</div>${suggest}${hint}`;
}

function renderResults(host: HTMLElement, found: FindResult[], level: DisclosureLevel, region: string): void {
  if (found.length === 0) {
    host.innerHTML = `<div class="truffle-status">no matches — try relaxing the query</div>`;
    return;
  }
  const expert = atLeast(level, "expert");
  const shown = found.slice(0, 50);
  // Every price here is static, and a static price must say so, why and when it was
  // collected. The label is long, so each distinct one is printed once under the table
  // and each price carries its footnote number, rather than repeating it on 50 rows.
  // An unknown price gets a footnote too: "—" alone doesn't say whether the type is
  // unpriced everywhere or only in this region.
  const notes: string[] = [];
  const noteFor = (label: string): number => {
    const at = notes.indexOf(label);
    if (at >= 0) return at + 1;
    notes.push(label);
    return notes.length;
  };
  const rows = shown
    .map((r) => {
      const i = r.instance;
      const gib = (i.memoryMib / 1024).toFixed(i.memoryMib % 1024 === 0 ? 0 : 1);
      const quote = priceFor(i, region);
      const label = describePriceOrigin(quote.origin);
      const n = noteFor(label);
      const price = `${quote.price != null ? `$${quote.price.toFixed(4)}/hr` : "—"}<sup>${n}</sup>`;
      const gpu = i.gpus ? `${i.gpus}× ${escapeHtml(i.gpuModel ?? "GPU")}` : "";
      const reasons = r.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
      // Expert gets the fields a capacity/topology decision actually turns on —
      // physical cores vs threads (an MPI rank count is cores, not vCPUs), the GPU
      // vendor + VRAM (a framework requirement, not a preference), the family for
      // a quota lookup, and nested-virt support. They're in the catalog already;
      // standard hides them because they're noise to someone comparing two boxes.
      const detail = expert ? `<dl class="truffle-detail">${expertFields(r, label)}</dl>` : "";
      return `
        <div class="truffle-row">
          <div class="truffle-row-head">
            <span class="truffle-type">${escapeHtml(i.instanceType)}</span>
            <span class="truffle-specs">${i.vcpus} vCPU · ${gib} GiB · ${escapeHtml(i.architecture)}${gpu ? " · " + gpu : ""}</span>
            <span class="truffle-price" title="${escapeHtml(label)}">${price}</span>
          </div>
          <ul class="truffle-reasons">${reasons}</ul>
          ${detail}
        </div>`;
    })
    .join("");
  const legend = `<ol class="truffle-note">${notes
    .map((l) => `<li>${escapeHtml(region)} on-demand price: ${escapeHtml(l)}</li>`)
    .join("")}</ol>`;
  host.innerHTML = `<div class="truffle-count">${found.length} match${found.length === 1 ? "" : "es"}${found.length > 50 ? " (showing 50)" : ""}</div>${rows}${legend}`;
}

/**
 * The expert-only field list for one result.
 *
 * Only fields the catalog actually carries are rendered. An absent field is
 * omitted rather than shown as "—" or 0: `physicalCores` is genuinely unknown for
 * some entries, and printing a zero there would state something false about the
 * hardware to the one user most likely to act on it.
 */
function expertFields(r: FindResult, priceLabel: string): string {
  const i = r.instance;
  const rows: Array<[string, string]> = [["family", i.instanceFamily]];
  if (i.physicalCores != null) rows.push(["physical cores", String(i.physicalCores)]);
  if (i.threadsPerCore != null) rows.push(["threads/core", String(i.threadsPerCore)]);
  rows.push(["memory", `${i.memoryMib} MiB`]);
  if (i.gpuManufacturer) rows.push(["GPU vendor", i.gpuManufacturer]);
  if (i.gpuMemoryMib != null) rows.push(["GPU memory", `${i.gpuMemoryMib} MiB (total)`]);
  if (i.nestedVirt != null) rows.push(["nested virt", i.nestedVirt ? "yes" : "no"]);
  // Say where the price came from, in full on the row itself. This used to read
  // "live AWS pull" for every catalog entry, which was false: the bundled catalog is
  // a static snapshot, and nothing on this surface calls the Price List.
  rows.push(["price source", priceLabel]);
  return rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
