import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUIDED_SHAPES } from "./shapes.js";
import { mountGuidedPicker } from "./picker.js";

/** Let the per-card resolveShape promises settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("mountGuidedPicker", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("renders one card per curated shape", async () => {
    const dispose = mountGuidedPicker(host, { onChoose: vi.fn(), onEscape: vi.fn() });
    await settle();
    expect(host.querySelectorAll(".guided-card")).toHaveLength(GUIDED_SHAPES.length);
    dispose();
  });

  it("resolves every card to a real machine and a price", async () => {
    // The plan's headline check, at the DOM level: guided mode with no advisor,
    // no credentials and no network still shows real instance types and prices.
    const dispose = mountGuidedPicker(host, { onChoose: vi.fn(), onEscape: vi.fn() });
    await settle();

    const cards = [...host.querySelectorAll<HTMLButtonElement>(".guided-card")];
    cards.forEach((card, i) => {
      const id = GUIDED_SHAPES[i]!.id;
      expect(card.classList.contains("ready"), id).toBe(true);
      expect(card.classList.contains("loading"), id).toBe(false);
      expect(card.disabled, id).toBe(false);
      const text = card.querySelector(".guided-card-machine")!.textContent!;
      expect(text, id).toMatch(/[a-z0-9-]+\.[a-z0-9]+/); // an instance type
      expect(text, id).toMatch(/\$\d/); // a price
      expect(text, id).not.toMatch(/\$0\.00 for/); // never "free"
    });
    dispose();
  });

  it("says how many machines fit, so the pick doesn't read as the only option", async () => {
    // resolveShape computes totalMatches for exactly this purpose and the UI used to
    // drop it. "cheapest of 194 that fit" tells the user a choice was made on their
    // behalf; the bare recommendation reads as the only thing available.
    const dispose = mountGuidedPicker(host, { onChoose: vi.fn(), onEscape: vi.fn() });
    await settle();
    expect(host.querySelector(".guided-card-alts")!.textContent).toMatch(
      /cheapest of \d+ that fit/,
    );
    dispose();
  });

  it("omits the match count when there was nothing to choose between", async () => {
    const dispose = mountGuidedPicker(host, {
      onChoose: vi.fn(),
      onEscape: vi.fn(),
      shapes: [GUIDED_SHAPES[0]!],
      finder: async () =>
        [
          {
            instance: {
              instanceType: "t4g.small",
              vcpus: 2,
              memoryMib: 2048,
              onDemandPrice: 0.0168,
            },
            score: 1,
            reasons: [],
          },
        ] as any,
    });
    await settle();
    expect(host.querySelector(".guided-card-alts")).toBeNull();
    dispose();
  });

  it("reports the chosen shape and its resolved machine", async () => {
    const onChoose = vi.fn();
    const dispose = mountGuidedPicker(host, { onChoose, onEscape: vi.fn() });
    await settle();

    host.querySelector<HTMLButtonElement>(".guided-card")!.click();
    expect(onChoose).toHaveBeenCalledTimes(1);
    const choice = onChoose.mock.calls[0]![0];
    expect(choice.shape.id).toBe(GUIDED_SHAPES[0]!.id);
    expect(choice.rec.pick.instance.instanceType).toBeTruthy();
    dispose();
  });

  it("offers an escape to a denser mode", async () => {
    // Guided mode must not be a trap: a user who outgrows it mid-task needs a way
    // out that isn't "hunt for the setting in the header".
    const onEscape = vi.fn();
    const dispose = mountGuidedPicker(host, { onChoose: vi.fn(), onEscape });
    await settle();
    host.querySelector<HTMLButtonElement>(".guided-escape")!.click();
    expect(onEscape).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("shows a lookup failure as a failure, not as no match", async () => {
    // The #63 invariant at the pixel level: a broken catalog and an empty catalog
    // must not render the same, because they call for different user action
    // (retry vs pick something else). This is the branch the real catalog never
    // exercises, so it's the one most likely to ship broken.
    const onChoose = vi.fn();
    const dispose = mountGuidedPicker(host, {
      onChoose,
      onEscape: vi.fn(),
      shapes: [GUIDED_SHAPES[0]!],
      finder: async () => {
        throw new Error("catalog unreadable");
      },
    });
    await settle();

    const card = host.querySelector<HTMLButtonElement>(".guided-card")!;
    expect(card.classList.contains("errored")).toBe(true);
    expect(card.classList.contains("unresolved")).toBe(false);
    expect(card.querySelector(".guided-card-machine")!.textContent).toContain("catalog unreadable");
    // An errored card must not be clickable — there is nothing to launch.
    expect(card.disabled).toBe(true);
    card.click();
    expect(onChoose).not.toHaveBeenCalled();
    dispose();
  });

  it("shows no-match distinctly from a failure", async () => {
    const dispose = mountGuidedPicker(host, {
      onChoose: vi.fn(),
      onEscape: vi.fn(),
      shapes: [GUIDED_SHAPES[0]!],
      finder: async () => [],
    });
    await settle();

    const card = host.querySelector<HTMLButtonElement>(".guided-card")!;
    expect(card.classList.contains("unresolved")).toBe(true);
    expect(card.classList.contains("errored")).toBe(false);
    expect(card.querySelector(".guided-card-machine")!.textContent).toContain("no machine");
    expect(card.disabled).toBe(true);
    dispose();
  });

  it("does not write into a detached DOM after dispose", async () => {
    // dispose() can land while five resolveShape promises are in flight. Writing
    // into removed nodes is harmless-looking until one of those writes is an
    // error message the user can no longer see, on a surface they've left.
    const dispose = mountGuidedPicker(host, { onChoose: vi.fn(), onEscape: vi.fn() });
    dispose();
    await settle();
    expect(host.querySelector(".guided-picker")).toBeNull();
    expect(host.querySelectorAll(".guided-card")).toHaveLength(0);
  });

  it("removes its listeners on dispose", async () => {
    const onEscape = vi.fn();
    const dispose = mountGuidedPicker(host, { onChoose: vi.fn(), onEscape });
    await settle();
    const escape = host.querySelector<HTMLButtonElement>(".guided-escape")!;
    dispose();
    escape.click(); // detached, but click the retained node anyway
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("escapes shape text rather than injecting it", async () => {
    const dispose = mountGuidedPicker(host, { onChoose: vi.fn(), onEscape: vi.fn() });
    await settle();
    expect(host.innerHTML).not.toContain("<script");
    dispose();
  });
});
