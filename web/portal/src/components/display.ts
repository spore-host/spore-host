// Display components: Card, StatTile, Table, StatusPill, TimeLeftBar, Alert,
// EmptyState, ErrorState, Skeleton, StatusPanel, CommandLine (brief §5).
//
// None of them is a live region. Status messages go through the shell's one
// polite and one assertive region (shell/announce.ts, SC 4.1.3), so a list
// that refreshes never re-reads itself and a countdown never chatters.
import { button, type ButtonOpts } from "./controls.js";
import { h, icon, uid, type Child } from "./dom.js";
import { formatAgo, formatClock, formatDuration } from "../lib/format.js";
import { supportDetails, type CatalogueEntry } from "../copy/errors.js";
import { announce } from "../shell/announce.js";

type HeadingLevel = 2 | 3 | 4;

function heading(level: HeadingLevel, text: string, cls: string, id?: string): HTMLHeadingElement {
  return h(`h${level}` as "h2", { class: cls, id }, text);
}

export function card(o: { heading?: string; level?: HeadingLevel; children: Child[]; tag?: "section" | "article" | "div" }): HTMLElement {
  const id = o.heading ? uid("card") : undefined;
  return h(
    o.tag ?? "section",
    // Only an article is labelled by its heading: a labelled <section> becomes a
    // region landmark, and a page of cards would then be a page of landmarks.
    { class: "card", "aria-labelledby": o.tag === "article" ? id : undefined },
    o.heading ? heading(o.level ?? 2, o.heading, "card-heading", id) : null,
    ...o.children,
  );
}

/** A labelled figure: "Spending now · $2.88 an hour". A description list, so label and value are read together. */
export function statTile(o: { label: string; value: string; note?: string }): HTMLDivElement {
  return h(
    "div",
    { class: "stat-tile" },
    h("dl", {}, h("dt", { class: "stat-label" }, o.label), h("dd", { class: "stat-value" }, o.value)),
    o.note ? h("p", { class: "stat-note" }, o.note) : null,
  );
}

export interface TableColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

/**
 * A data table that stacks into label/value cards on narrow screens (SC
 * 1.4.10). Each cell carries its column label in data-label for the stacked
 * view; the real header row stays in the DOM for screen readers.
 */
export function table(o: { caption: string; columns: TableColumn[]; rows: Record<string, Child>[]; rowKey?: string }): HTMLDivElement {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "table" },
      h("caption", { class: "table-caption" }, o.caption),
      h("thead", {}, h("tr", {}, ...o.columns.map((c) => h("th", { scope: "col", class: c.numeric ? "num" : undefined }, c.label)))),
      h(
        "tbody",
        {},
        ...o.rows.map((r) =>
          h(
            "tr",
            { data: { rowKey: o.rowKey ? String(r[o.rowKey] ?? "") : undefined } },
            ...o.columns.map((c) => h("td", { class: c.numeric ? "num" : undefined, data: { label: c.label } }, r[c.key])),
          ),
        ),
      ),
    ),
  );
}

export type InstanceStatus = "starting" | "running" | "stopping" | "stopped" | "terminating" | "attention";

const STATUS_WORDS: Record<InstanceStatus, { label: string; tone: "success" | "neutral" | "warning" | "danger" | "info" }> = {
  starting: { label: "Starting", tone: "info" },
  running: { label: "Running", tone: "success" },
  stopping: { label: "Stopping", tone: "neutral" },
  stopped: { label: "Stopped", tone: "neutral" },
  terminating: { label: "Terminating", tone: "neutral" },
  attention: { label: "Needs attention", tone: "danger" },
};

/** A dot plus words. Never colour alone (SC 1.4.1). */
export function statusPill(status: InstanceStatus): HTMLSpanElement {
  const s = STATUS_WORDS[status];
  return h("span", { class: `pill pill-${s.tone}` }, h("span", { class: "pill-dot", "aria-hidden": "true" }), s.label);
}

/** Thresholds where the bar turns amber, then red (brief §4 Flow B). */
export const TIME_LEFT_WARN_MS = 30 * 60 * 1000;
export const TIME_LEFT_DANGER_MS = 10 * 60 * 1000;

export function timeLeftTone(msLeft: number): "neutral" | "warning" | "danger" {
  if (msLeft <= TIME_LEFT_DANGER_MS) return "danger";
  if (msLeft <= TIME_LEFT_WARN_MS) return "warning";
  return "neutral";
}

/**
 * "Terminated in 5 h 29 min (4:15 pm)" over a bar. The words carry the
 * meaning; the bar is decoration and hidden from screen readers.
 */
export function timeLeftBar(o: { deadline: Date; totalMs: number; now?: number; timeZone?: string }): HTMLDivElement {
  const now = o.now ?? Date.now();
  const left = Math.max(0, o.deadline.getTime() - now);
  const tone = timeLeftTone(left);
  const pct = o.totalMs > 0 ? Math.min(100, Math.max(0, (left / o.totalMs) * 100)) : 0;
  const words = left === 0 ? `Terminating now (time limit ${formatClock(o.deadline, o.timeZone)})` : `Terminated in ${formatDuration(left)} (${formatClock(o.deadline, o.timeZone)})`;
  return h(
    "div",
    { class: `time-left time-left-${tone}` },
    h("p", { class: "time-left-text" }, words),
    h("div", { class: "time-left-track", "aria-hidden": "true" }, h("div", { class: "time-left-fill", style: `inline-size: ${pct.toFixed(1)}%` })),
  );
}

