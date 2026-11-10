// Per-level rendering of the cost-history surface.
//
// Disclosure here is ADDITIVE ONLY — this is the one surface that answers "what am I
// spending?", so nothing is hidden from anyone. That makes the negative assertions
// the important ones: the table toggle is an accessibility affordance for the chart,
// not a density control, and a future "simplify guided" change that removed it would
// take the chart's only non-visual path with it.
//
// `fetch` is stubbed. The real endpoint needs a federated session, and what's under
// test is the rendering of a known series, not the transport.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../session.js";
import type { PortalConfig, SurfaceContext } from "./types.js";
import type { DisclosureLevel } from "../disclosure.js";
import { costsSurface } from "./costs.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

const config = { region: "us-east-1", apiBase: "https://api.example" } as PortalConfig;

/**
 * Five daily samples with a mid-window spike.
 *
 * The spike is deliberate: it's what makes the expert-only "Peak hourly" tile
 * distinguishable from "Current hourly cost", which reads the last point. A flat
 * series would let a broken peak calculation pass.
 */
const HISTORY = [
  { timestamp: "2026-07-01T00:00:00Z", hourly_cost: 0.5, monthly_estimate: 365, instance_count: 1, breakdown: { compute: 0.4, storage: 0.08, network: 0.02 } },
  { timestamp: "2026-07-02T00:00:00Z", hourly_cost: 0.75, monthly_estimate: 547.5, instance_count: 2, breakdown: { compute: 0.6, storage: 0.1, network: 0.05 } },
  { timestamp: "2026-07-03T00:00:00Z", hourly_cost: 4.25, monthly_estimate: 3102.5, instance_count: 6, breakdown: { compute: 4.0, storage: 0.2, network: 0.05 } },
  { timestamp: "2026-07-04T00:00:00Z", hourly_cost: 0.9, monthly_estimate: 657, instance_count: 2, breakdown: { compute: 0.7, storage: 0.15, network: 0.05 } },
  { timestamp: "2026-07-05T00:00:00Z", hourly_cost: 1.25, monthly_estimate: 912.5, instance_count: 3, breakdown: { compute: 1.0, storage: 0.2, network: 0.05 } },
];

/** Records every requested `days` so the preset wiring can be asserted. */
let requestedDays: number[] = [];

function stubFetch(history: unknown = HISTORY): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requestedDays.push(Number(new URL(url).searchParams.get("days")));
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, history }),
      } as never;
    }),
  );
}

function ctxAt(level: DisclosureLevel, navigate = vi.fn()): SurfaceContext {
  const session = new SessionController("us-east-1", null);
  session.setLevel(level);
  vi.spyOn(session, "getCreds").mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "token",
  } as never);
  return { session, config, level, navigate };
}

