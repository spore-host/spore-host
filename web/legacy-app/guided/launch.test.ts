// The guided launch panel, driven against a stub SpawnClient.
//
// The real path needs federated AWS credentials and would bill for an instance, so
// launch() is stubbed and what's asserted is the *shape of the request* — which is
// where the cost-safety properties live. A guided launch with no TTL, or on spot,
// would be a real defect that no amount of live clicking would reveal until it
// cost someone money.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnClient } from "@spore-host/spawn-ts";
import { mountGuidedLaunch } from "./launch.js";
import { GUIDED_SHAPES } from "./shapes.js";
import { costLimitFor } from "./cost.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A SpawnClient stand-in exposing only what the panel calls. */
function stubClient(impl?: (input: unknown) => Promise<unknown>) {
  const launch = vi.fn(
    impl ?? (async (input: any) => ({ instanceId: "i-0abc", name: input.name })),
  );
  return { client: { launch } as unknown as SpawnClient, launch };
}

describe("mountGuidedLaunch", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  async function pickFirst(client: SpawnClient, onEscape = vi.fn()) {
    const dispose = mountGuidedLaunch(host, { client, region: "us-east-1", onEscape });
    await settle();
    host.querySelector<HTMLButtonElement>(".guided-card")!.click();
    await settle();
    return dispose;
  }

  it("shows the picker first", async () => {
    const { client } = stubClient();
    const dispose = mountGuidedLaunch(host, { client, region: "us-east-1", onEscape: vi.fn() });
    await settle();
    expect(host.querySelectorAll(".guided-card")).toHaveLength(GUIDED_SHAPES.length);
    expect(host.querySelector(".guided-confirm")).toBeNull();
    dispose();
  });

  it("confirms with the machine, region, cost and shutdown before launching", async () => {
    const { client, launch } = stubClient();
    const dispose = await pickFirst(client);

    const confirm = host.querySelector<HTMLElement>(".guided-confirm")!;
    expect(confirm).toBeTruthy();
    const text = confirm.textContent!.replace(/\s+/g, " ");
    expect(text).toMatch(/t4g|[a-z0-9-]+\.[a-z0-9]+/); // a real instance type
    expect(text).toContain("us-east-1");
    expect(text).toMatch(/\$\d/);
    // The shutdown promise is the one thing a guided user must see before they
    // commit — it's what makes an unattended instance safe.
    expect(text).toMatch(/hours/);
    expect(text.toLowerCase()).toContain("automatically");
    // Nothing launched yet: confirmation is a step, not a formality.
    expect(launch).not.toHaveBeenCalled();
    dispose();
  });

  it("says the limit is enforced on the machine, not by the tab", async () => {
    // A user who closes the tab must not be left thinking their instance now runs
    // forever — nor thinking it was killed. Both are wrong.
    const { client } = stubClient();
    const dispose = await pickFirst(client);
    expect(host.querySelector(".guided-reassure")!.textContent).toContain("close this tab");
    dispose();
  });

  it("does not promise the shutdown happens 'whatever happens'", async () => {
    // The portal ships an orphan banner for precisely the case where spored fails
    // to reap an instance, so copy claiming the shutdown is unconditional is
    // contradicted by another component of the same page. It must say what the
    // fallback is instead of denying the failure exists.
    const { client } = stubClient();
    const dispose = await pickFirst(client);
    const text = host.querySelector(".guided-confirm")!.textContent!.replace(/\s+/g, " ");
    expect(text).not.toContain("whatever happens");
    expect(text.toLowerCase()).toContain("if that ever fails");
    dispose();
  });

  it("names the spend cap alongside the time limit", async () => {
    // Two guards that fail differently, so both are stated: the TTL runs on the
    // instance and dies with the daemon, while the cost limit is derived from tags.
    const { client } = stubClient();
    const dispose = await pickFirst(client);
    const text = host.querySelector(".guided-facts")!.textContent!.replace(/\s+/g, " ");
    expect(text).toMatch(/\$\d+ of spend/);
    dispose();
  });

  it("says the price excludes storage and transfer", async () => {
    // "Up to $X" is a bound the figure doesn't actually bound — it's
    // onDemandPrice × hours, with no EBS and no egress.
    const { client } = stubClient();
    const dispose = await pickFirst(client);
    expect(host.querySelector(".guided-cost")!.textContent).toContain("Compute only");
    dispose();
  });

  it("says spot is off and what that costs", async () => {
    // The right default, but silent: guided mode systematically pays ~3× spot
    // without ever mentioning that spot exists.
    const { client } = stubClient();
    const dispose = await pickFirst(client);
    const text = host.querySelector(".guided-facts")!.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("not spot");
    dispose();
  });

  it("qualifies the price when the session's region isn't the catalog's", async () => {
    // The confirmation renders the session region and a us-east-1 catalog price as
    // two adjacent facts. Outside us-east-1 they are not the same fact, and
    // priceIsEstimate doesn't cover it — it flags hand-seeded entries only.
    const { client } = stubClient();
    const dispose = mountGuidedLaunch(host, {
      client,
      region: "ap-southeast-2",
      onEscape: vi.fn(),
    });
    await settle();
    host.querySelector<HTMLButtonElement>(".guided-card")!.click();
    await settle();
    const cost = host.querySelector(".guided-cost")!.textContent!.replace(/\s+/g, " ");
    expect(cost).toContain("us-east-1");
    expect(cost).toContain("ap-southeast-2");
    dispose();
  });

  it("does not qualify the price in the catalog's own region", async () => {
    // A caveat that fires always is one nobody reads.
    const { client } = stubClient();
    const dispose = await pickFirst(client); // region: us-east-1
    expect(host.querySelector(".guided-cost")!.textContent).not.toContain("may differ");
    dispose();
  });

  it("offers the escape hatch on the confirmation, not just the picker", async () => {
    // This is the moment the user learns what guided mode chose, so it's the moment
    // they discover it's too small. Without this the only way onward is back to the
    // same five cards.
    const onEscape = vi.fn();
    const { client } = stubClient();
    const dispose = await pickFirst(client, onEscape);
    expect(host.querySelector(".guided-confirm")).toBeTruthy();
    host.querySelector<HTMLButtonElement>(".guided-confirm .guided-escape")!.click();
    expect(onEscape).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("launches with a TTL and without spot", async () => {
    const { client, launch } = stubClient();
    const dispose = await pickFirst(client);
    host.querySelector<HTMLButtonElement>(".guided-go")!.click();
    await settle();

    expect(launch).toHaveBeenCalledTimes(1);
    const input = launch.mock.calls[0]![0] as any;
    const shape = GUIDED_SHAPES[0]!;
    // A TTL is the hard cost backstop; a guided launch must never be unbounded.
    expect(input.ttl).toBe(`${shape.defaultTtlHours}h`);
    // Not spot: a beginner's first instance should not vanish mid-run with no
    // explanation they could act on.
    expect(input.spot).toBe(false);
    expect(input.region).toBe("us-east-1");
    expect(input.instanceType).toMatch(/^[a-z0-9-]+\.[a-z0-9]+$/);
    // The price travels with the launch so the Dashboard's cost meter reflects
    // THIS instance instead of its hardcoded default.
    expect(input.pricePerHour).toBeGreaterThan(0);
    dispose();
  });

  it("launches with a cost limit above the expected spend", async () => {
    // The second guard, and the reason it isn't redundant with the TTL: the TTL is
    // enforced by spored ON the instance, so an instance whose daemon never starts
    // is bounded by nothing — which is why the Dashboard ships an orphan banner. A
    // cost limit is derived from the tags, so it survives the daemon failing.
    const { client, launch } = stubClient();
    const dispose = await pickFirst(client);
    host.querySelector<HTMLButtonElement>(".guided-go")!.click();
    await settle();

    const input = launch.mock.calls[0]![0] as any;
    const shape = GUIDED_SHAPES[0]!;
    expect(input.costLimit).toBe(costLimitFor(input.pricePerHour, shape.defaultTtlHours));
    // Above the expected spend, so it bounds a runaway instead of aborting a
    // healthy run that merely reached its TTL.
    expect(input.costLimit).toBeGreaterThan(input.pricePerHour * shape.defaultTtlHours);
    dispose();
  });

  describe("when the catalog has no price", () => {
    // The shapes that land here are the accelerator ones — types with no on-demand
    // row are the $30-100/hr machines, so this is the branch where an accidental
    // click is most expensive. The real catalog never produces it, so it is only
    // ever exercised here.
    const unpriced = [{ ...GUIDED_SHAPES[0]!, id: "unpriced", defaultTtlHours: 2 }];
    const finder = async () => [
      {
        instance: {
          instanceType: "p6e-gb200.36xlarge",
          vcpus: 144,
          memoryMib: 1024 * 1024,
          gpus: 72,
          gpuModel: "B200",
          // No onDemandPrice at all — truffle-ts 0.5.0 carries no price rather
          // than a guessed one for these.
        },
        score: 1,
        reasons: [],
      } as any,
    ];

    async function mountUnpriced(client: SpawnClient) {
      const dispose = mountGuidedLaunch(host, {
        client,
        region: "us-east-1",
        onEscape: vi.fn(),
        shapes: unpriced,
        finder,
      });
      await settle();
      host.querySelector<HTMLButtonElement>(".guided-card")!.click();
      await settle();
      return dispose;
    }

    it("will not launch until the user acknowledges the unknown cost", async () => {
      const { client, launch } = stubClient();
      const dispose = await mountUnpriced(client);

      const go = host.querySelector<HTMLButtonElement>(".guided-go")!;
      expect(go.disabled).toBe(true);
      go.click();
      await settle();
      expect(launch).not.toHaveBeenCalled();

      host.querySelector<HTMLInputElement>(".guided-ack-box")!.click();
      expect(go.disabled).toBe(false);
      go.click();
      await settle();
      expect(launch).toHaveBeenCalledTimes(1);
      dispose();
    });

    it("omits costLimit rather than sending zero", async () => {
      // spawn-ts reads a non-positive costLimit as "no limit", so a 0 would look
      // like a guard at the call site while being none — the worst pairing. The
      // field must be absent.
      const { client, launch } = stubClient();
      const dispose = await mountUnpriced(client);
      host.querySelector<HTMLInputElement>(".guided-ack-box")!.click();
      host.querySelector<HTMLButtonElement>(".guided-go")!.click();
      await settle();

      const input = launch.mock.calls[0]![0] as any;
      expect("costLimit" in input).toBe(false);
      // The TTL still applies — it's the only guard left, so it must not be lost too.
      expect(input.ttl).toBe("2h");
      dispose();
    });

    it("says unpriced machines are usually the expensive ones", async () => {
      const { client } = stubClient();
      const dispose = await mountUnpriced(client);
      const cost = host.querySelector(".guided-cost")!.textContent!.replace(/\s+/g, " ");
      expect(cost).toContain("most expensive");
      dispose();
    });
  });

  it("names the instance distinguishably", async () => {
    // A guided user will click the same shape twice, and two instances with the
    // same name are indistinguishable at exactly the moment they need to terminate
    // one of them.
    const { client, launch } = stubClient();
    const d1 = await pickFirst(client);
    host.querySelector<HTMLButtonElement>(".guided-go")!.click();
    await settle();
    const name = (launch.mock.calls[0]![0] as any).name as string;
    expect(name).toContain(GUIDED_SHAPES[0]!.id);
    expect(name.length).toBeGreaterThan(GUIDED_SHAPES[0]!.id.length + 1);
    d1();
  });

  it("reports success with the instance id", async () => {
    const { client } = stubClient();
    const dispose = await pickFirst(client);
    host.querySelector<HTMLButtonElement>(".guided-go")!.click();
    await settle();
    const msg = host.querySelector<HTMLElement>(".guided-msg")!;
    expect(msg.className).toContain("ok");
    expect(msg.textContent).toContain("i-0abc");
    dispose();
  });

  it("surfaces the real error text on failure and re-enables the button", async () => {
    // A guided user is the least able to diagnose a vague error, so "couldn't
    // start it" alone is the least helpful thing we could say — a quota failure
    // and a permission failure both land here and read completely differently.
    const { client } = stubClient(async () => {
      throw new Error("VcpuLimitExceeded: you have requested more vCPU capacity");
    });
    const dispose = await pickFirst(client);
    const go = host.querySelector<HTMLButtonElement>(".guided-go")!;
    go.click();
    await settle();

    const msg = host.querySelector<HTMLElement>(".guided-msg")!;
    expect(msg.className).toContain("error");
    expect(msg.textContent).toContain("VcpuLimitExceeded");
    // Retryable: a quota bump or a different shape may well work.
    expect(go.disabled).toBe(false);
    dispose();
  });

  it("disables the button while launching so one click is one instance", async () => {
    let release!: () => void;
    const { client, launch } = stubClient(
      () => new Promise((r) => (release = () => r({ instanceId: "i-1", name: "n" }))),
    );
    const dispose = await pickFirst(client);
    const go = host.querySelector<HTMLButtonElement>(".guided-go")!;
    go.click();
    await settle();
    expect(go.disabled).toBe(true);
    go.click(); // an impatient second click must not launch a second instance
    go.click();
    await settle();
    expect(launch).toHaveBeenCalledTimes(1);
    release();
    await settle();
    dispose();
  });

  it("lets the user go back to the picker without launching", async () => {
    const { client, launch } = stubClient();
    const dispose = await pickFirst(client);
    host.querySelector<HTMLButtonElement>(".guided-back")!.click();
    await settle();
    expect(host.querySelectorAll(".guided-card")).toHaveLength(GUIDED_SHAPES.length);
    expect(host.querySelector(".guided-confirm")).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    dispose();
  });

  describe("when a shape is carried in from another surface", () => {
    // The truffle surface's picker is auth-free and cannot launch, so it navigates to
    // `#/instances?shape=<id>`. Without honouring that the user who chose "A big GPU
    // for training" met an identical picker asking the same question again — the
    // choice they'd just made, discarded.
    it("opens the confirmation for that shape without a second click", async () => {
      const { client } = stubClient();
      const shape = GUIDED_SHAPES[3]!; // a GPU shape, not the default first card
      const dispose = mountGuidedLaunch(host, {
        client,
        region: "us-east-1",
        onEscape: vi.fn(),
        initialShapeId: shape.id,
      });
      await settle();
      const confirm = host.querySelector<HTMLElement>(".guided-confirm");
      expect(confirm).toBeTruthy();
      // The right shape, not merely some shape: carrying the wrong card over would
      // be worse than carrying none.
      expect(confirm!.querySelector("h2")!.textContent).toBe(shape.label);
      dispose();
    });

    it("falls back to the picker for an unknown id", async () => {
      // This value comes from the URL, so a stale bookmark or a hand-typed hash is
      // expected input, not a fault. It must not error and must not blank the panel.
      const { client } = stubClient();
      const dispose = mountGuidedLaunch(host, {
        client,
        region: "us-east-1",
        onEscape: vi.fn(),
        initialShapeId: "no-such-shape",
      });
      await settle();
      expect(host.querySelectorAll(".guided-card")).toHaveLength(GUIDED_SHAPES.length);
      expect(host.querySelector(".guided-confirm")).toBeNull();
      dispose();
    });

    it("leaves the user on the picker when the catalog lookup fails", async () => {
      // A jump that can't resolve must land somewhere usable. Showing the picker
      // meanwhile (rather than after) is what makes that true even for a slow catalog.
      const { client } = stubClient();
      const shape = GUIDED_SHAPES[0]!;
      const dispose = mountGuidedLaunch(host, {
        client,
        region: "us-east-1",
        onEscape: vi.fn(),
        initialShapeId: shape.id,
        finder: async () => {
          throw new Error("catalog unreadable");
        },
      });
      await settle();
      expect(host.querySelector(".guided-confirm")).toBeNull();
      expect(host.querySelector(".guided-picker")).toBeTruthy();
      dispose();
    });

    it("opens no confirmation when the shape resolves to nothing", async () => {
      // resolveShape returns undefined for a no-match, which is a fact about the
      // catalog — distinct from a failure, and distinct from a machine we can price.
      // Confirming a launch for an unresolved shape would be confirming nothing.
      const { client } = stubClient();
      const shape = GUIDED_SHAPES[0]!;
      const dispose = mountGuidedLaunch(host, {
        client,
        region: "us-east-1",
        onEscape: vi.fn(),
        initialShapeId: shape.id,
        finder: async () => [],
      });
      await settle();
      expect(host.querySelector(".guided-confirm")).toBeNull();
      expect(host.querySelector(".guided-card.unresolved")).toBeTruthy();
      dispose();
    });
  });

  it("passes the escape hatch through", async () => {
    const onEscape = vi.fn();
    const { client } = stubClient();
    const dispose = mountGuidedLaunch(host, { client, region: "us-east-1", onEscape });
    await settle();
    host.querySelector<HTMLButtonElement>(".guided-escape")!.click();
    expect(onEscape).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does not write a result into a detached DOM after dispose", async () => {
    let release!: () => void;
    const { client } = stubClient(
      () => new Promise((r) => (release = () => r({ instanceId: "i-2", name: "n" }))),
    );
    const dispose = await pickFirst(client);
    host.querySelector<HTMLButtonElement>(".guided-go")!.click();
    await settle();
    dispose();
    release();
    await settle();
    expect(host.querySelector(".guided-launch")).toBeNull();
  });
});