export type Tone = "info" | "warning" | "danger" | "success";

export interface AlertOpts {
  tone: Tone;
  title: string;
  body?: Child;
  action?: ButtonOpts;
  /** An id for the title, so a containing region can be labelled by it. */
  titleId?: string;
}

/**
 * An inline alert. Static: it is NOT role=alert. A page that needs the
 * message announced calls announce() as well, once. The icon is decorative;
 * the title says what kind of message it is.
 */
export function alert(o: AlertOpts): HTMLDivElement {
  const titleId = o.titleId ?? uid("alert-title");
  return h(
    "div",
    { class: `alert alert-${o.tone}`, role: "group", "aria-labelledby": titleId },
    icon(o.tone === "warning" ? "warning" : o.tone === "danger" ? "danger" : o.tone === "success" ? "success" : "info"),
    h(
      "div",
      { class: "alert-content" },
      h("p", { class: "alert-title", id: titleId }, o.title),
      o.body ? h("div", { class: "alert-body" }, o.body) : null,
      o.action ? h("div", { class: "alert-actions" }, button(o.action)) : null,
    ),
  );
}

export function emptyState(o: { title: string; body: string; action?: Child; level?: HeadingLevel }): HTMLDivElement {
  return h("div", { class: "empty-state" }, heading(o.level ?? 2, o.title, "empty-title"), h("p", { class: "empty-body" }, o.body), o.action ?? null);
}

/**
 * A failure in three parts: what happened, why, what to do; raw detail under
 * "Details for support" (brief §6 rule 5). Never rendered as empty or $0.
 * `context` is the sentence that says what the failure means for the user's
 * money or work, e.g. "Your instances may still be running and costing money."
 */
export function errorState(o: {
  entry: CatalogueEntry;
  error: unknown;
  control: string;
  context?: string;
  onAction?: () => void;
  level?: HeadingLevel;
}): HTMLDivElement {
  return h(
    "div",
    { class: "error-state" },
    heading(o.level ?? 2, o.entry.title, "error-title"),
    o.context ? h("p", { class: "error-context" }, o.context) : null,
    h("p", { class: "error-cause" }, o.entry.cause),
    h("div", { class: "error-actions" }, button({ label: o.entry.action.label, control: o.control, variant: "primary", onClick: o.onAction })),
    h(
      "details",
      { class: "details", data: { copyExempt: "details" } },
      h("summary", { data: { control: "chrome.details" } }, "Details for support"),
      h("pre", { class: "details-pre" }, supportDetails(o.error)),
    ),
  );
}

/** A loading placeholder. aria-busy on the region it stands in for is the caller's job; this gives the words. */
export function skeleton(o: { label: string; lines?: number }): HTMLDivElement {
  return h(
    "div",
    { class: "skeleton" },
    h("p", { class: "skeleton-label" }, o.label),
    ...Array.from({ length: o.lines ?? 3 }, () => h("div", { class: "skeleton-line", "aria-hidden": "true" })),
  );
}

/**
 * Progress of a long-running thing (a launch, a watch): live dot, "last
 * checked 12 s ago", elapsed time and a prominent Cancel. update() rewrites
 * the times in place; it never moves focus and is not a live region.
 */
export function statusPanel(o: {
  title: string;
  state: string;
  startedAt: number;
  lastChecked: number;
  cancel: ButtonOpts;
  now?: number;
}): { el: HTMLElement; update(lastChecked: number, now?: number, state?: string): void } {
  const stateEl = h("p", { class: "status-panel-state" }, h("span", { class: "live-dot", "aria-hidden": "true" }), o.state);
  const times = h("p", { class: "status-panel-times" });
  const write = (last: number, now: number) => {
    times.textContent = `Last checked ${formatAgo(now - last)} · started ${formatDuration(now - o.startedAt)} ago`;
  };
  write(o.lastChecked, o.now ?? Date.now());
  const el = card({ heading: o.title, children: [stateEl, times, h("div", { class: "status-panel-actions" }, button({ ...o.cancel, variant: o.cancel.variant ?? "secondary" }))] });
  el.classList.add("status-panel");
  return {
    el,
    update(last, now = Date.now(), state) {
      write(last, now);
      if (state !== undefined) stateEl.lastChild!.textContent = state;
    },
  };
}

/**
 * The command-line equivalent of what is on screen, with a copy button
 * (brief §3). Exempt from the copy lint: tool names belong here.
 */
export function commandLine(o: { command: string; label?: string }): HTMLElement {
  const labelId = uid("cli");
  const copy = button({
    label: "Copy command",
    control: "chrome.copy-command",
    variant: "secondary",
    icon: icon("copy"),
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(o.command);
        announce("Command copied.");
      } catch {
        announce("Couldn't copy. Select the command and copy it yourself.");
      }
    },
  });
  return h(
    "section",
    { class: "command-line", "aria-labelledby": labelId },
    h("h2", { class: "command-line-label", id: labelId }, o.label ?? "Command-line equivalent"),
    h("div", { class: "command-line-row" }, h("code", { class: "command-line-code", data: { copyExempt: "cli" } }, o.command), copy),
  );
}
