// The cost-history surface: your account's spend over time, from the shared
// dashboard-api (GET /api/cost-history?days=N) over the session's federated
// creds. Per-account scoped (the auth fix keys cost rows by the verified
// account). Second Slice 5 feature after the catalog — first one with per-user
// data + a chart.
//
// Dataviz: single series, "trend over time" → area+line, sequential blue
// (#2a78d6 light / #3987e5 dark, both validated ≥3:1 on the portal card
// surfaces). No legend (one series; the title names it). Crosshair + one
// tooltip snapping to the nearest day. KPI row of stat tiles for the current
// values. Days-range presets in one row above. Table view for a11y. Text wears
// ink tokens, never the series hue.
//
// Disclosure: ADDITIVE ONLY. This is the one surface that answers "what am I
// spending?", so nothing is hidden from anyone — guided relabels, expert adds. The
// `.costs-tabletoggle` in particular stays at every level: it's an accessibility
// affordance for the chart, not a density control.
import type { AwsCreds } from "@spore-host/spawn-ts/auth";
import type { Disposable, SurfaceContext, ToolSurface } from "./types.js";
import { atLeast, type DisclosureLevel } from "../disclosure.js";
import { readHashParam, writeHashParams } from "../hashstate.js";

interface CostComponents {
  compute: number;
  storage: number;
  network: number;
}

interface CostPoint {
  timestamp: string;
  hourly_cost: number;
  monthly_estimate: number;
  instance_count: number;
  breakdown: CostComponents;
}

interface CostHistoryResponse {
  success: boolean;
  days?: number;
  history?: CostPoint[];
  error?: string;
}

// Expert gets a year. A 365-day window is the one that answers "is this growing?"
// rather than "what did last month look like", and it's the level that can act on
// the answer. Kept out of the shorter list because four buttons of noise is a cost
// paid by every user for a question only some are asking.
const DAY_PRESETS = [7, 30, 90] as const;
const EXPERT_DAY_PRESETS = [7, 30, 90, 365] as const;
const DEFAULT_DAYS = 30;

function credentialsHeader(creds: AwsCreds): string {
  return btoa(
    JSON.stringify({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    }),
  );
}

