// The real-AWS e2e run, as a function of two injected APIs, so the whole flow
// (guard, launch, proofs, teardown that always runs, leak check) is unit-tested
// offline with fakes (harness.test.ts). aws.ts supplies the real ones.
//
// Two credentials, never mixed:
// - e2e: the spore-portal-e2e role, whose inline policies ARE the portal
//   role's (iam/live.test.ts fails nightly when they differ). Every proof uses
//   it, and nothing else does.
// - observer: the operator's own credentials locally, or the
//   spore-portal-e2e-teardown role in CI. The guard, the setup launch of the
//   run's two test instances (the 1.0 portal role is read-only, #645, so it
//   can't launch them), the snapshots, the waits, teardown and the leak check
//   use it, so none of them depends on what the portal role can see or do.
import type { Fixture, PolicyFile } from "../iam/simulate.js";
import { E2E_ROLE_NAME, EXPECTED_ACCOUNT, LIVE_STATES, WAIT } from "./config.js";
import { EXECUTORS, plan, planProblems, type CallTarget, type PlannedCall } from "./grants.js";
import { detectLeaks, formatLeaks, teardownTargets, type LeakReport, type RunContext, type Snapshot } from "./leaks.js";
import { classifyDryRun, classifyList, classifyStartSession, errorCode, type Outcome } from "./outcomes.js";
import { preflightRefusal, sessionName, type GuardInstance, type InstanceRole } from "./run.js";

export type DryRunAction = "ec2:StopInstances" | "ec2:StartInstances" | "ec2:TerminateInstances" | "ec2:CreateTags";
export type CallResult = { ok: true } | { ok: false; err: unknown };
export type SessionResult = { ok: true; sessionId?: string } | { ok: false; err: unknown };

export interface Identity {
  account: string;
  arn: string;
}

export type ListResult = { ok: true; found: boolean } | { ok: false; err: unknown };

/** What the harness does as the portal (the e2e role). */
export interface E2EApi {
  identity(): Promise<Identity>;
  /** EC2Provider.get, the portal's read path: whether the portal can see instance `id`. */
  list(id: string): Promise<ListResult>;
  dryRun(action: DryRunAction, id: string): Promise<CallResult>;
  /** RunInstances with DryRun: one t4g.nano from `imageId`, tagged as spawn-ts tags a launch. */
  dryRunLaunch(imageId: string): Promise<CallResult>;
  startSession(id: string): Promise<SessionResult>;
  terminateSession(sessionId: string): Promise<void>;
}

