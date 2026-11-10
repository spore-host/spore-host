// Page templates (brief §5): List, Task, Detail and Centred card.
//
// Every page has exactly one h1, with tabindex=-1 so the router can move focus
// to it on a route change (SC 2.4.3). The h1 text is the route title, which is
// also the first half of document.title (SC 2.4.2).
import { h, type Child } from "../components/dom.js";
import { commandLine } from "../components/display.js";

export interface PageContext {
  title: string;
  params: Record<string, string>;
  signedIn: boolean;
  cli?: string;
}

export function pageHeader(o: { title: string; lede?: string; action?: Child }): HTMLElement {
  return h(
    "div",
    { class: "page-header" },
    h("div", { class: "page-header-text" }, h("h1", { tabindex: "-1", class: "page-title" }, o.title), o.lede ? h("p", { class: "lede" }, o.lede) : null),
    o.action ? h("div", { class: "page-header-action" }, o.action) : null,
  );
}

function footer(cli?: string): Child {
  return cli ? h("footer", { class: "page-footer" }, commandLine({ command: cli })) : null;
}

/** List template: max 1040 px, header with h1, lede and the primary action on the right. */
export function listPage(o: { title: string; lede?: string; action?: Child; body: Child[]; cli?: string }): HTMLElement {
  return h("div", { class: "page page-list" }, pageHeader(o), h("div", { class: "page-body" }, ...o.body), footer(o.cli));
}

/** Task template: a 640 px column, and a summary that is sticky beside it at >= 1024 px. */
export function taskPage(o: { title: string; lede?: string; body: Child[]; summary?: Child; cli?: string }): HTMLElement {
  return h(
    "div",
    { class: "page page-task" },
    pageHeader(o),
    h("div", { class: "task-layout" }, h("div", { class: "task-column" }, ...o.body), o.summary ? h("aside", { class: "task-summary", "aria-label": "Summary" }, o.summary) : null),
    footer(o.cli),
  );
}

/** Detail template: an object's page (an instance, a watch). */
export function detailPage(o: { title: string; lede?: string; action?: Child; body: Child[]; cli?: string }): HTMLElement {
  return h("div", { class: "page page-detail" }, pageHeader(o), h("div", { class: "page-body" }, ...o.body), footer(o.cli));
}

/** Centred card: Welcome, Before you start, sign-in failure, 404. */
export function centredPage(o: { title: string; lede?: string; body: Child[]; cli?: string }): HTMLElement {
  return h("div", { class: "page page-centred" }, h("div", { class: "centred-card" }, pageHeader(o), ...o.body), footer(o.cli));
}
