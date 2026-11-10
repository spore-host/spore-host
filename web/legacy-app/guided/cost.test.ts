// The guided cost-limit arithmetic. Pure, so this is where the money-safety
// properties get pinned down without a DOM or a client.
import { describe, expect, it } from "vitest";
import { COST_LIMIT_HEADROOM, costLimitFor } from "./cost.js";

describe("costLimitFor", () => {
  it("sits above the TTL-implied total, not on it", () => {
    // The limit must not be the thing that kills a healthy instance. Accumulated
    // cost is computed from wall-clock runtime, so a limit at exactly price × ttl
    // would race the TTL and any rounding would let the cost rule win.
    const limit = costLimitFor(0.5, 4)!;
    expect(limit).toBeGreaterThan(0.5 * 4);
    expect(limit).toBe(Math.ceil(0.5 * 4 * COST_LIMIT_HEADROOM));
  });

  it("still bounds a runaway to roughly what the user agreed to", () => {
    // The other half: headroom that made the limit meaningless would be no limit.
    // At H100 prices an unbounded instance is ~$100/hr, so the ceiling matters.
    const limit = costLimitFor(12.29, 2)!;
    expect(limit).toBeLessThan(12.29 * 2 * 2);
  });

  it("rounds up to whole dollars", () => {
    expect(costLimitFor(0.1344, 4)).toBe(1); // 0.672 → floor'd would be $0 = no limit
    expect(Number.isInteger(costLimitFor(2.83, 4)!)).toBe(true);
  });

  it("never returns zero for a real price", () => {
    // A zero costLimit reads as "no limit" in spawn-ts's lifecycle engine, so a
    // cheap instance rounding to 0 would silently lose the guard it looks like it
    // has. t4g.nano for one hour is $0.0042.
    expect(costLimitFor(0.0042, 1)).toBeGreaterThanOrEqual(1);
  });

  it("is undefined when no price is known, not zero", () => {
    // Undefined so the caller omits the field. Passing 0 would look like a limit at
    // the call site and be read as "unlimited" by the engine — the worst pairing.
    expect(costLimitFor(undefined, 4)).toBeUndefined();
  });

  it("is undefined for a non-positive price", () => {
    // Defence in depth against an upstream zero price (truffle-ts#42's failure
    // mode): a 0 here would otherwise produce a $1 limit on an H100 box and
    // terminate it almost immediately, which reads as a broken portal.
    expect(costLimitFor(0, 4)).toBeUndefined();
    expect(costLimitFor(-1, 4)).toBeUndefined();
  });

  it("is undefined for a non-positive TTL", () => {
    expect(costLimitFor(0.5, 0)).toBeUndefined();
  });
});
