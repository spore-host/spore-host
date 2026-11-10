// Component semantics that the gates rely on but cannot see from outside:
// labels, descriptions, invalid state, control ids, dialog focus.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { button, checkbox, radioCards, select, textField } from "./controls.js";
import { confirmDialog } from "./dialog.js";
import { alert, commandLine, errorState, statusPanel, statusPill, table, timeLeftBar, timeLeftTone } from "./display.js";
import { h } from "./dom.js";
import { CATALOGUE } from "../copy/errors.js";

beforeEach(() => document.body.replaceChildren());

describe("dom.h", () => {
  it("sets text, never markup", () => {
    const el = h("p", {}, "<img src=x onerror=alert(1)>");
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("controls", () => {
  it("button carries its control id and an object name for screen readers", () => {
    const b = button({ label: "Stop", objectName: "rnaseq-align", control: "instance.stop" });
    expect(b.dataset.control).toBe("instance.stop");
    expect(b.type).toBe("button");
    expect(b.textContent).toBe("Stop rnaseq-align");
  });

  it("text field: label for, hint and error described, aria-invalid", () => {
    const f = textField({ label: "Time limit", control: "launch.ttl", id: "ttl", hint: "In hours", error: "Enter more than 0", required: true });
    const input = f.querySelector("input")!;
    expect(f.querySelector("label")!.htmlFor).toBe("ttl");
    expect(input.getAttribute("aria-describedby")).toBe("ttl-hint ttl-error");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.required).toBe(true);
    expect(input.placeholder).toBe("");
    expect(f.querySelector("#ttl-error")!.textContent).toBe("Error: Enter more than 0");
  });

  it("optional fields say so; required ones don't", () => {
    expect(textField({ label: "Name", control: "x" }).querySelector("label")!.textContent).toBe("Name (optional)");
    expect(textField({ label: "Name", control: "x", required: true }).querySelector("label")!.textContent).toBe("Name");
  });

  it("select and checkbox carry control ids and wiring", () => {
    const s = select({ label: "Location", control: "launch.location", value: "b", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
    expect(s.querySelector("select")!.value).toBe("b");
    const onChange = vi.fn();
    const c = checkbox({ label: "Use Spot", control: "launch.spot", id: "spot", hint: "Cheaper", onChange });
    const input = c.querySelector("input")!;
    expect(input.getAttribute("aria-describedby")).toBe("spot-hint");
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("radio cards: a named group, disabled options say why", () => {
    const g = radioCards({
      legend: "Size",
      name: "size",
      control: "launch.size",
      value: "m",
      options: [
        { value: "m", title: "Medium", spec: "4 processors", awsType: "m7i.xlarge" },
        { value: "x", title: "Huge", spec: "64 processors", unavailable: "Needs a quota increase." },
      ],
    });
    expect(g.tagName).toBe("FIELDSET");
    expect(g.querySelector("legend")!.textContent).toBe("Size");
    const radios = g.querySelectorAll("input");
    expect(radios[0].checked).toBe(true);
    expect(radios[1].disabled).toBe(true);
    expect(g.textContent).toContain("Needs a quota increase.");
    expect(g.querySelector("[data-copy-exempt='aws-type']")!.textContent).toBe("AWS type: m7i.xlarge");
  });
});

describe("display", () => {
  it("status pill: words, not colour alone", () => {
    expect(statusPill("attention").textContent).toBe("Needs attention");
    expect(statusPill("running").querySelector(".pill-dot")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("time left: neutral, then amber at 30 min, red at 10 min", () => {
    expect(timeLeftTone(31 * 60000)).toBe("neutral");
    expect(timeLeftTone(30 * 60000)).toBe("warning");
    expect(timeLeftTone(10 * 60000)).toBe("danger");
    const bar = timeLeftBar({ deadline: new Date(Date.UTC(2026, 0, 1, 16, 15)), totalMs: 8 * 3600000, now: Date.UTC(2026, 0, 1, 10, 46), timeZone: "UTC" });
    expect(bar.textContent).toBe("Terminated in 5 h 29 min (4:15 pm)");
    expect(bar.querySelector(".time-left-track")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("alert is static, not a live region", () => {
    const a = alert({ tone: "warning", title: "T" });
    expect(a.getAttribute("role")).toBe("group");
    expect(a.getAttribute("aria-live")).toBeNull();
  });

  it("error state shows three parts and keeps raw detail under Details", () => {
    const e = errorState({ entry: CATALOGUE.capacity, error: Object.assign(new Error("raw aws text"), { name: "InsufficientInstanceCapacity" }), control: "launch.retry" });
    expect(e.querySelector("h2")!.textContent).toBe(CATALOGUE.capacity.title);
    expect(e.querySelector("button")!.textContent).toBe("Try another size");
    const details = e.querySelector("details")!;
    expect(details.dataset.copyExempt).toBe("details");
    expect(details.textContent).toContain("raw aws text");
    // The raw message appears ONLY under Details.
    expect(e.textContent!.replace(details.textContent!, "")).not.toContain("raw aws text");
  });

  it("table cells carry their column label for the stacked view", () => {
    const t = table({ caption: "C", columns: [{ key: "a", label: "Name" }], rows: [{ a: "x" }] });
    expect(t.querySelector("td")!.dataset.label).toBe("Name");
    expect(t.querySelector("th")!.getAttribute("scope")).toBe("col");
  });

  it("status panel updates in place without replacing elements", () => {
    const p = statusPanel({ title: "Launching", state: "Starting", startedAt: 0, lastChecked: 0, now: 12_000, cancel: { label: "Cancel launch", control: "launch.cancel" } });
    const btn = p.el.querySelector("button");
    p.update(10_000, 22_000, "Running");
    expect(p.el.querySelector("button")).toBe(btn);
    expect(p.el.textContent).toContain("Last checked 12 s ago");
    expect(p.el.textContent).toContain("Running");
  });

  it("command line is exempt from the copy lint and has a copy button", () => {
    const c = commandLine({ command: "spawn list" });
    expect(c.querySelector("code")!.dataset.copyExempt).toBe("cli");
    expect(c.querySelector("button")!.dataset.control).toBe("chrome.copy-command");
  });
});

describe("confirm dialog", () => {
  // happy-dom implements <dialog>.showModal and close.
  it("focuses the safe choice for a destructive action and returns focus to the trigger", async () => {
    const trigger = button({ label: "Terminate…", control: "instance.terminate" });
    document.body.append(trigger);
    trigger.focus();
    const d = confirmDialog({ title: "Terminate x?", body: "Deleted.", confirmLabel: "Terminate x", cancelLabel: "Keep it", destructive: true, confirmControl: "instance.terminate" });
    const result = d.open(trigger);
    expect(d.el.open).toBe(true);
    expect(document.activeElement?.textContent).toBe("Keep it");
    (document.activeElement as HTMLButtonElement).click();
    expect(await result).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("focuses the confirm button for a non-destructive action and resolves true", async () => {
    const d = confirmDialog({ title: "Stop x?", body: "Kept.", confirmLabel: "Stop x", cancelLabel: "Cancel", confirmControl: "instance.stop" });
    const result = d.open(null);
    expect(document.activeElement?.textContent).toBe("Stop x");
    (document.activeElement as HTMLButtonElement).click();
    expect(await result).toBe(true);
    expect(d.el.open).toBe(false);
  });

  it("is labelled and described by its title and body", () => {
    const d = confirmDialog({ title: "T", body: "B", confirmLabel: "Do it", cancelLabel: "Cancel", confirmControl: "x" });
    expect(document.getElementById(d.el.getAttribute("aria-labelledby")!)?.textContent).toBeUndefined();
    d.open(null);
    expect(document.getElementById(d.el.getAttribute("aria-labelledby")!)!.textContent).toBe("T");
    expect(document.getElementById(d.el.getAttribute("aria-describedby")!)!.textContent).toBe("B");
  });
});
