// These tests run against truffle-ts's REAL bundled catalog, not a fixture.
//
// That's deliberate and it's the point of the file. The plan's headline check is
// "set the level to guided with the advisor absent and confirm the curated picker
// still returns real instance types and live prices" — a fixture would pass that
// check while the shipped portal quoted a fabricated $0.20/hr B200. The catalog is
// offline and bundled, so there is no network cost to using the real thing.
//
// The trade-off is that a catalog regeneration can turn these red. That is the
// intended behaviour: a shape whose query stops matching, or whose cheapest match
// becomes a $55/hr box, is a defect in the portal's most vulnerable path and
// should fail loudly rather than ship.

import { describe, expect, it } from "vitest";
import type { FindResult } from "@spore-host/truffle-ts";
import { compilePattern } from "@spore-host/lagotto-ts";
import {
  GUIDED_SHAPES,
  WATCH_SHAPES,
  resolveAllShapes,
  resolveShape,
  watchPattern,
} from "./shapes.js";

describe("GUIDED_SHAPES", () => {
  it("has unique ids", () => {
    const ids = GUIDED_SHAPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every shape a TTL", () => {
    // A guided launch with no time limit is the single most expensive mistake
    // available in this UI, and "I forgot it was running" is the normal way it
    // happens. There is no valid zero here.
    for (const s of GUIDED_SHAPES) {
      expect(s.defaultTtlHours, s.id).toBeGreaterThan(0);
    }
  });

  it("keeps GPU shapes on shorter TTLs than CPU shapes", () => {
    // At H100 prices the TTL *is* the cost control: a forgotten p5 costs more per
    // hour than most of the others cost per day.
    const gpuMax = Math.max(...GUIDED_SHAPES.filter((s) => s.wantsGpu).map((s) => s.defaultTtlHours));
    const cpuMin = Math.min(...GUIDED_SHAPES.filter((s) => !s.wantsGpu).map((s) => s.defaultTtlHours));
    expect(gpuMax).toBeLessThanOrEqual(cpuMin);
  });

  it("labels shapes in user vocabulary, not hardware vocabulary", () => {
    // The whole reason guided mode exists is that "gpu with 80gb for training" is
    // only writable by someone who already knows what they need. A label carrying
    // an instance type would reintroduce exactly that.
    for (const s of GUIDED_SHAPES) {
      expect(s.label, s.id).not.toMatch(/\b[a-z]\d[a-z]*\.\w+\b/);
      expect(s.blurb.length, s.id).toBeGreaterThan(0);
    }
  });
});

