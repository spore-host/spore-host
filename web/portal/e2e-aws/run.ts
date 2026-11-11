// Run identity, the tags every resource carries, and the cost guard. Pure: no
// AWS, no clock, no randomness except what is passed in.
import { parseDuration } from "@spore-host/spawn-ts";
import { INSTANCE_TYPE, LIVE_STATES, MAX_INSTANCES, ROLE_TAG, RUN_TAG, SESSION_PREFIX, TTL_MS } from "./config.js";

/** Which of the run's two instances. */
export type InstanceRole = "managed" | "control";

const RUN_ID = /^[a-z0-9][a-z0-9-]{4,39}$/;

/** A run id: lowercase, short enough for a role session name and a ClientToken. */
export function newRunId(nowMs: number, randomHex: string): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase();
  return validateRunId(`local-${stamp}-${randomHex.toLowerCase().slice(0, 6)}`);
}

export function validateRunId(id: string): string {
  if (!RUN_ID.test(id)) throw new Error(`run id "${id}" must match ${RUN_ID} (it becomes a tag value, a role session name and a ClientToken)`);
  return id;
}

/** sts:RoleSessionName for the e2e role. Its trust requires the prefix; SSM session ids start with it. */
export function sessionName(runId: string): string {
  return `${SESSION_PREFIX}${runId}`;
}

/** RunInstances ClientToken: lets the leak check find a launch by something other than its tags. */
export function clientToken(runId: string, n: number): string {
  return `${SESSION_PREFIX}${runId}-${n}`;
}

export function clientTokenPrefix(runId: string): string {
  return `${SESSION_PREFIX}${runId}-`;
}

/** The run's own tags, on the instance, its volumes and its network interfaces. */
export function runTags(runId: string, role: InstanceRole): Record<string, string> {
  return { [RUN_TAG]: runId, [ROLE_TAG]: role };
}

/** The subset of RunInstancesRequest the transform touches. */
export interface RunInstancesInputLike {
  InstanceType?: string;
  MinCount?: number;
  MaxCount?: number;
  InstanceMarketOptions?: unknown;
  ClientToken?: string;
  InstanceInitiatedShutdownBehavior?: string;
  TagSpecifications?: { ResourceType?: string; Tags?: { Key?: string; Value?: string }[] }[];
  [k: string]: unknown;
}

/**
 * What the harness adds to the RunInstances request spawn-ts builds, and what
 * it refuses. Applied by an initialize-step middleware on the EC2Provider's
 * own client, so the call is otherwise exactly the portal's.
 *
 * - Refuses anything but one t4g.nano On-Demand instance with a TTL of at most 15m.
 * - Adds the run tags to the instance, and tags its volumes and network
 *   interfaces at creation (atomic with the launch: if tagging fails, nothing launches).
 * - Sets a run-scoped ClientToken.
 * - Sets InstanceInitiatedShutdownBehavior=terminate, so a shutdown inside the
 *   instance (spored's TTL) ends billing rather than leaving it stopped.
 * - For the control instance, drops spawn:managed and nothing else.
 */
export function transformRunInstances(input: RunInstancesInputLike, o: { runId: string; role: InstanceRole; n: number }): RunInstancesInputLike {
  if (input.InstanceType !== INSTANCE_TYPE) throw new Error(`refusing to launch ${String(input.InstanceType)}: the e2e harness launches ${INSTANCE_TYPE} only`);
  if (input.MinCount !== 1 || input.MaxCount !== 1) throw new Error(`refusing MinCount=${input.MinCount} MaxCount=${input.MaxCount}: one instance per launch`);
  if (input.InstanceMarketOptions !== undefined) throw new Error("refusing a Spot launch: the e2e harness launches On-Demand only");
  const specs = input.TagSpecifications ?? [];
  const inst = specs.find((s) => s.ResourceType === "instance");
  if (!inst) throw new Error("spawn-ts sent no instance TagSpecification; the portal's launch tags are missing");
  const tags = Object.fromEntries((inst.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""]));
  const ttl = tags["spawn:ttl"] === undefined ? null : parseDuration(tags["spawn:ttl"]);
  if (ttl === null || ttl <= 0 || ttl > TTL_MS) throw new Error(`refusing spawn:ttl=${String(tags["spawn:ttl"])}: every e2e instance needs a TTL of at most 15m`);
  if (o.role === "managed" && tags["spawn:managed"] !== "true") throw new Error("spawn-ts did not tag the instance spawn:managed=true");

  const extra = runTags(o.runId, o.role);
  const instanceTags = { ...tags, ...extra };
  if (o.role === "control") delete instanceTags["spawn:managed"];
  const asList = (m: Record<string, string>) => Object.entries(m).map(([Key, Value]) => ({ Key, Value }));
  const others = specs.filter((s) => s.ResourceType !== "instance" && s.ResourceType !== "volume" && s.ResourceType !== "network-interface");
  return {
    ...input,
    ClientToken: clientToken(o.runId, o.n),
    InstanceInitiatedShutdownBehavior: "terminate",
    TagSpecifications: [
      { ResourceType: "instance", Tags: asList(instanceTags) },
      { ResourceType: "volume", Tags: asList(extra) },
      { ResourceType: "network-interface", Tags: asList(extra) },
      ...others,
    ],
  };
}

/** At most MAX_INSTANCES launches per run, counted where the RunInstances request is sent. */
export class LaunchBudget {
  private used = 0;
  constructor(readonly max = MAX_INSTANCES) {}
  take(): number {
    if (this.used >= this.max) throw new Error(`cost guard: this run has already launched ${this.used} instance(s), the cap is ${this.max}`);
    this.used += 1;
    return this.used;
  }
  get count(): number {
    return this.used;
  }
}

export interface GuardInstance {
  id: string;
  state: string;
  tags: Record<string, string>;
}

/**
 * The pre-flight cost guard: refuse to start while any instance from any
 * earlier e2e run is still live. That is a leak, and a new run would only add
 * to it. Returns the reason to refuse, or null to go ahead.
 */
export function preflightRefusal(instances: GuardInstance[]): string | null {
  const live = new Set<string>(LIVE_STATES);
  const leaked = instances.filter((i) => RUN_TAG in i.tags && live.has(i.state));
  if (leaked.length === 0) return null;
  const list = leaked.map((i) => `${i.id} (${i.state}, ${RUN_TAG}=${i.tags[RUN_TAG]})`).join(", ");
  return `refusing to start: ${leaked.length} instance(s) from an earlier e2e run are still live, which is a leak: ${list}. Terminate them (PORTAL_E2E_RUN_ID=<id> make portal-e2e-aws-sweep) and find out why teardown missed them.`;
}
