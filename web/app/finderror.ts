// What to say when truffle-ts's `find()` throws.
//
// From truffle-ts 0.6 a query made only of unknown words (`zzqx`) throws
// `UnrecognizedQueryError` instead of returning every type. Its message is two
// lines: what was wrong, then a "Try a vendor (…), processor (…)" hint. Shown as one
// run of text, the hint reads as part of the error. A contradictory query
// (`intel graviton`) throws a plain parse error in the same two-line shape, so it
// gets the same split. spawn-ts 0.8.1's Dashboard picker renders it this way too.

import { UnrecognizedQueryError } from "@spore-host/truffle-ts";

export interface FindErrorText {
  /** The first line: what was wrong with the query. */
  message: string;
  /** The rest, if any: how to phrase it instead. */
  hint?: string;
  /** "did you mean" pairs, unknown term → closest known one. */
  suggestions: Array<[string, string]>;
  /** True for a query truffle could not read, as opposed to a lookup that failed. */
  unrecognized: boolean;
}

export function describeFindError(err: unknown): FindErrorText {
  const raw = err instanceof Error ? err.message : String(err);
  const [first, ...rest] = raw.split("\n");
  const hint = rest.join(" ").trim();
  const unrecognized = err instanceof UnrecognizedQueryError;
  return {
    message: (first ?? raw).trim(),
    ...(hint ? { hint } : {}),
    suggestions: unrecognized ? Object.entries(err.suggestions) : [],
    unrecognized,
  };
}