describe("resolveShape against the real bundled catalog", () => {
  it("resolves every curated shape to a real instance type", async () => {
    // THE headline test. Every shape must produce a machine — an unresolvable
    // entry in the beginner's only menu is a dead end for the user least equipped
    // to work around it.
    const recs = await resolveAllShapes();
    expect(recs).toHaveLength(GUIDED_SHAPES.length);
    recs.forEach((rec, i) => {
      const shape = GUIDED_SHAPES[i]!;
      expect(rec, `${shape.id} resolved to nothing — query "${shape.query}" matched no instance`).toBeDefined();
      expect(rec!.pick.instance.instanceType, shape.id).toMatch(/^[a-z0-9-]+\.[a-z0-9]+$/);
      expect(rec!.totalMatches, shape.id).toBeGreaterThan(0);
    });
  });

  it("quotes a usable price and a total for every shape", async () => {
    const recs = await resolveAllShapes();
    for (const rec of recs) {
      // A zero would sort first and read as free; a null would leave the guided
      // user with no cost information at all. Both are failures here.
      expect(rec!.pricePerHour, rec!.shape.id).toBeGreaterThan(0);
      expect(rec!.estimatedTotal, rec!.shape.id).toBeCloseTo(
        rec!.pricePerHour! * rec!.shape.defaultTtlHours,
        6,
      );
    }
  });

  it("picks the CHEAPEST match, not truffle's first", async () => {
    // truffle-ts treats vcpus/memory as MINIMUMS and ranks by its own size
    // preference: find("4 vcpus 16gb") returns r8g.12xlarge (48 vCPU, 384 GiB,
    // ~$2.83/hr) first, while t4g.xlarge (exactly 4/16, ~$0.13/hr) is further
    // down. Handing over truffle's first result would quote 21× the right cost.
    const small = GUIDED_SHAPES.find((s) => s.id === "small-analysis")!;
    const rec = (await resolveShape(small))!;

    const { find } = await import("@spore-host/truffle-ts");
    const raw = await find(small.query);
    const rawFirstPrice = raw[0]!.instance.onDemandPrice;

    expect(rec.pricePerHour).toBeLessThanOrEqual(rawFirstPrice ?? Infinity);
    // And it must beat every other priced candidate. This filter carried a
    // `!isQuarantined(r)` exemption until truffle-ts 0.5.0 fixed the two
    // fabricated prices (truffle-ts#39, #42); with the data correct, the
    // assertion holds over the whole result set, which is the stronger claim.
    const better = raw.filter((r) => usable(r) && r.instance.onDemandPrice! < rec.pricePerHour!);
    expect(better.map((r) => r.instance.instanceType)).toEqual([]);
  });

  it("does not hand a non-GPU shape a GPU instance", async () => {
    // Without the CPU-only narrowing, "8 vcpus 128gb" picks g3.4xlarge (1× M60)
    // — charging a user who asked for memory for a decade-old accelerator they
    // cannot use. truffle-ts 0.5.0 makes this MORE likely, not less: g3 now
    // carries its real $1.14 rather than the old $0.80 guess, but it's still the
    // cheapest thing matching that query.
    const recs = await resolveAllShapes();
    for (const rec of recs) {
      if (rec!.shape.wantsGpu) continue;
      expect(rec!.pick.instance.gpus ?? 0, `${rec!.shape.id} → ${rec!.pick.instance.instanceType}`).toBe(0);
    }
  });

  it("gives GPU shapes an actual GPU", async () => {
    const recs = await resolveAllShapes();
    for (const rec of recs) {
      if (!rec!.shape.wantsGpu) continue;
      expect(rec!.pick.instance.gpus ?? 0, rec!.shape.id).toBeGreaterThan(0);
    }
  });

  it("excludes the known-bad catalog prices", async () => {
    // truffle-ts#39 (p6e-gb200.36xlarge at $0.2000/hr for 72× B200) and #42
    // (p5.4xlarge at onDemandPrice 0) both WIN a naive price sort. A price-ranked
    // picker is maximally exposed to a fabricated low price.
    const recs = await resolveAllShapes();
    const picked = recs.map((r) => r!.pick.instance.instanceType);
    expect(picked).not.toContain("p6e-gb200.36xlarge");
    expect(picked).not.toContain("p5.4xlarge");
  });

  it("keeps the cheap CPU shape genuinely cheap", async () => {
    // A regression fence, not a spec. If a catalog change makes the beginner's
    // first instance cost dollars per hour, that must fail here rather than
    // surprise a first-time user.
    const rec = (await resolveShape(GUIDED_SHAPES.find((s) => s.id === "small-analysis")!))!;
    expect(rec.pricePerHour).toBeLessThan(0.5);
  });
});

describe("resolveShape error and absence handling", () => {
  it("returns undefined for a query that matches nothing", async () => {
    const rec = await resolveShape(GUIDED_SHAPES[0]!, async () => []);
    expect(rec).toBeUndefined();
  });

  it("propagates a finder failure instead of reporting no matches", async () => {
    // The #63 invariant: an error must never be indistinguishable from an absence
    // of data. "The catalog is broken" and "nothing matches your query" are
    // different facts and the second one is a claim we can't support here.
    await expect(
      resolveShape(GUIDED_SHAPES[0]!, async () => {
        throw new Error("catalog unreadable");
      }),
    ).rejects.toThrow("catalog unreadable");
  });

  it("falls back to the top match with an unknown price when nothing is priced", async () => {
    const shape = GUIDED_SHAPES[0]!;
    const rec = (await resolveShape(shape, async () => [
      stub({ instanceType: "x1.unknown", onDemandPrice: undefined }),
      stub({ instanceType: "x2.unknown", onDemandPrice: 0 }),
    ]))!;
    expect(rec.pick.instance.instanceType).toBe("x1.unknown");
    // Reported as unknown, not invented and not zero: zero would render as free.
    expect(rec.pricePerHour).toBeUndefined();
    expect(rec.estimatedTotal).toBeUndefined();
  });

  it("treats a zero price as missing data", async () => {
    const rec = (await resolveShape(GUIDED_SHAPES[0]!, async () => [
      stub({ instanceType: "free.lie", onDemandPrice: 0 }),
      stub({ instanceType: "real.one", onDemandPrice: 1.5 }),
    ]))!;
    // No EC2 type costs nothing per hour, so a zero can only be an artifact —
    // and it would otherwise sort first and win.
    expect(rec.pick.instance.instanceType).toBe("real.one");
    expect(rec.pricePerHour).toBe(1.5);
  });

  it("still recommends a GPU box when a non-GPU shape has no CPU-only match", async () => {
    // Narrowing to CPU-only must not turn into "no recommendation": an unexpected
    // accelerator whose price we can show beats a dead card.
    const cpuShape = GUIDED_SHAPES.find((s) => !s.wantsGpu)!;
    const rec = (await resolveShape(cpuShape, async () => [
      stub({ instanceType: "g9.big", onDemandPrice: 3, gpus: 1 }),
    ]))!;
    expect(rec.pick.instance.instanceType).toBe("g9.big");
  });

  it("marks an estimated price as estimated", async () => {
    const rec = (await resolveShape(GUIDED_SHAPES[0]!, async () => [
      stub({ instanceType: "e1.guess", onDemandPrice: 2, estimatedPrice: true }),
    ]))!;
    // An estimate presented as a price is the same defect as a fabricated one,
    // just smaller — so the flag has to survive to the UI.
    expect(rec.priceIsEstimate).toBe(true);
  });
});

