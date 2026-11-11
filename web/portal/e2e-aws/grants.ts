// Which grants need one real call, and the plan of real calls. Pure.
//
// The simulator misjudges some tag conditions (ssm:resourceTag/ on
// StartSession, iam:ResourceTag on instance-profile actions), so every
// tag-gated grant in iam/policies/ is proven against real AWS, in both
// directions: allowed on the run's spawn-managed instance, denied on its
// otherwise-identical control instance. The list is ENUMERATED from the policy
// file, and gates/e2e-aws-plan.test.ts runs `planProblems` on every PR: a new
// tag-gated grant with no fixture case to drive it, or no executor that can
// make the call, fails the gate before it can merge unproven.
//
// The plan itself comes from the SimulateCustomPolicy fixtures
// (iam/fixtures/), so the real calls and the simulator cases are the same
// cases: each instance-scoped case whose tag context matches one of the run's
// two instances becomes a real call against that instance.
import type { Fixture, PolicyFile, PolicyStatement, SimCase } from "../iam/simulate.js";
import type { InstanceRole } from "./run.js";

const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** A condition key that reads a resource's or a request's tags. */
const TAG_KEY = /^(?:[a-z0-9-]+:)(?:resourcetag|requesttag)\/(.+)$/i;
const TAG_KEYS_KEY = /^aws:tagkeys$/i;

export interface TagGatedGrant {
  policy: string;
  sid: string;
  action: string;
  operator: string;
  /** The condition key, e.g. ssm:resourceTag/spawn:managed. */
  key: string;
  /** The tag the key reads, e.g. spawn:managed. Empty for aws:TagKeys. */
  tag: string;
  values: string[];
}

/** Every (action, tag condition) pair any Allow statement in the file grants. */
export function tagGatedGrants(file: PolicyFile): TagGatedGrant[] {
  const out: TagGatedGrant[] = [];
  for (const [policy, doc] of Object.entries(file.policies)) {
    doc.Statement.forEach((s: PolicyStatement, i) => {
      if (s.Effect !== "Allow" || !s.Condition) return;
      for (const [operator, kv] of Object.entries(s.Condition)) {
        for (const [key, v] of Object.entries(kv)) {
          const m = TAG_KEY.exec(key);
          if (!m && !TAG_KEYS_KEY.test(key)) continue;
          for (const action of list(s.Action)) out.push({ policy, sid: s.Sid ?? `#${i}`, action, operator, key, tag: m?.[1] ?? "", values: list(v) });
        }
      }
    });
  }
  return out;
}

/** The actions the harness can make a real call for, and how it decides. */
export const EXECUTORS: Readonly<Record<string, { how: string }>> = {
  "ssm:StartSession": { how: "StartSession on the instance; a SessionId is allowed (closed at once with TerminateSession), AccessDeniedException is denied" },
  "ec2:StopInstances": { how: "StopInstances with DryRun: DryRunOperation is allowed, UnauthorizedOperation is denied" },
  "ec2:StartInstances": { how: "StartInstances with DryRun: DryRunOperation is allowed, UnauthorizedOperation is denied" },
  "ec2:TerminateInstances": { how: "TerminateInstances with DryRun: DryRunOperation is allowed, UnauthorizedOperation is denied" },
};

/** The tags each of the run's instances carries that a tag condition can read. */
export const INSTANCE_TAGS: Readonly<Record<InstanceRole, Record<string, string>>> = {
  managed: { "spawn:managed": "true" },
  control: {},
};

export interface PlannedCall {
  name: string;
  action: string;
  target: InstanceRole;
  expect: "allowed" | "denied";
  /** Why it is in the plan. */
  reason: "realCall" | "tag-gated denial" | "untagged control";
}

const INSTANCE_ARN = /^arn:aws:ec2:[^:]*:[^:]*:instance\//;