describe("costsSurface disclosure", () => {
  let host: HTMLElement;

  beforeEach(() => {
    requestedDays = [];
    stubFetch();
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    location.hash = "#/costs";
  });

  it("keeps the table toggle at every level", async () => {
    // Not a density control. It is the chart's non-visual equivalent, and the users
    // most likely to need it are the least likely to have raised the mode.
    for (const level of ["guided", "standard", "expert"] as const) {
      host.innerHTML = "";
      const d = await costsSurface.mount(host, ctxAt(level));
      await settle();
      expect(host.querySelector(".costs-tabletoggle"), level).not.toBeNull();
      d.dispose();
    }
  });

  it("shows the same series at every level", async () => {
    // Additive only: nobody is shown less spend than anyone else.
    for (const level of ["guided", "standard", "expert"] as const) {
      host.innerHTML = "";
      const d = await costsSurface.mount(host, ctxAt(level));
      await settle();
      expect(host.querySelector(".costs-chart"), level).not.toBeNull();
      d.dispose();
    }
  });

  it("does not call the projection a 'monthly estimate' at guided", async () => {
    // `monthly_estimate` is hourly × 730 — a projection of this instant, not a sum of
    // anything that happened. "Monthly estimate" is read as a bill owed, and it's
    // wrong in both directions: a machine shut down in an hour will never cost that,
    // and one launched tomorrow isn't in it. This is the portal's most expensive
    // misreading, so guided states the condition.
    const d = await costsSurface.mount(host, ctxAt("guided"));
    await settle();
    const labels = [...host.querySelectorAll(".costs-tile-label")].map((e) => e.textContent);
    expect(labels).not.toContain("Monthly estimate");
    expect(labels.join(" ")).toContain("If it keeps running");
    d.dispose();
  });

  it("offers a route to Instances at guided only", async () => {
    // A cost figure with no adjacent way to ACT on it is where a guided user gets
    // stuck: they can see they're spending money and not what to do about it. From
    // standard up the sidebar is enough.
    const navigate = vi.fn();
    const d = await costsSurface.mount(host, ctxAt("guided", navigate));
    await settle();
    host.querySelector<HTMLButtonElement>(".costs-goinstances")!.click();
    expect(navigate).toHaveBeenCalledWith("instances");
    d.dispose();

    host.innerHTML = "";
    const d2 = await costsSurface.mount(host, ctxAt("standard"));
    await settle();
    expect(host.querySelector(".costs-goinstances")).toBeNull();
    d2.dispose();
  });

  it("adds the window-total and peak tiles only at expert", async () => {
    // The existing tiles all read history[length-1], so "is this growing / did
    // something spike" is unanswerable from them — and that's the question a 90-day
    // window is opened to ask.
    for (const [level, expected] of [
      ["standard", false],
      ["expert", true],
    ] as const) {
      host.innerHTML = "";
      const d = await costsSurface.mount(host, ctxAt(level));
      await settle();
      const labels = [...host.querySelectorAll(".costs-tile-label")].map((e) => e.textContent).join(" ");
      expect(labels.includes("Peak hourly"), level).toBe(expected);
      expect(labels.includes("Window total"), level).toBe(expected);
      d.dispose();
    }
  });

  it("reports the peak from the whole window, not the last point", async () => {
    // The spike is mid-series, so a peak computed off history[length-1] would read
    // $1.25 and look plausible.
    const d = await costsSurface.mount(host, ctxAt("expert"));
    await settle();
    const peakTile = [...host.querySelectorAll(".costs-tile")].find((t) =>
      t.textContent!.includes("Peak hourly"),
    )!;
    // The figure and the date it came from are separate elements. Concatenating them
    // into the 1.5rem value wraps as "$4.25 · Jul" / "3", which reads as a broken
    // number — and "which sample" is unusable without knowing which one it was.
    expect(peakTile.querySelector(".costs-tile-value")!.textContent).toContain("4.25");
    // A date, not pinned to one: `fmtDate` renders the UTC timestamp in the runner's
    // local zone, so the spike's "Jul 3" is "Jul 2" west of Greenwich.
    expect(peakTile.querySelector(".costs-tile-note")!.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    d.dispose();
  });

  it("offers a 1-year preset only at expert", async () => {
    // Four buttons of noise is a cost paid by every user for a question only some are
    // asking.
    for (const [level, expected] of [
      ["guided", false],
      ["standard", false],
      ["expert", true],
    ] as const) {
      host.innerHTML = "";
      const d = await costsSurface.mount(host, ctxAt(level));
      await settle();
      const days = [...host.querySelectorAll<HTMLElement>(".costs-range")].map((b) => b.dataset.days);
      expect(days.includes("365"), level).toBe(expected);
      d.dispose();
    }
  });

  it("breaks the cost down by component in the table only at expert", async () => {
    // The API has always returned compute/storage/network per point and the UI always
    // dropped it. It's the difference between "spend is up" and "spend is up because
    // of storage, which shutting an instance down will not fix". The table carries it
    // as well as the tooltip, or it would be mouse-only.
    for (const [level, expected] of [
      ["standard", false],
      ["expert", true],
    ] as const) {
      host.innerHTML = "";
      // Reset the hash between iterations: the toggle persists there, so the second
      // mount would open already-showing-the-table and the click would turn it off.
      location.hash = "#/costs";
      const d = await costsSurface.mount(host, ctxAt(level));
      await settle();
      host.querySelector<HTMLButtonElement>(".costs-tabletoggle")!.click();
      const heads = [...host.querySelectorAll(".costs-table th")].map((t) => t.textContent);
      expect(heads.includes("Storage"), level).toBe(expected);
      d.dispose();
    }
  });

  it("shows an absent breakdown as unknown, not as zero", async () => {
    // Zero storage cost is a claim about the account, and a missing field is not
    // evidence for it.
    requestedDays = [];
    stubFetch([{ timestamp: "2026-07-01T00:00:00Z", hourly_cost: 0.5, monthly_estimate: 365, instance_count: 1 }]);
    const d = await costsSurface.mount(host, ctxAt("expert"));
    await settle();
    host.querySelector<HTMLButtonElement>(".costs-tabletoggle")!.click();
    const cells = [...host.querySelectorAll(".costs-table tbody td")].map((t) => t.textContent);
    expect(cells).toContain("—");
    expect(cells).not.toContain("$0.0000");
    d.dispose();
  });

  it("states the endpoint and sample density only at expert", async () => {
    // The chart looks like a continuous line but is N discrete samples the API chose
    // the spacing of, so a spike between them is invisible. Expert is the level that
    // can go ask the endpoint directly; below it this is noise.
    for (const [level, expected] of [
      ["standard", false],
      ["expert", true],
    ] as const) {
      host.innerHTML = "";
      const d = await costsSurface.mount(host, ctxAt(level));
      await settle();
      expect(host.querySelector(".costs-provenance") !== null, level).toBe(expected);
      d.dispose();
    }
  });

  describe("state survives a re-mount", () => {
    it("restores the chosen window", async () => {
      // A level change re-mounts this surface. Silently resetting a 90-day window to
      // 30 would make the mode control feel like it lost the user's place — which it
      // did.
      const first = await costsSurface.mount(host, ctxAt("standard"));
      await settle();
      host.querySelector<HTMLButtonElement>('.costs-range[data-days="90"]')!.click();
      await settle();
      first.dispose();

      host.innerHTML = "";
      requestedDays = [];
      const second = await costsSurface.mount(host, ctxAt("expert"));
      await settle();
      expect(requestedDays[0]).toBe(90);
      expect(
        host.querySelector<HTMLElement>('.costs-range[data-days="90"]')!.getAttribute("aria-pressed"),
      ).toBe("true");
      second.dispose();
    });

    it("restores the table view", async () => {
      const first = await costsSurface.mount(host, ctxAt("standard"));
      await settle();
      host.querySelector<HTMLButtonElement>(".costs-tabletoggle")!.click();
      expect(host.querySelector(".costs-table")).not.toBeNull();
      first.dispose();

      host.innerHTML = "";
      const second = await costsSurface.mount(host, ctxAt("standard"));
      await settle();
      expect(host.querySelector(".costs-table")).not.toBeNull();
      expect(host.querySelector(".costs-chart")).toBeNull();
      second.dispose();
    });

    it("ignores a window the current level doesn't offer", async () => {
      // `?days=365` is reachable from a bookmark made at expert, or by hand. At
      // standard there is no 365 button, so honouring it would show a year of data
      // above a control set that all reads unpressed — a view the user cannot undo.
      location.hash = "#/costs?days=365";
      const d = await costsSurface.mount(host, ctxAt("standard"));
      await settle();
      expect(requestedDays[0]).toBe(30);
      d.dispose();
    });
  });
});