/** What the harness does as the observer. */
export interface ObserverApi {
  identity(): Promise<Identity>;
  /**
   * The setup launch: SpawnClient.launch over EC2Provider, with spored's
   * instance profile and the run's tags (run.ts transformRunInstances), as
   * spawn launches. Returns the instance id.
   */
  launch(role: InstanceRole): Promise<string>;
  /** Every instance carrying the run tag (any run), in any state but terminated. */
  e2eInstances(): Promise<GuardInstance[]>;
  /** This run's instances by its tag, in every state. */
  runInstances(runId: string): Promise<GuardInstance[]>;
  snapshot(): Promise<Snapshot>;
  /** Of `ids`, those whose SSM agent reports Online. */
  ssmOnline(ids: string[]): Promise<string[]>;
  terminate(ids: string[]): Promise<void>;
  terminateSession(sessionId: string): Promise<void>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface HarnessDeps {
  runId: string;
  observer: ObserverApi;
  /** Assumes the e2e role. Called only after the guard passes. */
  e2e: () => Promise<E2EApi>;
  clock: Clock;
  log: (line: string) => void;
  policy: PolicyFile;
  fixture: Fixture;
}

export interface ProofResult {
  name: string;
  action: string;
  target: CallTarget;
  instanceId?: string;
  expect: "allowed" | "denied";
  outcome: Outcome;
  ok: boolean;
  how: string;
}

export interface HarnessReport {
  runId: string;
  launched: { role: InstanceRole; id: string }[];
  proofs: ProofResult[];
  teardown: { terminated: string[]; remaining: string[] };
  leaks: LeakReport;
  /** Anything that went wrong outside a proof's decision: refusals, errors, timeouts. */
  errors: string[];
}

/** Every reason the run fails. Empty means it passed. */
export function problems(r: HarnessReport): string[] {
  return [
    ...r.errors,
    ...r.proofs.filter((p) => !p.ok).map((p) => `proof "${p.name}": ${p.action} ${p.target === "account" ? "in the account" : `on the ${p.target} instance`}${p.instanceId ? ` ${p.instanceId}` : ""} was ${p.outcome.decision} (${p.outcome.evidence}), expected ${p.expect}`),
    ...(r.teardown.remaining.length ? [`teardown: ${r.teardown.remaining.join(", ")} did not reach terminated`] : []),
    ...(r.leaks.leaks.length ? [formatLeaks(r.leaks)] : []),
  ];
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function until<T>(clock: Clock, timeoutMs: number, probe: () => Promise<T | null>): Promise<T | null> {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    if (clock.now() >= deadline) return null;
    await clock.sleep(WAIT.poll);
  }
}

export async function runHarness(d: HarnessDeps): Promise<HarnessReport> {
  const { clock, log, observer, runId } = d;
  const report: HarnessReport = { runId, launched: [], proofs: [], teardown: { terminated: [], remaining: [] }, leaks: { leaks: [], notices: [] }, errors: [] };

  // ── Refuse before anything is created ───────────────────────────────────
  const gate = planProblems(d.policy, d.fixture);
  if (gate.length) {
    report.errors.push(...gate.map((g) => `plan: ${g}`));
    return report;
  }
  const who = await observer.identity();
  if (who.account !== EXPECTED_ACCOUNT) {
    report.errors.push(`refusing to start: the observer credentials are for account ${who.account}, the harness runs only in ${EXPECTED_ACCOUNT}`);
    return report;
  }
  const refusal = preflightRefusal(await observer.e2eInstances());
  if (refusal) {
    report.errors.push(refusal);
    return report;
  }

  const before = await observer.snapshot();
  const windowStartMs = clock.now();
  const sessionIds: string[] = [];
  log(`run ${runId}: observer ${who.arn}; launching 2 test instances as the observer`);

  try {
    const e2e = await d.e2e();
    const me = await e2e.identity();
    const expectedArn = `arn:aws:sts::${EXPECTED_ACCOUNT}:assumed-role/${E2E_ROLE_NAME}/${sessionName(runId)}`;
    if (me.arn !== expectedArn) throw new Error(`refusing to prove anything: the e2e credentials are ${me.arn}, not ${expectedArn}`);

    // ── Setup: the run's two instances, launched as the observer ──────────
    // The read-only portal role can't launch (#645), so the observer does,
    // through spawn-ts as spawn launches. That the portal role is DENIED a
    // launch is one of the proofs below (a DryRun RunInstances).
    for (const role of ["managed", "control"] as const) {
      try {
        report.launched.push({ role, id: await observer.launch(role) });
      } catch (e) {
        throw new Error(`setup launch of the ${role} instance failed: ${msg(e)}`);
      }
    }
    const idOf = (role: InstanceRole) => report.launched.find((l) => l.role === role)!.id;

    // ── Wait until both run, as the observer sees them ─────────────────────
    const ids = report.launched.map((l) => l.id);
    const running = await until(clock, WAIT.running, async () => {
      const mine = (await observer.runInstances(runId)).filter((i) => ids.includes(i.id));
      return ids.every((id) => mine.find((i) => i.id === id)?.state === "running") ? mine : null;
    });
    if (!running) throw new Error(`${ids.join(", ")} did not reach running within ${WAIT.running / 60_000} min`);
    const imageId = running.find((i) => i.id === idOf("managed"))?.imageId;

    const calls = plan(d.fixture);
    // A session can only be ALLOWED once the agent is online. A denial needs
    // no agent: IAM refuses first. While the portal is read-only no session is
    // expected allowed, so the run doesn't wait for SSM.
    if (calls.some((c) => c.action === "ssm:StartSession" && c.expect === "allowed")) {
      const online = await until(clock, WAIT.ssmOnline, async () => {
        const up = await observer.ssmOnline(ids);
        return ids.every((i) => up.includes(i)) ? up : null;
      });
      if (!online) throw new Error(`the SSM agent on ${ids.join(", ")} did not come online within ${WAIT.ssmOnline / 60_000} min, so StartSession cannot be proven (does spored-instance-role carry AmazonSSMManagedInstanceCore, and does the subnet reach SSM?)`);
    }

    // ── One real call per planned case ─────────────────────────────────────
    for (const c of calls) {
      // An account-scoped call names no instance; the list proof looks for the managed one.
      const instanceId = c.target === "account" ? (c.action === "ec2:DescribeInstances" ? idOf("managed") : undefined) : idOf(c.target);
      report.proofs.push(await prove(c, { instanceId, imageId }, e2e, d, sessionIds));
    }
  } catch (e) {
    report.errors.push(msg(e));
  } finally {
    await teardown(d, report, sessionIds);
    const ctx: RunContext = { runId, windowStartMs, windowEndMs: clock.now(), launchedIds: report.launched.map((l) => l.id), sessionIds };
    report.leaks = await leakCheck(d, before, ctx);
  }
  return report;
}

async function prove(c: PlannedCall, at: { instanceId?: string; imageId?: string }, e2e: E2EApi, d: HarnessDeps, sessionIds: string[]): Promise<ProofResult> {
  const { instanceId, imageId } = at;
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`proof "${c.name}" needs ${what}, which the setup launch did not provide`);
    return v;
  };
  let outcome: Outcome;
  if (c.action === "ssm:StartSession") {
    const id = need(instanceId, "an instance");
    outcome = await (async () => {
      const deadline = d.clock.now() + WAIT.ssmOnline;
      for (;;) {
        const r = await e2e.startSession(id);
        if (r.ok && r.sessionId) {
          sessionIds.push(r.sessionId);
          await closeSession(r.sessionId, e2e, d);
        }
        const o = classifyStartSession(r);
        if (!o.retry || d.clock.now() >= deadline) return { decision: o.decision, evidence: o.evidence };
        await d.clock.sleep(WAIT.poll);
      }
    })();
  } else if (c.action === "ec2:DescribeInstances") {
    const id = need(instanceId, "an instance");
    // EC2 is eventually consistent: a new instance can be missing from a
    // describe for a while after another principal sees it running.
    let last: Outcome = { decision: "inconclusive", evidence: "not listed yet" };
    const found = await until(d.clock, WAIT.running, async () => {
      last = classifyList(await e2e.list(id));
      return last.evidence === "the list succeeded without the run's instance" ? null : last;
    });
    outcome = found ?? last;
  } else if (c.action === "ec2:RunInstances") {
    outcome = classifyDryRun(await e2e.dryRunLaunch(need(imageId, "the setup launch's image id")));
  } else {
    outcome = classifyDryRun(await e2e.dryRun(c.action as DryRunAction, need(instanceId, "an instance")));
  }
  const ok = outcome.decision === c.expect;
  const where = c.target === "account" ? "in the account" : `on ${c.target} ${instanceId}`;
  d.log(`${ok ? "PASS" : "FAIL"} ${c.action} ${where}: ${outcome.decision} (${outcome.evidence}), expected ${c.expect} — "${c.name}"`);
  return { name: c.name, action: c.action, target: c.target, instanceId, expect: c.expect, outcome, ok, how: EXECUTORS[c.action].how };
}

