// What happens to a running watch when the surface goes away, and back.
//
// A Mode change re-mounts the current surface — that IS how a level change
// propagates — and lagotto's dispose() aborts the poll. What shipped therefore
// killed the watch AND cleared the four fields describing it, silently. So the
// behaviour under test is a pair, and neither half is sufficient alone:
//
//   - the form comes back, so the user doesn't retype a pattern, an AZ list and a
//     price cap from memory;
//   - the poll does NOT come back by itself, because it bills
//     DescribeInstanceTypeOfferings against the user's own account every interval,
//     and a mount they didn't ask for (a bookmark opened tomorrow — the hash
//     outlives the tab) must not start spending on their behalf.
//
// The negative assertions are the load-bearing ones: that a mount does not
// auto-poll, and that a watch the user *stopped* on purpose produces no "your watch
// was stopped" notice on the next mount. A notice that cries wolf is one the user
// learns to ignore, which costs exactly the case it was built for.
//
// The EC2 client is mocked at the module boundary. What's under test is the
// surface's lifecycle, not the two AWS calls — those are asserted through
// portalCapacityFinder's own inputs where it matters (that a poll happened at all).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../session.js";
import type { PortalConfig, SurfaceContext } from "./types.js";
import { LEVEL_CONTROL_NAME, type DisclosureLevel } from "../disclosure.js";
import { GUIDED_SHAPES, WATCH_SHAPES } from "../guided/shapes.js";
import { readHashParam } from "../hashstate.js";

/** Every DescribeInstanceTypeOfferings the surface issues, so a poll is observable. */
let searches = 0;
/** The `instance-type` filter values pushed server-side, so *what* is watched is too. */
let searchFilters: string[] = [];
/**
 * Offerings the mocked EC2 returns. Empty by default (the state a watch spends all
 * its time in); a test that needs a match sets it.
 */
let offerings: Array<{ InstanceType: string; Location: string }> = [];

vi.mock("@aws-sdk/client-ec2", () => {
  class DescribeInstanceTypeOfferingsCommand {
    constructor(public input: { Filters?: Array<{ Name?: string; Values?: string[] }> }) {}
  }
  class DescribeSpotPriceHistoryCommand {
    constructor(public input: unknown) {}
  }
  class EC2Client {
    destroy = vi.fn();
    async send(cmd: unknown): Promise<unknown> {
      if (cmd instanceof DescribeInstanceTypeOfferingsCommand) {
        searches++;
        for (const f of cmd.input.Filters ?? []) {
          if (f.Name === "instance-type") searchFilters.push(...(f.Values ?? []));
        }
        return { InstanceTypeOfferings: offerings };
      }
      return { SpotPriceHistory: [] };
    }
  }
  return { EC2Client, DescribeInstanceTypeOfferingsCommand, DescribeSpotPriceHistoryCommand };
});

const { lagottoSurface } = await import("./lagotto.js");

const settle = () => new Promise((r) => setTimeout(r, 0));

const config = { region: "us-east-1" } as PortalConfig;

function ctxAt(level: DisclosureLevel = "standard"): SurfaceContext {
  const session = new SessionController("us-east-1", null);
  session.setLevel(level);
  vi.spyOn(session, "getCreds").mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "token",
  } as never);
  return { session, config, level, navigate: vi.fn() };
}