/** The tags a case's context says the target instance carries, or null if the context sets something else. */
function contextTags(c: SimCase): Record<string, string> | null {
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.context ?? {})) {
    const m = TAG_KEY.exec(k);
    if (m) tags[m[1]] = v;
    else return null; // a non-tag context key (e.g. iam:PassedToService) is not an instance call
  }
  return tags;
}

/** Which of the run's instances a case's context describes exactly, if either. */
export function targetFor(c: SimCase): InstanceRole | null {
  if (!INSTANCE_ARN.test(c.resource)) return null;
  const tags = contextTags(c);
  if (!tags) return null;
  for (const role of ["managed", "control"] as const) {
    const have = INSTANCE_TAGS[role];
    if (Object.entries(tags).every(([k, v]) => have[k] === v) && (role === "managed" ? Object.keys(tags).length > 0 : Object.keys(tags).length === 0)) return role;
  }
  return null;
}

/** The real calls for a run: every executable, instance-scoped fixture case that matches one of its instances. */
export function plan(fixture: Fixture): PlannedCall[] {
  const out: PlannedCall[] = [];
  for (const c of fixture.cases) {
    if (!(c.action in EXECUTORS)) continue;
    const target = targetFor(c);
    if (!target) continue;
    const reason = c.realCall ? "realCall" : target === "managed" ? "tag-gated denial" : "untagged control";
    out.push({ name: c.name, action: c.action, target, expect: c.expect, reason });
  }
  return out;
}

/**
 * Everything that would leave a grant unproven. Empty means each tag-gated
 * grant has a real allowed call and a real denied call in the plan, each
 * realCall case is executable, and each denial on a spawn-managed instance
 * (the ones #678 requires) is made for real.
 */
export function planProblems(file: PolicyFile, fixture: Fixture): string[] {
  const out: string[] = [];
  const calls = plan(fixture);
  for (const g of tagGatedGrants(file)) {
    const at = `${g.policy}/${g.sid} grants ${g.action} on ${g.key}`;
    if (!(g.action in EXECUTORS)) out.push(`${at}, but the e2e harness has no executor for ${g.action}: add one to e2e-aws/grants.ts EXECUTORS and e2e-aws/aws.ts`);
    if (g.operator !== "StringEquals") out.push(`${at} with ${g.operator}; the harness plans StringEquals tag conditions only`);
    if (!g.tag) {
      out.push(`${at}; the harness cannot place a request-tag-keys condition on an instance`);
      continue;
    }
    const managedValue = INSTANCE_TAGS.managed[g.tag];
    if (managedValue === undefined || !g.values.includes(managedValue)) {
      out.push(`${at}=${g.values.join("|")}, but the run's managed instance carries ${g.tag}=${managedValue ?? "(nothing)"}: no real call can satisfy it`);
    }
    if (!calls.some((c) => c.action === g.action && c.target === "managed" && c.expect === "allowed" && c.reason === "realCall")) {
      out.push(`${at}, but no fixture case with realCall:true expects it allowed on a ${g.tag}=${g.values.join("|")} instance`);
    }
    if (!calls.some((c) => c.action === g.action && c.target === "control" && c.expect === "denied")) {
      out.push(`${at}, but no fixture case expects it denied on an instance without ${g.tag}`);
    }
  }
  for (const c of fixture.cases) {
    if (c.realCall && !calls.some((p) => p.name === c.name)) out.push(`case "${c.name}" is realCall:true, but the harness cannot make it (no executor for ${c.action}, or its context matches neither instance)`);
    const t = contextTags(c);
    const onManaged = t !== null && Object.keys(t).length > 0 && Object.entries(t).every(([k, v]) => INSTANCE_TAGS.managed[k] === v);
    if (c.expect === "denied" && onManaged && INSTANCE_ARN.test(c.resource) && !calls.some((p) => p.name === c.name)) {
      out.push(`case "${c.name}" denies ${c.action} on a spawn-managed instance, but the harness has no executor to prove it`);
    }
  }
  return out;
}
