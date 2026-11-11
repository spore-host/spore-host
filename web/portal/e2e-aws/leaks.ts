// The independent leak check and the teardown filter. Pure: it reads two
// snapshots of the account (before the run, after teardown) taken with the
// observer's credentials, never the e2e role's, and decides.
//
// A resource is the run's when ANY of these holds, so losing one signal (a tag
// that failed to apply, an id the harness never recorded) does not hide it:
//   - it carries spore-host:e2e-run=<run id>;
//   - for an instance: its ClientToken starts with spore-e2e-<run id>-, or the
//     harness recorded its id from the RunInstances response;
//   - it is attached to, or associated with, one of the run's instances or
//     network interfaces;
//   - for a key pair or security group: its name starts with spore-e2e-<run id>.
// The run's resources still present after teardown are LEAKS and fail the run.
//
// The time window: a resource that appeared after the "before" snapshot and was
// created inside the run window, but carries none of the signals above, is
// - a LEAK when it is orphan-shaped (an unattached volume, an available network
//   interface, an unassociated Elastic IP): that is exactly what a terminated
//   instance leaves behind when something was not set to delete with it;
// - otherwise a NOTICE with its id: the dev account is shared, and an
//   unrelated instance or key pair created by someone else in the same ten
//   minutes must not turn the nightly red.
import { LIVE_STATES, RUN_TAG } from "./config.js";
import { clientTokenPrefix } from "./run.js";

export interface InstanceRec {
  id: string;
  state: string;
  launchTimeMs: number;
  tags: Record<string, string>;
  clientToken?: string;
  instanceType?: string;
  instanceProfileArn?: string;
}
export interface VolumeRec {
  id: string;
  state: string;
  createTimeMs: number;
  tags: Record<string, string>;
  attachedTo: string[];
}
export interface EniRec {
  id: string;
  status: string;
  tags: Record<string, string>;
  attachedTo?: string;
}
export interface AddressRec {
  id: string;
  tags: Record<string, string>;
  instanceId?: string;
  eniId?: string;
}
export interface SecurityGroupRec {
  id: string;
  name: string;
  tags: Record<string, string>;
}
export interface KeyPairRec {
  id: string;
  name: string;
  createTimeMs: number;
  tags: Record<string, string>;
}
export interface SessionRec {
  id: string;
  target: string;
  status: string;
  startMs: number;
  owner?: string;
}

/** The account as the observer sees it. Instances in every state but terminated. */
export interface Snapshot {
  atMs: number;
  instances: InstanceRec[];
  volumes: VolumeRec[];
  enis: EniRec[];
  addresses: AddressRec[];
  securityGroups: SecurityGroupRec[];
  keyPairs: KeyPairRec[];
  /** Active (not terminated) SSM sessions. */
  sessions: SessionRec[];
}

export interface RunContext {
  runId: string;
  windowStartMs: number;
  windowEndMs: number;
  /** Instance ids the RunInstances responses returned. */
  launchedIds: string[];
  /** SessionIds StartSession returned. */
  sessionIds: string[];
}

export type LeakKind = "instance" | "volume" | "network-interface" | "elastic-ip" | "security-group" | "key-pair" | "ssm-session";

export interface Leak {
  kind: LeakKind;
  id: string;
  why: string;
}

export interface LeakReport {
  leaks: Leak[];
  notices: string[];
}

const liveStates = new Set<string>(LIVE_STATES);
const ours = (tags: Record<string, string>, runId: string) => tags[RUN_TAG] === runId;
/** A small slack either side of the window, for clock skew between this host and AWS. */
const SKEW_MS = 2 * 60_000;

