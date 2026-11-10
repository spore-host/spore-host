// ConfirmDialog (brief §5, §7 "Dialogs").
//
// A native <dialog> opened with showModal(): the background is inert, Escape
// closes it, and focus is trapped by the browser, not by us. The dialog names
// the object, the loss and the verb. For a destructive action the initial
// focus is on the safe choice, and the safe and destructive buttons sit apart.
// Closing, by any route, returns focus to the element that opened it.
import { button } from "./controls.js";
import { h, uid } from "./dom.js";

export interface ConfirmOpts {
  /** "Terminate rnaseq-align?" */
  title: string;
  /** What happens, in words: "The instance and everything on its disk are deleted for good." */
  body: string;
  /** The verb that names the result: "Terminate rnaseq-align". Never "Confirm" or "OK". */
  confirmLabel: string;
  /** The safe choice: "Keep it", "Cancel". */
  cancelLabel: string;
  destructive?: boolean;
  /** Control ids for the CLI⇄GUI matrix: the confirm button maps to the CLI verb, cancel is chrome. */
  confirmControl: string;
  cancelControl?: string;
}

export interface ConfirmDialog {
  el: HTMLDialogElement;
  /** Open, remembering `trigger` to return focus to. Resolves true on confirm, false on cancel or Escape. */
  open(trigger?: HTMLElement | null): Promise<boolean>;
}

export function confirmDialog(o: ConfirmOpts): ConfirmDialog {
  const titleId = uid("dialog-title");
  const bodyId = uid("dialog-body");
  let resolve: ((v: boolean) => void) | null = null;
  let returnTo: HTMLElement | null = null;

  const cancel = button({ label: o.cancelLabel, control: o.cancelControl ?? "chrome.dialog-cancel", variant: "secondary", onClick: () => close(false) });
  const confirm = button({ label: o.confirmLabel, control: o.confirmControl, variant: o.destructive ? "danger" : "primary", onClick: () => close(true) });

  const el = h(
    "dialog",
    { class: "dialog", "aria-labelledby": titleId, "aria-describedby": bodyId },
    h("h2", { id: titleId, class: "dialog-title" }, o.title),
    h("p", { id: bodyId, class: "dialog-body" }, o.body),
    // Destructive: safe choice first and the two kept apart (brief §7 "2.5.8").
    h("div", { class: `dialog-actions${o.destructive ? " dialog-actions-apart" : ""}` }, cancel, confirm),
  );

  function close(result: boolean): void {
    if (el.open) el.close(result ? "confirm" : "cancel");
    settle(result);
  }

  function settle(result: boolean): void {
    const r = resolve;
    resolve = null;
    // Return focus even if the trigger was re-rendered: fall back to the page heading.
    const target = returnTo && returnTo.isConnected ? returnTo : document.querySelector<HTMLElement>("main h1");
    target?.focus();
    returnTo = null;
    r?.(result);
  }

  // Escape fires `cancel` then `close`; a form-less dialog closed any other way fires only `close`.
  el.addEventListener("close", () => {
    if (resolve) settle(el.returnValue === "confirm");
  });

  return {
    el,
    open(trigger) {
      returnTo = trigger ?? (document.activeElement as HTMLElement | null);
      if (!el.isConnected) document.body.append(el);
      el.returnValue = "";
      el.showModal();
      (o.destructive ? cancel : confirm).focus();
      return new Promise<boolean>((r) => {
        resolve = r;
      });
    },
  };
}