/** Close a session at once: as the e2e role (the portal's TerminateSession grant), else as the observer. */
async function closeSession(id: string, e2e: E2EApi, d: HarnessDeps): Promise<void> {
  try {
    await e2e.terminateSession(id);
  } catch (e) {
    d.log(`TerminateSession ${id} as the e2e role failed (${errorCode(e)}); closing it as the observer`);
    try {
      await d.observer.terminateSession(id);
    } catch (e2) {
      d.log(`TerminateSession ${id} as the observer failed too (${errorCode(e2)}); the leak check will report it if it is still open`);
    }
  }
}

/** Always runs. Idempotent: it terminates whatever of this run's is not already on its way out, then waits. */
async function teardown(d: HarnessDeps, report: HarnessReport, sessionIds: string[]): Promise<void> {
  const { observer, clock, runId } = d;
  try {
    const targets = teardownTargets(await observer.runInstances(runId), runId);
    if (targets.length) {
      d.log(`teardown: terminating ${targets.join(", ")}`);
      await observer.terminate(targets);
    }
    report.teardown.terminated = targets;
    const live = new Set<string>([...LIVE_STATES, "shutting-down"]);
    const done = await until(clock, WAIT.terminated, async () => {
      const left = (await observer.runInstances(runId)).filter((i) => live.has(i.state));
      report.teardown.remaining = left.map((i) => `${i.id} (${i.state})`);
      return left.length === 0 ? true : null;
    });
    if (done) report.teardown.remaining = [];
  } catch (e) {
    report.errors.push(`teardown: ${msg(e)}`);
  }
  for (const id of sessionIds) {
    try {
      await observer.terminateSession(id);
    } catch {
      // Already closed, which is the expected case. The leak check decides.
    }
  }
}

