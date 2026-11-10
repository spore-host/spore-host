// Component gallery (brief §5, #683): every component in its states, so the
// axe, keyboard, reflow and copy gates exercise components before any slice
// uses them. Built only in the gate build (portal/vite.config.ts).
import "../styles/tokens.css";
import "../styles/components.css";
import "../styles/layout.css";
import "./gallery.css";
import { button, checkbox, radioCards, select, textField } from "../components/controls.js";
import { confirmDialog } from "../components/dialog.js";
import {
  alert,
  card,
  commandLine,
  emptyState,
  errorState,
  skeleton,
  statTile,
  statusPanel,
  statusPill,
  table,
  timeLeftBar,
  type InstanceStatus,
} from "../components/display.js";
import { h } from "../components/dom.js";
import { CATALOGUE } from "../copy/errors.js";
import { costLimitFor, maxCostFor } from "../lib/cost.js";
import { formatMoney, formatRate } from "../lib/format.js";
import { sessionAlert } from "../shell/session-alert.js";

// A fixed clock, so the gallery renders the same text on every run.
const NOW = Date.UTC(2026, 10, 9, 18, 0, 0);
const TZ = "UTC";

function section(id: string, title: string, ...children: Node[]): HTMLElement {
  return h("section", { class: "gallery-section", "aria-labelledby": id, id: `section-${id}` }, h("h2", { id }, title), ...children);
}

function sub(title: string, ...children: Node[]): HTMLElement {
  return h("div", { class: "gallery-item" }, h("h3", {}, title), ...children);
}

const terminate = confirmDialog({
  title: "Terminate rnaseq-align?",
  body: "The instance and everything on its disk are deleted for good. This stops the $0.40 an hour charge.",
  confirmLabel: "Terminate rnaseq-align",
  cancelLabel: "Keep it",
  destructive: true,
  confirmControl: "gallery.dialog-terminate",
  cancelControl: "gallery.dialog-keep",
});
const stop = confirmDialog({
  title: "Stop rnaseq-align?",
  body: "Its disk is kept, for about $1.60 a month in storage, and you can start it again. It will still be terminated at 4:15 pm.",
  confirmLabel: "Stop rnaseq-align",
  cancelLabel: "Cancel",
  confirmControl: "gallery.dialog-stop",
  cancelControl: "gallery.dialog-cancel",
});

const result = h("p", { class: "field-hint", id: "dialog-result" }, "No dialog opened yet.");

const statuses: InstanceStatus[] = ["starting", "running", "stopping", "stopped", "terminating", "attention"];
const rate = 0.192;
const limit = costLimitFor(rate, 2)!;

const panel = statusPanel({
  title: "Launching rnaseq-align",
  state: "Starting (usually about 2 minutes)",
  startedAt: NOW - 50_000,
  lastChecked: NOW - 12_000,
  now: NOW,
  cancel: { label: "Cancel launch", control: "gallery.status-cancel" },
});

