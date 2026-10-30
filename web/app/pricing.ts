// The one place the portal turns an instance type into a price it is allowed to show.
//
// Every price on the portal is static: the federated role has no `pricing:*`, so the
// live Price List is never consulted. The owner's rule for a static price is that it
// says it is static, why, and when it was collected (truffle#184), and truffle-ts 0.6
// carries exactly that as a `PriceOrigin` and renders it with `describePriceOrigin`.
// Funnelling every surface through here keeps the number and its label together: a
// caller cannot get one without the other.
//
// Prices are for the session's region. truffle-ts 0.6 keys its static table by
// region, and a type it has no price for in that region comes back unknown rather
// than borrowing us-east-1's rate (the 0.5 behaviour, which quoted a us-east-1 figure
// next to whichever region the user was in).

import {
  CATALOG_AS_OF,
  CATALOG_REGION,
  OFFLINE_REASON,
  staticOnDemandPrice,
  type InstanceType,
  type PriceQuote,
} from "@spore-host/truffle-ts";

/** The fields of a truffle-ts row that bear on its price. */
export type PricedRow = Pick<InstanceType, "instanceType" | "onDemandPrice" | "priceOrigin" | "region">;

/**
 * The on-demand price for `row` in `region`, with its origin.
 *
 * A row's own price is used when it describes this region: a live-finder row carries
 * `region`, and a bundled-catalog row carries none and is priced for
 * `CATALOG_REGION`. Otherwise the region-keyed static table answers. `price` is
 * undefined when nothing is known, and never zero: a zero sorts first and reads as
 * free, so it is treated as missing data.
 */
export function priceFor(row: PricedRow, region: string): PriceQuote {
  const own = row.onDemandPrice;
  if ((row.region ?? CATALOG_REGION) === region && typeof own === "number" && own > 0) {
    return {
      instanceType: row.instanceType,
      region,
      price: own,
      // Only a bundled-catalog row can lack an origin, so that is what it is.
      origin: row.priceOrigin ?? {
        source: "static",
        table: "bundled-catalog",
        collectedOn: CATALOG_AS_OF,
        reason: OFFLINE_REASON,
      },
    };
  }
  const q = staticOnDemandPrice(row.instanceType, region);
  if (typeof q.price === "number" && q.price > 0) return q;
  return {
    instanceType: row.instanceType,
    region,
    origin:
      q.origin.source === "unknown"
        ? q.origin
        : { source: "unknown", reason: `no price for ${row.instanceType} in ${region}` },
  };
}

