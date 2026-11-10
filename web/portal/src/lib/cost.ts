// The cost facts the GUI states before a launch, in one pure module so the
// arithmetic that decides how much of the user's money is at risk is tested
// on its own.
//
// Ported from legacy-app/guided/cost.ts (brief §9 reuse table: "the ceiling
// and cost-cap math, size x time x 1.25"). Behaviour is unchanged;
// `maxCostFor()` (the "at most $X" figure, brief §6 rule 6) is new.

/**
 * The region the bundled truffle-ts catalogue's on-demand prices are quoted
 * in. truffle-ts does not export it; gen-catalog.mjs defaults to us-east-1.
 * Replace this constant if truffle-ts ever exports its snapshot's region.
 */
export const CATALOG_PRICE_REGION = "us-east-1";

/**
 * Slack the spending limit gets over the time-limit total. A limit at exactly
 * rate x time races the time limit and can terminate a healthy instance first;
 * 25% clears that and still bounds a runaway to about what the user agreed to.
 */
export const COST_LIMIT_HEADROOM = 1.25;

/**
 * The default spending limit (`spawn launch --cost-limit`) for a rate and a
 * time limit, or undefined when either is unknown or not positive.
 *
 * Undefined rather than 0: spawn treats a non-positive limit as "no limit",
 * so 0 would look like a limit at the call site and be read as unlimited.
 * Rounded UP to whole dollars, never below $1: rounding down could put the
 * limit under the expected spend and end a healthy run.
 */
export function costLimitFor(pricePerHour: number | undefined, ttlHours: number): number | undefined {
  if (pricePerHour == null || !(pricePerHour > 0) || !(ttlHours > 0)) return undefined;
  return Math.max(1, Math.ceil(pricePerHour * ttlHours * COST_LIMIT_HEADROOM));
}

/**
 * The most a launch can cost when it runs to its time limit: the "at most $X"
 * the review leads with. Undefined when the rate or time is unknown, so the
 * caller can refuse to show a made-up maximum. When a spending limit is set
 * and lower, it is the bound, since the instance is terminated on reaching it.
 */
export function maxCostFor(pricePerHour: number | undefined, ttlHours: number, costLimit?: number): number | undefined {
  if (pricePerHour == null || !(pricePerHour > 0) || !(ttlHours > 0)) return undefined;
  const byTime = pricePerHour * ttlHours;
  return costLimit != null && costLimit > 0 ? Math.min(byTime, costLimit) : byTime;
}