// The capacity-watch list is a separate list for a reason, so it gets separate
// assertions. Its failure mode is the opposite of GUIDED_SHAPES's: there, a card that
// resolves to something expensive is the defect; here, a card that resolves to
// something *cheap and abundant* is, because it would offer a watch that succeeds on
// its first check and teach the user this page does nothing.
describe("WATCH_SHAPES", () => {
  it("has unique ids that don't collide with the launch shapes", () => {
    const ids = WATCH_SHAPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Both lists feed `resolveShape` and both ids end up in URLs (`?shape=`), so a
    // collision would make one list's card silently open the other's flow.
    for (const id of ids) expect(GUIDED_SHAPES.map((s) => s.id)).not.toContain(id);
  });

  it("labels shapes in user vocabulary, not hardware vocabulary", () => {
    for (const s of WATCH_SHAPES) {
      expect(s.label, s.id).not.toMatch(/\b[a-z]\d[a-z]*\.\w+\b/);
      expect(s.blurb.length, s.id).toBeGreaterThan(0);
    }
  });

  it("resolves every shape to a real accelerator, not a cheap CPU box", async () => {
    // The failure this catches for real: `trn2` looks like the obvious query for
    // Trainium 2, but truffle-ts doesn't parse it as a family and returns 231 results
    // spanning the whole catalog — so price-ranking resolves the card to a
    // `t4g.nano` at $0.0042/hr. A card offering to watch for a t4g.nano is a card
    // that never has anything to say, and the label would still read "An AWS
    // training chip".
    const recs = await resolveAllShapes(undefined, WATCH_SHAPES);
    expect(recs).toHaveLength(WATCH_SHAPES.length);
    recs.forEach((rec, i) => {
      const shape = WATCH_SHAPES[i]!;
      expect(rec, `${shape.id} resolved to nothing — "${shape.query}" matched no instance`).toBeDefined();
      const inst = rec!.pick.instance;
      // Every one of these is an accelerator family, so nothing here should be
      // priced like a general-purpose box. $1/hr is well below the cheapest real
      // candidate (inf1.xlarge at $0.228 is the floor of what these families cost)
      // and well above every t-class/m-class type a mis-parsed query would return.
      expect(inst.onDemandPrice ?? Infinity, `${shape.id} → ${inst.instanceType}`).toBeGreaterThan(0.2);
      expect(inst.instanceType, shape.id).toMatch(/^[a-z0-9-]+\.[a-z0-9]+$/);
    });
  });

  it("watches a whole family, as a glob lagotto can compile", async () => {
    // A family and not the one cheapest type: the user is waiting for capacity, and
    // `p5.48xlarge` being full while `p5.4xlarge` is free is a match they want. The
    // pattern also has to survive lagotto's OWN glob→regex conversion, since that is
    // what actually runs — asserting the string alone would not establish that.
    const recs = await resolveAllShapes(undefined, WATCH_SHAPES);
    for (const rec of recs) {
      const pattern = watchPattern(rec!);
      const type = rec!.pick.instance.instanceType;
      expect(pattern, rec!.shape.id).toBe(`${rec!.pick.instance.instanceFamily}.*`);
      const re = compilePattern(pattern);
      expect(re.test(type), `${pattern} must match its own pick ${type}`).toBe(true);
      // And must not match the rest of the catalog. `p5.*` matching `p5e.48xlarge`
      // would widen the watch past the family the card named.
      expect(re.test("t4g.nano"), pattern).toBe(false);
    }
  });

  it("falls back to the exact type rather than a bare wildcard with no family", () => {
    // `.*` here would silently watch every instance type in the region — a watch
    // that matches instantly and reports something the user never asked about.
    const rec = {
      shape: WATCH_SHAPES[0]!,
      pick: stub({ instanceType: "z9.custom", instanceFamily: "" }),
      priceIsEstimate: false,
      totalMatches: 1,
    };
    expect(watchPattern(rec)).toBe("z9.custom");
  });
});

const usable = (r: FindResult) =>
  typeof r.instance.onDemandPrice === "number" && r.instance.onDemandPrice > 0;

/** A minimal FindResult for the stubbed-finder cases. */
function stub(over: Partial<FindResult["instance"]>): FindResult {
  return {
    instance: {
      instanceType: "t0.test",
      instanceFamily: "t0",
      vcpus: 2,
      memoryMib: 4096,
      architecture: "x86_64",
      ...over,
    },
    reasons: [],
  } as FindResult;
}
