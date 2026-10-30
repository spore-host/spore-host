// The cost limit guided mode launches with, kept apart because it is easy to state
// wrongly and not obvious from the call site. (The region a price is for used to live
// here too, as a hand-kept "us-east-1"; truffle-ts 0.6 prices by region, so the price
// itself now says which region it is for. See ../pricing.ts.)
//
// Pure — no DOM, no truffle-ts, no spawn-ts. So the arithmetic that decides how
// much of the user's money is at risk is testable on its own.

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
