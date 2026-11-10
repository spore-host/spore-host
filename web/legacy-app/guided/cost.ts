// The two cost facts guided mode has to get right, kept in one place because both
// are easy to state wrongly and neither is obvious from the call site.
//
// Pure — no DOM, no truffle-ts, no spawn-ts. So the arithmetic that decides how
// much of the user's money is at risk is testable on its own.

/**
 * The region the bundled catalog's on-demand prices are quoted in.
 *
 * truffle-ts does not export this, so we assert it here: `gen-catalog.mjs` defaults
 * to `--region us-east-1` (line 20) and the Pricing API filter uses that region
 * code, so every `onDemandPrice` in the bundled snapshot is a us-east-1 figure.
 *
 * It matters because the guided confirmation renders the *session's* region beside
 * the cost. Without saying so, a us-east-1 price shown to a user in ap-southeast-2
 * is off by roughly 15-30% with nothing on screen to suggest it. `priceIsEstimate`
 * does not cover this: it flags hand-seeded entries, so a genuinely pulled price
 * shown in the wrong region carries no qualifier at all.
 *
 * If truffle-ts ever exports the region its snapshot was built from, import that
 * instead of this — a constant that has to be kept in sync by hand is the weaker
 * version of this fact.
 */
export const CATALOG_PRICE_REGION = "us-east-1";

/**
 * How much slack the cost limit gets over the TTL-implied total.
 *
 * The limit must sit *above* the expected spend or it becomes the thing that kills
 * a healthy instance early: accumulated cost is computed from wall-clock runtime, so
 * a limit set at exactly `price × ttl` would trip at the same moment the TTL does,
 * and any rounding or a restart would make the cost rule win the race. 25% is
 * enough to stay clear of that while still bounding a runaway to something the user
 * would recognise as "about what I agreed to".
 */
export const COST_LIMIT_HEADROOM = 1.25;

/**
 * The cost limit to launch a guided instance with, or undefined when no price is
 * known.
 *
 * This is guided mode's *second* guard, and it exists because the first one can
 * fail. TTL is enforced by `spored` on the instance, so an instance that never
 * boots the daemon, or whose daemon dies, never self-terminates — which is not
 * hypothetical: the Dashboard ships an orphan banner for exactly that case. TTL
 * alone therefore bounds the *intended* run and nothing else, whereas a cost limit
 * is evaluated from the tags by anything that reads them.
 *
 * Undefined rather than 0 when the price is unknown: spawn-ts treats a non-positive
 * costLimit as "no limit" (`lifecycle.ts` guards `costLimit > 0`), so passing 0
 * would be indistinguishable from omitting it while *looking* like a limit at the
 * call site. Guided mode handles the unknown-price case by refusing to launch
 * silently instead — see the acknowledgement in launch.ts.
 *
 * Rounded UP to whole dollars: a limit of $1.35 invites the question "why that
 * number?", and the rounding direction is the safe one (never below the expected
 * spend, which would abort a healthy run).
 */
export function costLimitFor(pricePerHour: number | undefined, ttlHours: number): number | undefined {
  if (pricePerHour == null || !(pricePerHour > 0) || !(ttlHours > 0)) return undefined;
  return Math.max(1, Math.ceil(pricePerHour * ttlHours * COST_LIMIT_HEADROOM));
}