export const costsSurface: ToolSurface = {
  id: "costs",
  label: "Cost history",
  accent: "--spawn",
  requiresAuth: true,

  async mount(host: HTMLElement, ctx: SurfaceContext): Promise<Disposable> {
    const creds = ctx.session.getCreds();
    if (!creds) throw new Error("costs surface mounted without a session");

    const level = ctx.level;
    const expert = atLeast(level, "expert");
    const presets = expert ? EXPERT_DAY_PRESETS : DAY_PRESETS;

    // Restored from the hash so a mode change (which re-mounts this surface) doesn't
    // silently reset the window the user chose and the view they were reading.
    const urlDays = Number(readHashParam("days"));
    let days = presets.includes(urlDays as never) ? urlDays : DEFAULT_DAYS;
    let showTable = readHashParam("table") === "1";

    const root = document.createElement("div");
    root.className = "costs-surface";
    root.innerHTML = `
      <div class="costs-head">
        <h2>Cost history</h2>
        <p class="costs-hint">${
          atLeast(level, "standard")
            ? `Estimated hourly spend across your account, from the
               shared dashboard-api over your federated session.`
            : `What your account is spending on machines. Estimated from what's
               running — not a bill from AWS.`
        }</p>
      </div>
      <div class="costs-controls" role="group" aria-label="Time range">
        ${presets
          .map(
            (d) =>
              `<button type="button" class="costs-range" data-days="${d}" aria-pressed="${d === days}">${
                d === 365 ? "1y" : `${d}d`
              }</button>`,
          )
          .join("")}
        <button type="button" class="costs-tabletoggle" aria-pressed="${showTable}">Table</button>
      </div>
      <div class="costs-kpis" aria-live="polite"></div>
      <div class="costs-body" aria-live="polite"><div class="costs-status">loading…</div></div>
      ${
        atLeast(level, "standard")
          ? ""
          : // A cost figure with no adjacent way to ACT on it is where a guided user
            // gets stuck: they can see they're spending money and not what to do
            // about it. The instance list is where you stop things.
            `<p class="costs-act">To stop something that's running, go to
             <button type="button" class="costs-goinstances">Instances</button>.</p>`
      }`;
    host.appendChild(root);

    const controls = root.querySelector<HTMLElement>(".costs-controls")!;
    const kpis = root.querySelector<HTMLElement>(".costs-kpis")!;
    const body = root.querySelector<HTMLElement>(".costs-body")!;

    const goInstances = root.querySelector<HTMLButtonElement>(".costs-goinstances");
    const onGo = () => ctx.navigate("instances");
    goInstances?.addEventListener("click", onGo);
    let last: CostPoint[] = [];
    let controller: AbortController | null = null;
    let seq = 0;

    async function load(): Promise<void> {
      const mine = ++seq;
      controller?.abort();
      controller = new AbortController();
      // Refetch keeps the frame: dim the prior render rather than clearing.
      body.style.opacity = last.length ? "0.5" : "1";
      if (!last.length) body.innerHTML = `<div class="costs-status">loading…</div>`;
      try {
        const resp = await fetch(`${ctx.config.apiBase}/api/cost-history?days=${days}`, {
          method: "GET",
          headers: { "X-AWS-Credentials": credentialsHeader(creds!) },
          signal: controller.signal,
        });
        if (mine !== seq) return;
        if (!resp.ok) {
          const detail = resp.status === 401 ? "authentication failed" : `HTTP ${resp.status}`;
          body.style.opacity = "1";
          body.innerHTML = `<div class="costs-status error">Couldn't load cost history (${escapeHtml(detail)}).</div>`;
          kpis.innerHTML = "";
          return;
        }
        const data = (await resp.json()) as CostHistoryResponse;
        if (mine !== seq) return;
        body.style.opacity = "1";
        if (!data.success || !data.history) {
          body.innerHTML = `<div class="costs-status error">${escapeHtml(data.error ?? "no data returned")}</div>`;
          kpis.innerHTML = "";
          return;
        }
        last = data.history;
        render();
      } catch (err) {
        if (controller?.signal.aborted || mine !== seq) return;
        body.style.opacity = "1";
        body.innerHTML = `<div class="costs-status error">${escapeHtml((err as Error).message)}</div>`;
      }
    }

    function render(): void {
      renderKpis(kpis, last, level);
      if (!last.length) {
        body.innerHTML = `<div class="costs-status">No cost history yet for this account.</div>`;
        return;
      }
      body.innerHTML = "";
      body.appendChild(showTable ? buildTable(last, expert) : buildChart(last, expert));
      if (expert) body.appendChild(buildProvenance(last, days, ctx.config.apiBase));
    }

    const onControlsClick = (e: Event) => {
      const btn = (e.target as HTMLElement).closest("button");
      if (!btn) return;
      if (btn.classList.contains("costs-range")) {
        const d = Number(btn.dataset.days);
        if (d && d !== days) {
          days = d;
          for (const b of controls.querySelectorAll<HTMLButtonElement>(".costs-range")) {
            b.setAttribute("aria-pressed", String(Number(b.dataset.days) === days));
          }
          writeHashParams({ days: d === DEFAULT_DAYS ? null : String(d) });
          void load();
        }
      } else if (btn.classList.contains("costs-tabletoggle")) {
        showTable = !showTable;
        btn.setAttribute("aria-pressed", String(showTable));
        writeHashParams({ table: showTable ? "1" : null });
        render();
      }
    };
    controls.addEventListener("click", onControlsClick);

    const offExpiry = ctx.session.onExpiry((state) => {
      if (state === "expired") {
        body.innerHTML = `<div class="costs-status error">Session expired — sign in again to reload.</div>`;
      }
    });

    void load();

    return {
      dispose() {
        offExpiry();
        controls.removeEventListener("click", onControlsClick);
        goInstances?.removeEventListener("click", onGo);
        controller?.abort();
        root.remove();
      },
    };
  },
};