/** Snapshot until clean or out of patience: deletion of volumes and interfaces lags termination. */
async function leakCheck(d: HarnessDeps, before: Snapshot, ctx: RunContext): Promise<LeakReport> {
  try {
    let last: LeakReport = { leaks: [], notices: [] };
    const clean = await until(d.clock, WAIT.leakSettle, async () => {
      last = detectLeaks(before, await d.observer.snapshot(), { ...ctx, windowEndMs: d.clock.now() });
      return last.leaks.length === 0 ? last : null;
    });
    return clean ?? last;
  } catch (e) {
    return { leaks: [{ kind: "instance", id: "(unknown)", why: `the leak check itself failed, so nothing is known to be clean: ${msg(e)}` }], notices: [] };
  }
}

/**
 * The standalone sweep: CI runs it after the harness with `if: always()`, so a
 * run killed mid-flight (job timeout, cancelled, OOM) is still torn down. It
 * terminates this run's instances by tag, waits, and checks for leaks by tag
 * and attachment only: with no "before" snapshot it has no time window, so it
 * reports nothing it cannot attribute to the run. Idempotent: on a clean run
 * it finds nothing and passes.
 */
export async function sweep(d: Pick<HarnessDeps, "observer" | "clock" | "log" | "runId">): Promise<HarnessReport> {
  const report: HarnessReport = { runId: d.runId, launched: [], proofs: [], teardown: { terminated: [], remaining: [] }, leaks: { leaks: [], notices: [] }, errors: [] };
  const who = await d.observer.identity();
  if (who.account !== EXPECTED_ACCOUNT) {
    report.errors.push(`refusing to sweep: the observer credentials are for account ${who.account}, not ${EXPECTED_ACCOUNT}`);
    return report;
  }
  const known = (await d.observer.runInstances(d.runId)).map((i) => i.id);
  const deps = d as HarnessDeps;
  await teardown(deps, report, []);
  const snap = await d.observer.snapshot();
  report.leaks = await leakCheck(deps, snap, { runId: d.runId, windowStartMs: d.clock.now(), windowEndMs: d.clock.now(), launchedIds: known, sessionIds: [] });
  return report;
}