/** Fill the form as a user would, firing the events the surface listens for. */
function fill(host: HTMLElement, v: { pattern?: string; max?: string; azs?: string; spot?: boolean }): void {
  const set = (sel: string, value: string) => {
    const el = host.querySelector<HTMLInputElement>(sel)!;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  if (v.pattern !== undefined) set(".lagotto-pattern", v.pattern);
  if (v.max !== undefined) set(".lagotto-maxprice", v.max);
  if (v.azs !== undefined) set(".lagotto-azs", v.azs);
  if (v.spot !== undefined) {
    const el = host.querySelector<HTMLInputElement>(".lagotto-spot")!;
    el.checked = v.spot;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

/**
 * Fire an expiry transition through the session's real listener set.
 *
 * Same idiom as shell.test.ts: arming the timer with a near-past expiration would
 * make this depend on wall-clock scheduling, and calling the surface's handler
 * directly would decouple the test from the `onExpiry` wiring it exists to cover.
 * `clear()` deliberately does NOT emit — it tears the session down without
 * announcing it — so driving expiry through clear() would prove nothing here.
 */
function fireExpiry(session: SessionController, state: "warning" | "expired"): void {
  const listeners = (session as unknown as { expiryListeners: Set<(s: string) => void> })
    .expiryListeners;
  for (const fn of listeners) fn(state);
}

const start = (host: HTMLElement) =>
  host.querySelector<HTMLFormElement>(".lagotto-form")!.dispatchEvent(new Event("submit", { cancelable: true }));

describe("lagottoSurface across a re-mount", () => {
  let host: HTMLElement;

  beforeEach(() => {
    searches = 0;
    searchFilters = [];
    offerings = [];
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    // The surface persists to the hash, so a leftover param from an earlier test
    // would pre-fill or falsely "resume" the next one.
    location.hash = "#/lagotto";
  });

  it("records the form in the hash as it is filled in", async () => {
    const d = await lagottoSurface.mount(host, ctxAt());
    await settle();
    fill(host, { pattern: "trn2.*", max: "12.50", azs: "us-east-1a, us-east-1b", spot: true });
    expect(readHashParam("pattern")).toBe("trn2.*");
    expect(readHashParam("max")).toBe("12.50");
    expect(readHashParam("azs")).toBe("us-east-1a, us-east-1b");
    expect(readHashParam("spot")).toBe("1");
    d.dispose();
  });

  it("omits the default cadence and an unchecked Spot from the hash", async () => {
    // Otherwise every visit writes `?every=60000&spot=` and the URL stops being
    // something a user would paste to a colleague.
    const d = await lagottoSurface.mount(host, ctxAt());
    await settle();
    fill(host, { pattern: "p5.*" });
    expect(readHashParam("every")).toBeNull();
    expect(readHashParam("spot")).toBeNull();
    d.dispose();
  });

  it("restores the form at the new level", async () => {
    const first = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    fill(host, { pattern: "trn2.*", max: "12.5", azs: "us-east-1b", spot: true });
    host.querySelector<HTMLSelectElement>(".lagotto-interval")!.value = "300000";
    host.querySelector<HTMLSelectElement>(".lagotto-interval")!.dispatchEvent(new Event("change", { bubbles: true }));

    // What the shell does on a Mode change.
    first.dispose();
    host.innerHTML = "";
    const second = await lagottoSurface.mount(host, ctxAt("expert"));
    await settle();

    expect(host.querySelector<HTMLInputElement>(".lagotto-pattern")!.value).toBe("trn2.*");
    expect(host.querySelector<HTMLInputElement>(".lagotto-maxprice")!.value).toBe("12.5");
    expect(host.querySelector<HTMLInputElement>(".lagotto-azs")!.value).toBe("us-east-1b");
    expect(host.querySelector<HTMLSelectElement>(".lagotto-interval")!.value).toBe("300000");
    expect(host.querySelector<HTMLInputElement>(".lagotto-spot")!.checked).toBe(true);
    second.dispose();
  });

  it("says the watch stopped, and does not silently resume it", async () => {
    // The whole issue. A watch is a live billing loop, so the re-mount restores the
    // parameters and hands the decision back to the user.
    const first = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    fill(host, { pattern: "p5.*" });
    start(host);
    await settle();
    expect(searches).toBeGreaterThan(0);
    expect(readHashParam("watching")).toBe("1");

    first.dispose();
    await settle();
    const searchesAtDispose = searches;

    host.innerHTML = "";
    const second = await lagottoSurface.mount(host, ctxAt("expert"));
    await settle();

    const notice = host.querySelector<HTMLElement>(".lagotto-resume");
    expect(notice).not.toBeNull();
    expect(notice!.hidden).toBe(false);
    expect(notice!.textContent).toMatch(/stopped/i);
    expect(host.querySelector(".lagotto-resume-go")).not.toBeNull();
    // Not auto-resumed: no further AWS call was made by the act of mounting.
    expect(searches).toBe(searchesAtDispose);
    // And the form the user would resume with is intact.
    expect(host.querySelector<HTMLInputElement>(".lagotto-pattern")!.value).toBe("p5.*");
    second.dispose();
  });

  it("resumes on the button, and only then", async () => {
    const first = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    fill(host, { pattern: "p5.*" });
    start(host);
    await settle();
    first.dispose();
    await settle();

    host.innerHTML = "";
    const second = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    const before = searches;
    host.querySelector<HTMLButtonElement>(".lagotto-resume-go")!.click();
    await settle();

    expect(searches).toBeGreaterThan(before);
    expect(host.querySelector<HTMLButtonElement>(".lagotto-stop")!.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>(".lagotto-resume")!.hidden).toBe(true);
    second.dispose();
  });

  it("shows no notice when the user stopped the watch on purpose", async () => {
    // Stop is not an interruption. Telling someone their watch "was stopped" when
    // they stopped it is the cry-wolf case that makes the real notice ignorable.
    const first = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    fill(host, { pattern: "p5.*" });
    start(host);
    await settle();
    host.querySelector<HTMLButtonElement>(".lagotto-stop")!.click();
    await settle();
    expect(readHashParam("watching")).toBeNull();

    first.dispose();
    host.innerHTML = "";
    const second = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    expect(host.querySelector<HTMLElement>(".lagotto-resume")!.hidden).toBe(true);
    second.dispose();
  });

  it("shows no notice when a watch was never started", async () => {
    const first = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    fill(host, { pattern: "p5.*", azs: "us-east-1a" });
    first.dispose();

    host.innerHTML = "";
    const second = await lagottoSurface.mount(host, ctxAt("expert"));
    await settle();
    expect(host.querySelector<HTMLElement>(".lagotto-resume")!.hidden).toBe(true);
    // The form still came back — persistence is not conditional on having watched.
    expect(host.querySelector<HTMLInputElement>(".lagotto-azs")!.value).toBe("us-east-1a");
    second.dispose();
  });

  it("persists an all-defaults watch, which fires no input event", async () => {
    // The gap a per-field `input` listener alone leaves: accept every default, hit
    // Start, change Mode — a live watch lost with nothing recorded to resume from.
    const first = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    const preset = host.querySelector<HTMLInputElement>(".lagotto-pattern")!.value;
    expect(preset).not.toBe(""); // the surface ships a default pattern
    start(host);
    await settle();
    expect(readHashParam("pattern")).toBe(preset);

    first.dispose();
    host.innerHTML = "";
    const second = await lagottoSurface.mount(host, ctxAt("expert"));
    await settle();
    expect(host.querySelector<HTMLElement>(".lagotto-resume")!.hidden).toBe(false);
    expect(host.querySelector<HTMLInputElement>(".lagotto-pattern")!.value).toBe(preset);
    second.dispose();
  });

  it("tells the user once, not on every later mount", async () => {
    // The flag is consumed when shown. Leaving it set would replay "your watch
    // stopped" for the rest of the session, long after it was true.
    const first = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    start(host);
    await settle();
    first.dispose();
    await settle();

    host.innerHTML = "";
    const second = await lagottoSurface.mount(host, ctxAt("expert"));
    await settle();
    expect(host.querySelector<HTMLElement>(".lagotto-resume")!.hidden).toBe(false);
    second.dispose();

    host.innerHTML = "";
    const third = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    expect(host.querySelector<HTMLElement>(".lagotto-resume")!.hidden).toBe(true);
    third.dispose();
  });

  it("offers a resume after a session expiry, not a dead form", async () => {
    // Expiry aborts the poll because the creds it signs with are gone — but the
    // watch is still wanted. After signing back in the user should get their
    // parameters and one click, not a blank form and no explanation.
    const ctx = ctxAt("standard");
    const first = await lagottoSurface.mount(host, ctx);
    await settle();
    fill(host, { pattern: "trn2.*" });
    start(host);
    await settle();

    fireExpiry(ctx.session, "expired");
    await settle();
    // The poll really did stop — otherwise the rest of this asserts nothing.
    expect(host.querySelector<HTMLButtonElement>(".lagotto-start")!.hidden).toBe(false);
    expect(host.querySelector(".lagotto-result")!.textContent).toMatch(/expired/i);
    expect(readHashParam("watching")).toBe("1");

    first.dispose();
    host.innerHTML = "";
    const second = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    expect(host.querySelector<HTMLElement>(".lagotto-resume")!.hidden).toBe(false);
    expect(host.querySelector<HTMLInputElement>(".lagotto-pattern")!.value).toBe("trn2.*");
    second.dispose();
  });

  it("cleans up at every level", async () => {
    for (const level of ["guided", "standard", "expert"] as const) {
      host.innerHTML = "";
      const d = await lagottoSurface.mount(host, ctxAt(level));
      await settle();
      d.dispose();
      expect(host.querySelector(".lagotto-surface"), level).toBeNull();
      // The picker resolves asynchronously, so a leaked one would keep writing into a
      // detached DOM after the level change that removed it.
      expect(host.querySelector(".guided-picker"), level).toBeNull();
    }
  });
});

// This surface's form asks for a glob or a regex over instance-type names, an AZ list,
// and a price cap in $/hr — every one of which is only writable by someone who already
// knows the answer. And the user who *needs* this page is by definition someone whose
// launch just failed for capacity, so it's the surface where the guided split matters
// most, not least.
describe("lagottoSurface at guided", () => {
  let host: HTMLElement;

  beforeEach(() => {
    searches = 0;
    searchFilters = [];
    offerings = [];
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    location.hash = "#/lagotto";
  });

  const cards = () => [...host.querySelectorAll<HTMLButtonElement>(".guided-card")];
  /** The picker resolves each card independently; wait for at least one to be clickable. */
  const readyCard = async (): Promise<HTMLButtonElement> => {
    for (let i = 0; i < 20; i++) {
      const c = cards().find((el) => !el.disabled);
      if (c) return c;
      await settle();
    }
    throw new Error("no card resolved");
  };

  it("shows cards instead of the pattern, AZ and price fields", async () => {
    const d = await lagottoSurface.mount(host, ctxAt("guided"));
    await settle();
    expect(cards().length).toBeGreaterThan(0);
    // The fields still exist — they're the single source of what's being watched, and
    // hiding rather than removing them is what keeps readWatch(), the hash persistence
    // and the Resume path working unchanged at every level.
    expect(host.querySelector(".lagotto-pattern")).not.toBeNull();
    expect(host.querySelector(".lagotto-surface")!.className).toContain("lagotto-guided");
    // But "Start watching" must not be offered: at guided the cards ARE the start
    // control, and a button above no visible fields describes nothing.
    expect(host.querySelector<HTMLButtonElement>(".lagotto-start")!.hidden).toBe(true);
    d.dispose();
  });

  it("shows the fields and no cards from standard up", async () => {
    for (const level of ["standard", "expert"] as const) {
      host.innerHTML = "";
      const d = await lagottoSurface.mount(host, ctxAt(level));
      await settle();
      expect(host.querySelector(".guided-card"), level).toBeNull();
      expect(host.querySelector<HTMLButtonElement>(".lagotto-start")!.hidden, level).toBe(false);
      d.dispose();
    }
  });

  it("offers shapes worth waiting for, not the launch list", async () => {
    // You do not wait for a t4g.xlarge. Offering "A small analysis" here would offer a
    // poll that succeeds on its first check, forever — which teaches the user the page
    // does nothing. Asserted through the rendered DOM rather than the constant, because
    // the constant being right doesn't establish that this surface passes it.
    const d = await lagottoSurface.mount(host, ctxAt("guided"));
    await settle();
    const labels = cards().map((c) => c.querySelector(".guided-card-label")!.textContent!);
    expect(labels).toEqual(WATCH_SHAPES.map((s) => s.label));
    for (const s of GUIDED_SHAPES) expect(labels).not.toContain(s.label);
    d.dispose();
  });

  it("does not price a watch as if it were a launch", async () => {
    // The launch flow's "about $110 for 2 hours" is a claim about a run, and this page
    // starts no run — it starts a poll, which is free. Getting this wrong would quote a
    // charge for the one action on the page that doesn't incur one.
    const d = await lagottoSurface.mount(host, ctxAt("guided"));
    const card = await readyCard();
    // Collapsed: the copy is a wrapped template literal, so the words are separated by
    // newlines in the DOM and a naive /once you launch it/ would fail on formatting.
    const cost = card.querySelector(".guided-card-cost")!.textContent!.replace(/\s+/g, " ");
    expect(cost).toMatch(/watching costs nothing/i);
    expect(cost).toMatch(/once you launch it/i);
    expect(cost).not.toMatch(/for \d+ hours/);
    d.dispose();
  });

  it("starts a watch on the picked family, not on the one cheapest type", async () => {
    // `p5.48xlarge` being full while `p5.4xlarge` is free is a match the user wants, so
    // the watch is the family. Asserted on the filter the surface actually sent to EC2,
    // which is the thing that decides what gets watched.
    const d = await lagottoSurface.mount(host, ctxAt("guided"));
    const card = await readyCard();
    card.click();
    await settle();

    expect(searches).toBeGreaterThan(0);
    expect(host.querySelector<HTMLInputElement>(".lagotto-pattern")!.value).toMatch(/^[a-z0-9-]+\.\*$/);
    expect(searchFilters.length).toBeGreaterThan(0);
    // `p5.*` in EC2 filter syntax, where `.` is literal and `*` is the wildcard — the
    // family, pushed server-side. Not `*`: a filter that matched everything would poll
    // the whole region and match on the first check.
    expect(searchFilters[0]).toMatch(/^[a-z0-9-]+\.\*$/);
    // And the watch is live, so Stop is the way out.
    expect(host.querySelector<HTMLButtonElement>(".lagotto-stop")!.hidden).toBe(false);
    d.dispose();
  });

  it("hides the cards while a watch is running", async () => {
    // Clicking a second card mid-watch would abandon the first without saying so.
    // Making Stop the only way forward is the honest shape of "one watch per tab".
    const d = await lagottoSurface.mount(host, ctxAt("guided"));
    const card = await readyCard();
    expect(host.querySelector<HTMLElement>(".lagotto-picker")!.hidden).toBe(false);
    card.click();
    await settle();
    expect(host.querySelector<HTMLElement>(".lagotto-picker")!.hidden).toBe(true);

    host.querySelector<HTMLButtonElement>(".lagotto-stop")!.click();
    await settle();
    expect(host.querySelector<HTMLElement>(".lagotto-picker")!.hidden).toBe(false);
    d.dispose();
  });

  it("survives a Mode change into standard with the picked pattern intact", async () => {
    // The two halves of #513 have to compose: a guided user picks a card, changes Mode,
    // and lands in the standard form. The pattern the card chose must be there — it's
    // the one thing they can't retype, having never seen it.
    const first = await lagottoSurface.mount(host, ctxAt("guided"));
    const card = await readyCard();
    card.click();
    await settle();
    const pattern = host.querySelector<HTMLInputElement>(".lagotto-pattern")!.value;
    expect(pattern).toMatch(/\.\*$/);

    first.dispose();
    await settle();
    host.innerHTML = "";
    const second = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();

    expect(host.querySelector<HTMLInputElement>(".lagotto-pattern")!.value).toBe(pattern);
    expect(host.querySelector<HTMLElement>(".lagotto-resume")!.hidden).toBe(false);
    second.dispose();
  });

  it("names the type in the resume notice, since the fields aren't on screen", async () => {
    // "Your settings below are as you left them" points at a form a guided user can't
    // see and never filled in. The type is the one fact they need to decide whether to
    // resume, and it's the one they never typed.
    const first = await lagottoSurface.mount(host, ctxAt("guided"));
    const card = await readyCard();
    card.click();
    await settle();
    const pattern = host.querySelector<HTMLInputElement>(".lagotto-pattern")!.value;
    first.dispose();
    await settle();

    host.innerHTML = "";
    const second = await lagottoSurface.mount(host, ctxAt("guided"));
    await settle();
    const notice = host.querySelector<HTMLElement>(".lagotto-resume")!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain(pattern);
    expect(notice.textContent).not.toMatch(/settings below/i);
    second.dispose();
  });

  it("tells a guided user how to launch what it found", async () => {
    // Guided mode's Instances page offers five LAUNCH shapes, and only the H100 one
    // overlaps this list — so "launch it from Instances" would send someone who waited
    // for a B200 to a picker that can't launch one. A dead end at the exact moment
    // capacity is available is the most expensive place to have one.
    offerings = [{ InstanceType: "p5.48xlarge", Location: "us-east-1b" }];
    const d = await lagottoSurface.mount(host, ctxAt("guided"));
    const card = await readyCard();
    card.click();
    await settle();

    const next = host.querySelector(".lagotto-match-next");
    expect(next, "expected a match with offerings present").not.toBeNull();
    expect(next!.textContent).toContain("p5.48xlarge");
    expect(next!.textContent).toContain("us-east-1b");
    // Names the control that gets them there, rather than only the page.
    expect(next!.textContent).toMatch(new RegExp(LEVEL_CONTROL_NAME));
    expect(next!.textContent).toMatch(/standard/i);
    d.dispose();
  });

  it("keeps the standard match copy at standard", async () => {
    offerings = [{ InstanceType: "p5.48xlarge", Location: "us-east-1b" }];
    const d = await lagottoSurface.mount(host, ctxAt("standard"));
    await settle();
    fill(host, { pattern: "p5.*" });
    start(host);
    await settle();
    const next = host.querySelector(".lagotto-match-next")!;
    expect(next.textContent).toMatch(/InsufficientInstanceCapacity/);
    expect(next.textContent).not.toMatch(/switch/i);
    d.dispose();
  });

  it("raises the level rather than navigating on the escape", async () => {
    // One level up is the pattern field, on this same surface — navigating elsewhere
    // would answer a different question.
    const ctx = ctxAt("guided");
    const d = await lagottoSurface.mount(host, ctx);
    await settle();
    host.querySelector<HTMLButtonElement>(".guided-escape")!.click();
    expect(ctx.session.level).toBe("standard");
    expect(ctx.navigate).not.toHaveBeenCalled();
    d.dispose();
  });
});
