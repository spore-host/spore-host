// A tiny element builder. No framework (brief §9: "no framework change
// required"); components are functions that return elements.
//
// Text goes in through textContent only, never innerHTML, so copy and data
// can never become markup.

export type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  class?: string;
  /** Sets data-* attributes. `{ control: "nav.instances" }` gives data-control="nav.instances". */
  data?: Record<string, string | undefined>;
  /** Event listeners: `{ click: fn }`. */
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
  [attr: string]: unknown;
}

/** Create an element. Attributes with value false/null/undefined are omitted; true sets an empty attribute. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "data") {
      for (const [dk, dv] of Object.entries(v as Record<string, string | undefined>)) if (dv !== undefined) el.dataset[dk] = dv;
    } else if (k === "on") {
      for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) el.addEventListener(ev, fn);
    } else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "number" ? String(c) : c);
  }
}

/** Replace an element's children. */
export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

let seq = 0;
/** A document-unique id with a readable prefix, for label/aria wiring. */
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Text only screen readers get. */
export function srOnly(text: string): HTMLSpanElement {
  return h("span", { class: "visually-hidden" }, text);
}

/** A decorative inline SVG icon, hidden from assistive technology (the words beside it carry the meaning). */
export function icon(name: "info" | "warning" | "danger" | "success" | "copy" | "menu" | "chevron"): SVGSVGElement {
  const paths: Record<typeof name, string> = {
    info: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z",
    warning: "M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z",
    danger: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z",
    success: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-2 15-5-5 1.4-1.4 3.6 3.6 7.6-7.6L19 8l-9 9Z",
    copy: "M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z",
    menu: "M3 6h18v2H3V6Zm0 5h18v2H3v-2Zm0 5h18v2H3v-2Z",
    chevron: "M7 10l5 5 5-5H7Z",
  };
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `icon icon-${name}`);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", paths[name]);
  p.setAttribute("fill", "currentColor");
  svg.append(p);
  return svg;
}