const page = h(
  "div",
  { class: "page page-list" },
  h(
    "div",
    { class: "page-header" },
    h(
      "div",
      { class: "page-header-text" },
      h("h1", { tabindex: "-1", class: "page-title" }, "Component gallery"),
      h("p", { class: "lede" }, "Every portal component in each of its states. The accessibility, keyboard, reflow and copy checks run over this page."),
    ),
  ),
  section(
    "buttons",
    "Buttons",
    h(
      "div",
      { class: "gallery-row" },
      button({ label: "Launch instance", control: "gallery.button-primary", variant: "primary" }),
      button({ label: "Extend 1 hour", control: "gallery.button-secondary" }),
      button({ label: "Terminate", objectName: "rnaseq-align", control: "gallery.button-danger", variant: "danger" }),
      button({ label: "Show details", control: "gallery.button-link", variant: "link" }),
      button({ label: "Launching…", control: "gallery.button-disabled", variant: "primary", disabled: true }),
    ),
  ),
  section(
    "fields",
    "Fields",
    textField({ label: "Name", control: "gallery.field-name", hint: "Letters, numbers and hyphens. Shown in your list of instances.", value: "rnaseq-align" }),
    textField({
      label: "Time limit, in hours",
      control: "gallery.field-ttl",
      required: true,
      width: "short",
      inputmode: "decimal",
      value: "0",
      error: "Enter a time limit of more than 0 hours.",
    }),
    select({
      label: "Location",
      control: "gallery.field-location",
      value: "us-east-1",
      options: [
        { value: "us-east-1", label: "US East (N. Virginia)" },
        { value: "us-west-2", label: "US West (Oregon)" },
      ],
    }),
    checkbox({ label: "Use Spot", control: "gallery.field-spot", hint: "About 60 to 70% cheaper, but AWS can take the instance back at any time with 2 minutes' warning." }),
  ),
  section(
    "radio-cards",
    "Radio cards",
    radioCards({
      legend: "Size",
      name: "size",
      control: "gallery.radio-size",
      value: "medium",
      hint: "Prices are per hour at the standard price.",
      options: [
        { value: "small", title: "Small", spec: "2 processors · 8 GB memory", price: formatRate(0.096), awsType: "m7i.large" },
        { value: "medium", title: "Medium", spec: "4 processors · 16 GB memory", price: formatRate(0.192), awsType: "m7i.xlarge" },
        { value: "large", title: "Large", spec: "16 processors · 64 GB memory", price: formatRate(0.768), awsType: "m7i.4xlarge" },
        {
          value: "lots",
          title: "Lots of processors",
          spec: "64 processors · 256 GB memory",
          price: formatRate(3.072),
          awsType: "m7i.16xlarge",
          unavailable: "Needs a quota increase before you can choose it.",
        },
      ],
    }),
  ),
  section(
    "cards",
    "Cards and figures",
    h(
      "div",
      { class: "gallery-grid" },
      statTile({ label: "Spending now, per hour", value: formatMoney(2.88), note: "3 running, 1 stopped" }),
      statTile({ label: "This month if left running", value: formatMoney(2106), note: "An estimate from today's rate" }),
      statTile({ label: "At most, for 2 hours", value: formatMoney(maxCostFor(rate, 2, limit)!), note: `Spending limit ${formatMoney(limit)}` }),
    ),
    card({
      heading: "rnaseq-align",
      tag: "article",
      children: [
        h("p", {}, "Medium · 4 processors · 16 GB memory"),
        statusPill("running"),
        timeLeftBar({ deadline: new Date(NOW + (5 * 60 + 29) * 60000), totalMs: 8 * 3600000, now: NOW, timeZone: TZ }),
      ],
    }),
  ),
  section(
    "status",
    "Status pills and time left",
    h("div", { class: "gallery-row" }, ...statuses.map((s) => statusPill(s))),
    sub("Plenty of time", timeLeftBar({ deadline: new Date(NOW + 3 * 3600000), totalMs: 4 * 3600000, now: NOW, timeZone: TZ })),
    sub("Under 30 minutes", timeLeftBar({ deadline: new Date(NOW + 25 * 60000), totalMs: 4 * 3600000, now: NOW, timeZone: TZ })),
    sub("Under 10 minutes", timeLeftBar({ deadline: new Date(NOW + 6 * 60000), totalMs: 4 * 3600000, now: NOW, timeZone: TZ })),
  ),
  section(
    "table",
    "Table",
    table({
      caption: "Your instances",
      rowKey: "name",
      columns: [
        { key: "name", label: "Name" },
        { key: "size", label: "Size" },
        { key: "status", label: "Status" },
        { key: "cost", label: "So far (estimate)", numeric: true },
      ],
      rows: [
        { name: "rnaseq-align", size: "Medium", status: statusPill("running"), cost: formatMoney(1.4) },
        { name: "blast-db-build", size: "Large", status: statusPill("stopped"), cost: formatMoney(12.75) },
      ],
    }),
  ),
  section(
    "alerts",
    "Alerts",
    alert({ tone: "info", title: "Prices are AWS list prices from July 2026", body: h("p", {}, "They aren't live prices, so your bill may differ slightly.") }),
    alert({
      tone: "warning",
      title: "2 instances are still running past their time limit",
      body: h("p", {}, "They are still costing money."),
      action: { label: "Terminate them", control: "gallery.alert-action", variant: "danger" },
    }),
    alert({ tone: "danger", title: "rnaseq-align couldn't be terminated", body: h("p", {}, "It is still running and still costing money.") }),
    alert({ tone: "success", title: "rnaseq-align was terminated", body: h("p", {}, "About $0.71 in total.") }),
  ),
  section(
    "session",
    "Sign-in expiry",
    sub("Warning", sessionAlert({ state: "warning", minutesLeft: 4, expiresAt: new Date(NOW + 4 * 60000) }, () => {}).el),
    sub("Signed out", sessionAlert({ state: "expired", minutesLeft: 0, expiresAt: new Date(NOW) }, () => {}).el),
  ),
  section(
    "states",
    "Empty, error and loading",
    emptyState({ title: "You have no instances running", body: "Launch one to get started.", level: 3, action: button({ label: "Launch an instance", control: "gallery.empty-action", variant: "primary" }) }),
    errorState({
      entry: CATALOGUE["not-permitted"],
      error: Object.assign(new Error("You are not authorized to perform this operation."), { name: "UnauthorizedOperation", $metadata: { httpStatusCode: 403, requestId: "example-request" } }),
      context: "We couldn't check your instances. They may still be running and costing money.",
      control: "gallery.error-action",
      level: 3,
    }),
    h("div", { "aria-busy": "true" }, skeleton({ label: "Checking your instances…" })),
  ),
  section(
    "catalogue",
    "Error catalogue",
    ...Object.values(CATALOGUE).map((entry) =>
      sub(entry.kind, errorState({ entry, error: Object.assign(new Error("example"), { name: entry.codes[0] ?? "Error" }), control: `gallery.catalogue-${entry.kind}`, level: 4 })),
    ),
  ),
  section("panel", "Status panel", panel.el),
  section(
    "dialogs",
    "Confirm dialogs",
    h(
      "div",
      { class: "gallery-row" },
      button({ label: "Terminate…", control: "gallery.open-terminate", variant: "danger", onClick: async (e) => (result.textContent = (await terminate.open(e.currentTarget as HTMLElement)) ? "Terminate chosen." : "Kept.") }),
      button({ label: "Stop…", control: "gallery.open-stop", onClick: async (e) => (result.textContent = (await stop.open(e.currentTarget as HTMLElement)) ? "Stop chosen." : "Cancelled.") }),
    ),
    result,
  ),
  section("cli", "Command line", commandLine({ command: "spawn launch --name rnaseq-align --instance-type m7i.xlarge --ttl 2h --cost-limit 1" })),
);

document.getElementById("page")!.replaceWith(page);
document.title = "Component gallery — spore.host";