export function detectLeaks(before: Snapshot, after: Snapshot, ctx: RunContext): LeakReport {
  const leaks: Leak[] = [];
  const notices: string[] = [];
  const inWindow = (t: number) => t >= ctx.windowStartMs - SKEW_MS && t <= ctx.windowEndMs + SKEW_MS;
  const seen = <T extends { id: string }>(xs: T[]) => new Set(xs.map((x) => x.id));
  const tokenPrefix = clientTokenPrefix(ctx.runId);
  const namePrefix = `spore-e2e-${ctx.runId}`;

  // Instances. "ours" is decided over BOTH snapshots' views, plus the recorded ids.
  const runInstances = new Set(ctx.launchedIds);
  for (const i of [...before.instances, ...after.instances]) {
    if (ours(i.tags, ctx.runId) || i.clientToken?.startsWith(tokenPrefix)) runInstances.add(i.id);
  }
  const beforeInstances = seen(before.instances);
  for (const i of after.instances) {
    if (!liveStates.has(i.state)) continue;
    if (runInstances.has(i.id)) {
      const signals = [ours(i.tags, ctx.runId) && `${RUN_TAG}=${ctx.runId}`, i.clientToken?.startsWith(tokenPrefix) && `ClientToken ${i.clientToken}`, ctx.launchedIds.includes(i.id) && "launched by this run"].filter(Boolean);
      leaks.push({ kind: "instance", id: i.id, why: `${i.state} after teardown (${signals.join(", ")})` });
    } else if (!beforeInstances.has(i.id) && inWindow(i.launchTimeMs)) {
      const other = i.tags[RUN_TAG] ? ` It carries ${RUN_TAG}=${i.tags[RUN_TAG]}, another e2e run.` : "";
      notices.push(`instance ${i.id} (${i.instanceType ?? "?"}, ${i.state}) was launched during the run window but is not this run's.${other}`);
    }
  }

  // Network interfaces: the run's are tagged at launch, or attached to a run instance.
  const runEnis = new Set<string>();
  for (const e of [...before.enis, ...after.enis]) if (ours(e.tags, ctx.runId) || (e.attachedTo && runInstances.has(e.attachedTo))) runEnis.add(e.id);
  const beforeEnis = seen(before.enis);
  for (const e of after.enis) {
    if (runEnis.has(e.id)) leaks.push({ kind: "network-interface", id: e.id, why: `${e.status} after teardown${e.attachedTo ? `, attached to ${e.attachedTo}` : ""}` });
    else if (!beforeEnis.has(e.id) && e.status === "available") leaks.push({ kind: "network-interface", id: e.id, why: "appeared during the run window and is attached to nothing" });
  }

  // Volumes.
  const beforeVolumes = seen(before.volumes);
  for (const v of after.volumes) {
    if (v.state === "deleting" || v.state === "deleted") continue;
    const attached = v.attachedTo.filter((id) => runInstances.has(id));
    if (ours(v.tags, ctx.runId) || attached.length) {
      leaks.push({ kind: "volume", id: v.id, why: `${v.state} after teardown${attached.length ? `, attached to ${attached.join(", ")}` : ""}` });
    } else if (!beforeVolumes.has(v.id) && inWindow(v.createTimeMs)) {
      if (v.attachedTo.length === 0) leaks.push({ kind: "volume", id: v.id, why: `${v.state}, created during the run window and attached to nothing` });
      else notices.push(`volume ${v.id} was created during the run window, attached to ${v.attachedTo.join(", ")}, not this run's`);
    }
  }

  // Elastic IPs. The portal role cannot allocate one; this proves it did not.
  const beforeAddresses = seen(before.addresses);
  for (const a of after.addresses) {
    if (ours(a.tags, ctx.runId) || (a.instanceId && runInstances.has(a.instanceId)) || (a.eniId && runEnis.has(a.eniId))) {
      leaks.push({ kind: "elastic-ip", id: a.id, why: `still allocated after teardown${a.instanceId ? `, associated with ${a.instanceId}` : ""}` });
    } else if (!beforeAddresses.has(a.id) && !a.instanceId && !a.eniId) {
      leaks.push({ kind: "elastic-ip", id: a.id, why: "allocated during the run window and associated with nothing" });
    }
  }

  // Security groups and key pairs. The portal role can create neither; this proves it did not.
  const beforeGroups = seen(before.securityGroups);
  for (const g of after.securityGroups) {
    if (ours(g.tags, ctx.runId) || g.name.startsWith(namePrefix)) leaks.push({ kind: "security-group", id: g.id, why: `"${g.name}" still exists after teardown` });
    else if (!beforeGroups.has(g.id)) notices.push(`security group ${g.id} ("${g.name}") appeared during the run window, not this run's`);
  }
  const beforeKeys = seen(before.keyPairs);
  for (const k of after.keyPairs) {
    if (ours(k.tags, ctx.runId) || k.name.startsWith(namePrefix)) leaks.push({ kind: "key-pair", id: k.id, why: `"${k.name}" still exists after teardown` });
    else if (!beforeKeys.has(k.id) && inWindow(k.createTimeMs)) notices.push(`key pair ${k.id} ("${k.name}") was created during the run window, not this run's`);
  }

  // SSM sessions: any still open on a run instance, or one this run opened.
  const sessionPrefix = `spore-e2e-${ctx.runId}`;
  for (const s of after.sessions) {
    if (runInstances.has(s.target) || ctx.sessionIds.includes(s.id) || s.id.startsWith(sessionPrefix)) {
      leaks.push({ kind: "ssm-session", id: s.id, why: `${s.status} on ${s.target} after teardown` });
    } else if (inWindow(s.startMs) && s.owner?.includes("spore-portal-e2e")) {
      leaks.push({ kind: "ssm-session", id: s.id, why: `${s.status} on ${s.target}, opened by the e2e role during the run window` });
    }
  }

  return { leaks, notices };
}

/**
 * The instances teardown terminates: this run's, by its tag, and only those.
 * Never another run's, never an untagged instance (the teardown role's IAM
 * would refuse one anyway), never one already on its way out.
 */
export function teardownTargets(instances: { id: string; state: string; tags: Record<string, string> }[], runId: string): string[] {
  return instances
    .filter((i) => i.tags[RUN_TAG] === runId && /^i-[0-9a-f]{8,17}$/.test(i.id) && i.state !== "terminated" && i.state !== "shutting-down")
    .map((i) => i.id)
    .sort();
}

export function formatLeaks(r: LeakReport): string {
  return r.leaks.map((l) => `LEAK ${l.kind} ${l.id}: ${l.why}`).join("\n");
}
