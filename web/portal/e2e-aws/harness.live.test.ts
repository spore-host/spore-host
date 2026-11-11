// @vitest-environment node
//
// The REAL-AWS e2e harness (spore-host#683). It launches two t4g.nano
// On-Demand instances in the dev account as the portal would, proves each
// tag-gated grant with one real call in both directions, tears down, and
// checks independently that nothing is left. Design: e2e-aws/harness.ts.
//
// Runs ONLY with PORTAL_E2E_AWS=1, which .github/workflows/portal-e2e-aws.yml
// sets after assuming the teardown role, and `make portal-e2e-aws` sets
// locally. Without it this file makes no AWS call and says so loudly. With it,
// missing credentials, a refused guard, a wrong proof, a teardown that did not
// finish or any leak FAILS the run.
//
// Inputs (all optional):
//   PORTAL_E2E_RUN_ID    the run id (default: generated; printed so a sweep can use it)
//   PORTAL_E2E_ROLE_ARN  the e2e role (default: arn:aws:iam::<account>:role/spore-portal-e2e)
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fixture, PolicyFile } from "../iam/simulate.js";
import { E2E_ROLE_NAME, EXPECTED_ACCOUNT } from "./config.js";
import { problems, runHarness, type HarnessReport } from "./harness.js";
import { newRunId, validateRunId } from "./run.js";

const live = process.env.PORTAL_E2E_AWS === "1";
const here = import.meta.dirname;
const policy = JSON.parse(readFileSync(resolve(here, "../iam/policies/portal-launch-role.json"), "utf8")) as PolicyFile;
const fixture = JSON.parse(readFileSync(resolve(here, "../iam/fixtures/portal-launch-role.json"), "utf8")) as Fixture;

function print(r: HarnessReport): string {
  const lines = [`e2e run ${r.runId}`, `launched: ${r.launched.map((l) => `${l.role}=${l.id}`).join(", ") || "(none)"}`, "proofs:"];
  for (const p of r.proofs) lines.push(`  ${p.ok ? "PASS" : "FAIL"}  ${p.action} on ${p.target}${p.instanceId ? ` ${p.instanceId}` : ""}: ${p.outcome.decision} (${p.outcome.evidence}); expected ${p.expect}. ${p.name}`);
  lines.push(`teardown: terminated ${r.teardown.terminated.join(", ") || "(nothing)"}; remaining ${r.teardown.remaining.join(", ") || "(none)"}`);
  lines.push(`leaks: ${r.leaks.leaks.length ? "" : "none"}`);
  for (const l of r.leaks.leaks) lines.push(`  LEAK ${l.kind} ${l.id}: ${l.why}`);
  for (const n of r.leaks.notices) lines.push(`  notice: ${n}`);
  for (const e of r.errors) lines.push(`error: ${e}`);
  return lines.join("\n");
}

describe.skipIf(!live)("portal real-AWS e2e (credential-gated)", () => {
  it(
    "launches as the portal, proves every tag-gated grant both ways, tears down, and leaves nothing",
    async () => {
      // Imported here so the default test run never loads the AWS adapters.
      const { assumeE2ERole, e2eApi, observerApi, observerCredentials } = await import("./aws.js");
      const runId = validateRunId(process.env.PORTAL_E2E_RUN_ID || newRunId(Date.now(), randomBytes(3).toString("hex")));
      console.log(`portal e2e: run id ${runId} (sweep with PORTAL_E2E_RUN_ID=${runId} make portal-e2e-aws-sweep)`);
      const observerCreds = await observerCredentials();
      const roleArn = process.env.PORTAL_E2E_ROLE_ARN || `arn:aws:iam::${EXPECTED_ACCOUNT}:role/${E2E_ROLE_NAME}`;
      const report = await runHarness({
        runId,
        observer: observerApi(observerCreds),
        e2e: async () => e2eApi(await assumeE2ERole(observerCreds, roleArn, runId), runId),
        clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
        log: (line) => console.log(`portal e2e: ${line}`),
        policy,
        fixture,
      });
      console.log(print(report));
      expect(problems(report), print(report)).toEqual([]);
      expect(report.launched).toHaveLength(2);
      expect(report.proofs.length).toBeGreaterThan(2);
    },
    30 * 60_000,
  );
});

describe.runIf(!live)("portal real-AWS e2e", () => {
  it("is SKIPPED: PORTAL_E2E_AWS is not 1, so no AWS call is made and nothing was proven against real AWS", () => {
    console.warn(
      "\n*** portal real-AWS e2e SKIPPED: PORTAL_E2E_AWS is not 1. The tag-gated grants were NOT proven against AWS and no leak check ran. Run `make portal-e2e-aws` (README: Portal real-AWS e2e). ***\n",
    );
    expect(live).toBe(false);
  });
});