// ── KPI row ──────────────────────────────────────────────────────────────────
/**
 * The stat tiles.
 *
 * `monthly_estimate` is `hourly × 730` — a projection of the current instant, not a
 * sum of anything that happened. "Monthly estimate" is read as a bill owed, which is
 * the portal's most expensive misreading: it's wrong in both directions (a machine
 * shut down an hour from now will never cost that, and one launched tomorrow isn't
 * in it). Guided phrases it as the conditional it is. Standard and expert keep the
 * shorter label — they have the chart beside it to read the number against.
 */
function renderKpis(host: HTMLElement, history: CostPoint[], level: DisclosureLevel): void {
  if (!history.length) {
    host.innerHTML = "";
    return;
  }
  const latest = history[history.length - 1]!;
  const tiles: { label: string; value: string; note?: string }[] = atLeast(level, "standard")
    ? [
        { label: "Current hourly cost", value: fmtUsd(latest.hourly_cost) },
        { label: "Monthly estimate", value: fmtUsd(latest.monthly_estimate) },
        { label: "Instances", value: String(latest.instance_count) },
      ]
    : [
        { label: "Running right now", value: `${fmtUsd(latest.hourly_cost)}/hr` },
        { label: "If it keeps running", value: `${fmtUsd(latest.monthly_estimate)} a month` },
        { label: "Machines running", value: String(latest.instance_count) },
      ];

  // Expert gets the two figures the single latest row cannot answer: what the window
  // actually cost, and what the worst hour in it was. The existing tiles all read
  // history[length-1], so "is this growing / did something spike" is unanswerable
  // from them — and that's the question a 90-day or 1-year window is opened to ask.
  if (atLeast(level, "expert")) {
    const hours = history.map((p) => p.hourly_cost);
    const peak = Math.max(...hours);
    const peakAt = history[hours.indexOf(peak)]!;
    // Each point is one sample, not one hour, so summing hourly_cost would be
    // summing rates. Mean rate × elapsed hours is the honest window total, and
    // labelled as approximate because the sampling interval is the API's choice.
    const spanMs = new Date(history[history.length - 1]!.timestamp).getTime() - new Date(history[0]!.timestamp).getTime();
    const spanHours = spanMs > 0 ? spanMs / 3_600_000 : 0;
    const mean = hours.reduce((a, b) => a + b, 0) / hours.length;
    tiles.push(
      { label: "Window total (approx)", value: spanHours > 0 ? `~${fmtUsd(mean * spanHours)}` : "—" },
      // The date is a `note`, not appended to the value: at 1.5rem in a 140px tile
      // `$4.25 · Jul 12` wraps to "$4.25 · Jul" / "12", which reads as a broken
      // number. It's metadata about the peak, not part of the figure.
      { label: "Peak hourly", value: fmtUsd(peak), note: fmtDate(peakAt.timestamp) },
    );
  }

  host.innerHTML = tiles
    .map(
      (t) => `
      <div class="costs-tile">
        <div class="costs-tile-label">${escapeHtml(t.label)}</div>
        <div class="costs-tile-value">${escapeHtml(t.value)}</div>
        ${t.note ? `<div class="costs-tile-note">${escapeHtml(t.note)}</div>` : ""}
      </div>`,
    )
    .join("");
}

