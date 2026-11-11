// @vitest-environment node
//
// The standalone sweep for one e2e run (harness.ts `sweep`): terminate the
// run's instances by its tag, wait, and leak-check. CI runs it after the
// harness with `if: always()`; `make portal-e2e-aws` runs it after the harness
// too. Runs ONLY with PORTAL_E2E_SWEEP=1 and PORTAL_E2E_RUN_ID set; it uses the
// observer's credentials only (never the e2e role) and touches nothing that
// does not carry spore-host:e2e-run=<that id>.
import { describe, expect, it } from "vitest";
import { problems, sweep } from "./harness.js";
import { validateRunId } from "./run.js";

const on = process.env.PORTAL_E2E_SWEEP === "1";

describe.skipIf(!on)("portal real-AWS e2e sweep (credential-gated)", () => {
  it(
    "leaves no instance, volume, interface, address, group, key pair or session of the run",
    async () => {
      const runId = validateRunId(process.env.PORTAL_E2E_RUN_ID ?? "");
      const { observerApi, observerCredentials } = await import("./aws.js");
      const report = await sweep({
        runId,
        observer: observerApi(await observerCredentials()),
        clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
        log: (line) => console.log(`portal e2e sweep: ${line}`),
      });
      console.log(`portal e2e sweep ${runId}: terminated ${report.teardown.terminated.join(", ") || "nothing (already clean)"}`);
      expect(problems(report)).toEqual([]);
    },
    15 * 60_000,
  );
});

describe.runIf(!on)("portal real-AWS e2e sweep", () => {
  it("is skipped: PORTAL_E2E_SWEEP is not 1, so no AWS call is made", () => {
    expect(on).toBe(false);
  });
});
