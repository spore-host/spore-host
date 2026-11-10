// The rendered-page checks, shared by the gate specs and the self-test that
// proves each can fail. Each returns a list of problems; empty means pass.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { describeFindings, lintCopy } from "../src/copy/lint.js";

/** WCAG 2.0/2.1/2.2 A and AA, per brief §7's merge gate (#651). */
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export async function axeProblems(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${v.help} at ${n.target.join(" ")}`));
}

/** SC 1.4.10: nothing scrolls sideways, and no element reaches past the viewport. */
export async function reflowProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    if (document.documentElement.scrollWidth > vw) out.push(`page is ${document.documentElement.scrollWidth}px wide in a ${vw}px viewport`);
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Visually-hidden text is clipped to 1px and positioned inside the viewport.
      if (r.right > vw + 0.5) {
        const id = el.id ? `#${el.id}` : el.className && typeof el.className === "string" ? `.${el.className.split(" ")[0]}` : "";
        out.push(`${el.tagName.toLowerCase()}${id} ends at ${Math.round(r.right)}px`);
      }
    }
    return [...new Set(out)].slice(0, 20);
  });
}

/** SC 1.4.12: apply the text-spacing overrides WCAG names. */
export async function applyTextSpacing(page: Page): Promise<void> {
  await page.addStyleTag({
    content: "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-block-end: 2em !important; }",
  });
}

/** The copy the user reads or hears, with [data-copy-exempt] regions removed. */
export async function renderedCopy(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    for (const el of clone.querySelectorAll("[data-copy-exempt], script, style, template")) el.remove();
    const attrs = [...clone.querySelectorAll("[aria-label], [alt], [title], [placeholder]")].flatMap((el) =>
      ["aria-label", "alt", "title", "placeholder"].map((a) => el.getAttribute(a) ?? ""),
    );
    return [clone.textContent ?? "", document.title, ...attrs].join("\n").replace(/[ \t]+/g, " ");
  });
}

export async function copyProblems(page: Page, where: string): Promise<string[]> {
  const text = await renderedCopy(page);
  return describeFindings(where, text, lintCopy(text));
}

const INTERACTIVE = "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1']), [role=button], [role=link], [role=switch], [contenteditable='true']";

/** Every interactive element: its data-control id, or a description when it has none. */
export async function controls(page: Page): Promise<{ control: string | null; what: string }[]> {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll<HTMLElement>(sel)].map((el) => ({
      control: el.dataset.control ?? null,
      what: `${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 40)}"`,
    }));
  }, INTERACTIVE);
}

export interface FocusStop {
  what: string;
  visible: boolean;
  obscured: boolean;
}

/**
 * Tab from the top of the page until focus leaves the document or comes back
 * round. A walk that never ends is a keyboard trap (SC 2.1.2). Each stop is
 * checked for a visible indicator (SC 2.4.7) and for being on screen and not
 * covered (SC 2.4.11).
 */
export async function tabWalk(page: Page, max = 80): Promise<{ stops: FocusStop[]; trapped: boolean }> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const stops: FocusStop[] = [];
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el === document.documentElement) return null;
      const cs = getComputedStyle(el);
      const ringed = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== "none" && cs.boxShadow !== "");
      // A radio card or checkbox draws its ring on the card around the input.
      const host = el.closest(".radio-card") as HTMLElement | null;
      const hostRinged = host ? getComputedStyle(host).outlineStyle !== "none" : false;
      const r = el.getBoundingClientRect();
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      const atPoint = document.elementFromPoint(cx, cy);
      const onScreen = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      const covered = onScreen && atPoint !== null && atPoint !== el && !el.contains(atPoint) && !atPoint.contains(el) && !((el as HTMLInputElement).labels && [...(el as HTMLInputElement).labels!].some((l) => l.contains(atPoint)));
      const key = `${el.tagName}#${el.id}.${el.dataset.control ?? ""}:${Math.round(r.top + scrollY)}:${Math.round(r.left)}`;
      return { key, what: `${el.tagName.toLowerCase()} ${el.dataset.control ?? ""} "${(el.textContent ?? "").trim().slice(0, 30)}"`, visible: ringed || hostRinged, obscured: !onScreen || covered };
    });
    if (stop === null) return { stops, trapped: false };
    if (seen.includes(stop.key)) {
      // Back at the first stop: the order wrapped round, which is fine. Focus
      // that did not move, or that loops back to a later stop, never reaches
      // the end of the page: a trap.
      return { stops, trapped: stop.key !== seen[0] || seen.length === 1 };
    }
    seen.push(stop.key);
    stops.push({ what: stop.what, visible: stop.visible, obscured: stop.obscured });
  }
  return { stops, trapped: true };
}

/** Focus-walk problems as lines. */
export async function keyboardProblems(page: Page): Promise<string[]> {
  const { stops, trapped } = await tabWalk(page);
  const out: string[] = [];
  if (trapped) out.push(`keyboard trap: Tab never left the page after ${stops.length} stops (last: ${stops.at(-1)?.what ?? "none"})`);
  for (const s of stops) {
    if (!s.visible) out.push(`no visible focus indicator on ${s.what}`);
    if (s.obscured) out.push(`focused ${s.what} is off screen or covered`);
  }
  return out;
}

/**
 * Project rule (brief §7): every basic-mode target is at least 44 x 44.
 * Links inside running text are exempt (SC 2.5.8's inline exception). A
 * checkbox or radio counts its label and card, since clicking them toggles it.
 */
export async function targetProblems(page: Page, min = 44): Promise<string[]> {
  return page.evaluate((m) => {
    const out: string[] = [];
    const sel = "a[href], button, input:not([type=hidden]), select, textarea, summary";
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || el.closest("[hidden], dialog:not([open])")) continue;
      const rects = [el.getBoundingClientRect()];
      if (rects[0].width === 0 && rects[0].height === 0) continue;
      if (el.tagName === "A" && el.closest("p, li.inline") && !el.classList.contains("btn")) continue;
      if (el.classList.contains("skip-link")) continue;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        for (const l of el.labels ?? []) rects.push(l.getBoundingClientRect());
        const card = el.closest(".radio-card, .checkbox");
        if (card) rects.push(card.getBoundingClientRect());
      }
      const w = Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left));
      const h = Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top));
      if (w + 0.5 < m || h + 0.5 < m) out.push(`${el.tagName.toLowerCase()} ${el.dataset.control ?? ""} "${(el.textContent ?? "").trim().slice(0, 30)}" is ${Math.round(w)}x${Math.round(h)}`);
    }
    return out;
  }, min);
}