// ── Area + line chart (SVG) ────────────────────────────────────────────────────
function buildChart(history: CostPoint[], expert = false): SVGSVGElement {
  const W = 720;
  const H = 300;
  const M = { top: 16, right: 20, bottom: 28, left: 56 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const xs = history.map((_, i) => i);
  const ys = history.map((p) => p.hourly_cost);
  const maxY = Math.max(...ys, 0.0001);
  const niceMax = niceCeil(maxY);
  const n = history.length;

  const x = (i: number) => M.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => M.top + ih - (v / niceMax) * ih;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "costs-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Hourly cost over ${n} points`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // Gridlines + y ticks (hairline, muted ink).
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const val = (niceMax / ticks) * t;
    const gy = y(val);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", String(M.left));
    line.setAttribute("x2", String(M.left + iw));
    line.setAttribute("y1", String(gy));
    line.setAttribute("y2", String(gy));
    line.setAttribute("class", "costs-grid");
    svg.appendChild(line);
    const lbl = document.createElementNS(svgNS, "text");
    lbl.setAttribute("x", String(M.left - 8));
    lbl.setAttribute("y", String(gy + 4));
    lbl.setAttribute("text-anchor", "end");
    lbl.setAttribute("class", "costs-axis");
    lbl.textContent = fmtAxis(val, niceMax);
    svg.appendChild(lbl);
  }

  // Area fill (~10% opacity wash) + 2px line.
  const linePath = xs.map((i) => `${i === 0 ? "M" : "L"}${x(i)},${y(ys[i]!)}`).join(" ");
  const areaPath = `${linePath} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const area = document.createElementNS(svgNS, "path");
  area.setAttribute("d", areaPath);
  area.setAttribute("class", "costs-area");
  svg.appendChild(area);
  const line = document.createElementNS(svgNS, "path");
  line.setAttribute("d", linePath);
  line.setAttribute("class", "costs-line");
  line.setAttribute("fill", "none");
  svg.appendChild(line);

  // End marker (≥8px) with a 2px surface ring.
  const end = document.createElementNS(svgNS, "circle");
  end.setAttribute("cx", String(x(n - 1)));
  end.setAttribute("cy", String(y(ys[n - 1]!)));
  end.setAttribute("r", "4.5");
  end.setAttribute("class", "costs-endmarker");
  svg.appendChild(end);

  // X axis labels: first + last date only (selective).
  const firstLbl = document.createElementNS(svgNS, "text");
  firstLbl.setAttribute("x", String(x(0)));
  firstLbl.setAttribute("y", String(H - 8));
  firstLbl.setAttribute("text-anchor", "start");
  firstLbl.setAttribute("class", "costs-axis");
  firstLbl.textContent = fmtDate(history[0]!.timestamp);
  svg.appendChild(firstLbl);
  if (n > 1) {
    const lastLbl = document.createElementNS(svgNS, "text");
    lastLbl.setAttribute("x", String(x(n - 1)));
    lastLbl.setAttribute("y", String(H - 8));
    lastLbl.setAttribute("text-anchor", "end");
    lastLbl.setAttribute("class", "costs-axis");
    lastLbl.textContent = fmtDate(history[n - 1]!.timestamp);
    svg.appendChild(lastLbl);
  }

  // Crosshair + tooltip layer.
  const crosshair = document.createElementNS(svgNS, "line");
  crosshair.setAttribute("class", "costs-crosshair");
  crosshair.setAttribute("y1", String(M.top));
  crosshair.setAttribute("y2", String(M.top + ih));
  crosshair.style.display = "none";
  svg.appendChild(crosshair);

  const focusDot = document.createElementNS(svgNS, "circle");
  focusDot.setAttribute("r", "4.5");
  focusDot.setAttribute("class", "costs-focusdot");
  focusDot.style.display = "none";
  svg.appendChild(focusDot);

  const tip = document.createElement("div");
  tip.className = "costs-tip";
  tip.style.display = "none";

  const wrap = document.createElement("div");
  wrap.className = "costs-chartwrap";
  wrap.appendChild(svg);
  wrap.appendChild(tip);

  const nearestIndex = (clientX: number): number => {
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W; // back to viewBox space
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const showAt = (i: number) => {
    const p = history[i]!;
    const cx = x(i);
    const cy = y(p.hourly_cost);
    crosshair.setAttribute("x1", String(cx));
    crosshair.setAttribute("x2", String(cx));
    crosshair.style.display = "";
    focusDot.setAttribute("cx", String(cx));
    focusDot.setAttribute("cy", String(cy));
    focusDot.style.display = "";
    tip.replaceChildren();
    const val = document.createElement("div");
    val.className = "costs-tip-val";
    val.textContent = `${fmtUsd(p.hourly_cost)}/hr`;
    const meta = document.createElement("div");
    meta.className = "costs-tip-meta";
    meta.textContent = `${fmtDate(p.timestamp)} · ${p.instance_count} instance${p.instance_count === 1 ? "" : "s"}`;
    tip.appendChild(val);
    tip.appendChild(meta);
    // The API has always returned compute/storage/network per point and the UI has
    // always dropped it. It's the difference between "spend is up" and "spend is up
    // because of storage, which shutting an instance down will not fix" — so it goes
    // where the number it explains already is.
    if (expert && p.breakdown) {
      const b = document.createElement("div");
      b.className = "costs-tip-breakdown";
      b.textContent = `compute ${fmtUsd(p.breakdown.compute)} · storage ${fmtUsd(
        p.breakdown.storage,
      )} · network ${fmtUsd(p.breakdown.network)}`;
      tip.appendChild(b);
    }
    // Position in wrap pixel space (viewBox → wrap ratio).
    const ratio = wrap.clientWidth / W || 1;
    tip.style.display = "";
    const tipX = cx * ratio + 12;
    const tipY = cy * (wrap.clientHeight / H || 1) - 8;
    tip.style.left = `${Math.min(tipX, wrap.clientWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(0, tipY)}px`;
  };
  const hide = () => {
    crosshair.style.display = "none";
    focusDot.style.display = "none";
    tip.style.display = "none";
  };

  svg.addEventListener("pointermove", (e) => showAt(nearestIndex(e.clientX)));
  svg.addEventListener("pointerleave", hide);

  // Return the wrap as if it were the SVG (caller appends it).
  return wrap as unknown as SVGSVGElement;
}

// ── Table view (a11y / non-visual) ─────────────────────────────────────────────
function buildTable(history: CostPoint[], expert = false): HTMLElement {
  const table = document.createElement("table");
  table.className = "costs-table";
  const thead = document.createElement("thead");
  // The table is the a11y path to the chart, so it carries whatever the chart's
  // tooltip carries — otherwise the breakdown would be mouse-only.
  const extra = expert ? `<th>Compute</th><th>Storage</th><th>Network</th>` : "";
  thead.innerHTML = `<tr><th>Date</th><th>Hourly</th><th>Monthly est.</th><th>Instances</th>${extra}</tr>`;
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const p of history) {
    const tr = document.createElement("tr");
    const cells = [fmtDate(p.timestamp), fmtUsd(p.hourly_cost), fmtUsd(p.monthly_estimate), String(p.instance_count)];
    if (expert) {
      // An absent breakdown is "—", not $0.00: zero storage cost is a claim about
      // the account, and a missing field isn't evidence for it.
      cells.push(
        p.breakdown ? fmtUsd(p.breakdown.compute) : "—",
        p.breakdown ? fmtUsd(p.breakdown.storage) : "—",
        p.breakdown ? fmtUsd(p.breakdown.network) : "—",
      );
    }
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c; // untrusted data → textContent
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/**
 * Where the series came from and how densely it's sampled.
 *
 * Expert-only because it's only actionable if you know what to do with it: the chart
 * looks like a continuous line but is N discrete samples the API chose the spacing
 * of, so a spike between samples is invisible. Someone reading this can go ask the
 * endpoint directly; at standard it would be noise.
 */
function buildProvenance(history: CostPoint[], days: number, apiBase: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "costs-provenance";
  const spanMs =
    new Date(history[history.length - 1]!.timestamp).getTime() -
    new Date(history[0]!.timestamp).getTime();
  const everyH = history.length > 1 && spanMs > 0 ? spanMs / 3_600_000 / (history.length - 1) : 0;
  const cadence = everyH > 0 ? `, ~1 sample every ${everyH < 1 ? `${Math.round(everyH * 60)} min` : `${everyH.toFixed(1)} h`}` : "";
  p.textContent = `${history.length} sample${history.length === 1 ? "" : "s"} over ${days} days${cadence} — GET ${apiBase}/api/cost-history?days=${days}`;
  return p;
}

// ── helpers ────────────────────────────────────────────────────────────────────
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function fmtUsd(v: number): string {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

// Axis ticks use ONE consistent precision across the whole scale (driven by the
// axis max), so ticks don't mix $0.5000 with $1.00. Clean, comma'd, tabular.
function fmtAxis(v: number, axisMax: number): string {
  const decimals = axisMax >= 100 ? 0 : axisMax >= 1 ? 2 : 4;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
