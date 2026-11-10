// The session-expiry alert (brief §4 Flow B "Session expired", §7 SC 2.2.1).
//
// Two states. Warning: the minutes left, said at least 2 minutes ahead (the
// warn window is 5), and a way to sign in again that keeps the page as it is.
// Expired: the instances are still running and still costing money.
//
// The visible banner is a static Alert. The shell announces each state ONCE
// through the assertive region; the minute count then updates silently, so a
// screen reader is not interrupted every minute.
import { alert } from "../components/display.js";
import { h } from "../components/dom.js";
import { minutesLeft, type ExpiryEvent } from "../lib/session.js";
import { plural } from "../lib/format.js";

export function warningTitle(minutes: number): string {
  return `You'll be signed out in ${plural(Math.max(1, minutes), "minute")}`;
}

export const WARNING_BODY = "Your instances keep running either way. Sign in again to keep working; this page stays as it is.";
export const EXPIRED_TITLE = "You've been signed out";
export const EXPIRED_BODY = "Your instances are still running and still costing money. Sign in again to see and manage them.";

/** What the assertive region says for each state. */
export function announcement(e: ExpiryEvent): string {
  return e.state === "expired" ? `${EXPIRED_TITLE}. ${EXPIRED_BODY}` : `${warningTitle(e.minutesLeft)}. Sign in again to keep working.`;
}

export interface SessionAlert {
  el: HTMLElement;
  /** Recompute the minutes left. Call on a timer; it changes text only, never focus. */
  tick(now?: number): void;
}

export function sessionAlert(e: ExpiryEvent, onReauth: () => void): SessionAlert {
  const expired = e.state === "expired";
  const el = alert({
    tone: expired ? "danger" : "warning",
    title: expired ? EXPIRED_TITLE : warningTitle(e.minutesLeft),
    body: h("p", {}, expired ? EXPIRED_BODY : WARNING_BODY),
    action: { label: "Sign in again", control: "chrome.reauth", variant: "primary", onClick: () => onReauth() },
  });
  el.classList.add("session-alert");
  el.dataset.state = e.state;
  const title = el.querySelector(".alert-title")!;
  return {
    el,
    tick(now = Date.now()) {
      if (!expired) title.textContent = warningTitle(minutesLeft(e.expiresAt.getTime(), now));
    },
  };
}
