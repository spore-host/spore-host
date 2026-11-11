// @vitest-environment node
//
// The whole run, offline, against a fake account. The fake decides every
// e2e-role call by evaluating the CHECKED-IN portal policy with the offline
// evaluator (iam/simulate.ts), so a policy change shows up here as a proof
// that fails, and a broken flow shows up as a leak.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { offlineSimulator, renderPolicies, type Fixture, type PolicyFile } from "../iam/simulate.js";
import { EXPECTED_ACCOUNT, RUN_TAG } from "./config.js";
import { problems, runHarness, sweep, type DryRunAction, type E2EApi, type HarnessDeps, type ObserverApi } from "./harness.js";
import type { Snapshot } from "./leaks.js";
import { LaunchBudget, transformRunInstances, type InstanceRole } from "./run.js";

const here = import.meta.dirname;
const realPolicy = JSON.parse(readFileSync(resolve(here, "../iam/policies/portal-launch-role.json"), "utf8")) as PolicyFile;
const fixture = JSON.parse(readFileSync(resolve(here, "../iam/fixtures/portal-launch-role.json"), "utf8")) as Fixture;
const RUN = "r1abc";

class AwsError extends Error {
  constructor(readonly Code: string) {
    super(Code);
    this.name = Code;
  }
}

interface FakeInstance {
  id: string;
  state: string;
  tags: Record<string, string>;
  launchTimeMs: number;
  clientToken?: string;
}

/** A fake dev account: instances, their volumes and interfaces, SSM sessions, a clock. */
class FakeAccount {
  now = Date.UTC(2026, 10, 10, 12, 0, 0);
  instances: FakeInstance[] = [];
  volumes: Snapshot["volumes"] = [];
  enis: Snapshot["enis"] = [];
  sessions: Snapshot["sessions"] = [];
  calls: string[] = [];
  seq = 0;
  sessionSeq = 0;
  ssmComesOnline = true;
  /** When false, terminate is accepted and does nothing (a teardown that silently fails). */
  terminateWorks = true;
  e2eCanCloseSessions = true;
  observerCanCloseSessions = true;
  e2eArn = `arn:aws:sts::${EXPECTED_ACCOUNT}:assumed-role/spore-portal-e2e/spore-e2e-${RUN}`;
  failLaunchOf: InstanceRole | null = null;
  /** EC2's eventual consistency: the first describe of a new id misses it. */
  describeLags = false;
  private described = new Set<string>();
  e2eCreated = 0;
  /** The policy the fake's IAM evaluates the e2e role's calls against. */
  decisionPolicy: PolicyFile;
  constructor(readonly policy: PolicyFile = realPolicy) {
    this.decisionPolicy = policy;
  }

  clock = { now: () => this.now, sleep: async (ms: number) => this.tick(ms) };

  private tick(ms: number) {
    this.now += ms;
    for (const i of this.instances) {
      if (i.state === "pending") i.state = "running";
      else if (i.state === "shutting-down") {
        i.state = "terminated";
        this.volumes = this.volumes.filter((v) => !v.attachedTo.includes(i.id));
        this.enis = this.enis.filter((e) => e.attachedTo !== i.id);
      }
    }
  }

  private async decide(action: string, inst: FakeInstance, tagKeyPrefix: string): Promise<boolean> {
    const docs = Object.values(renderPolicies(this.decisionPolicy, { account: EXPECTED_ACCOUNT, sporedInstanceRole: "spored-instance-role" })).map((d) => JSON.stringify(d));
    const context = Object.fromEntries(Object.entries(inst.tags).map(([k, v]) => [`${tagKeyPrefix}${k}`, v]));
    const d = await offlineSimulator()({ policies: docs, action, resource: `arn:aws:ec2:us-east-1:${EXPECTED_ACCOUNT}:instance/${inst.id}`, context });
    return d === "allowed";
  }

  private find(id: string): FakeInstance {
    const i = this.instances.find((x) => x.id === id);
    if (!i) throw new AwsError("InvalidInstanceID.NotFound");
    return i;
  }

  e2e(): E2EApi {
    this.e2eCreated += 1;
    const budget = new LaunchBudget();
    return {
      identity: async () => ({ account: EXPECTED_ACCOUNT, arn: this.e2eArn }),
      launch: async (role) => {
        this.calls.push(`launch ${role}`);
        if (this.failLaunchOf === role) throw new AwsError("InsufficientInstanceCapacity");
        // What spawn-ts sends, through the harness's transform, as aws.ts wires it.
        const input = transformRunInstances(
          {
            InstanceType: "t4g.nano",
            MinCount: 1,
            MaxCount: 1,
            TagSpecifications: [{ ResourceType: "instance", Tags: [{ Key: "spawn:managed", Value: "true" }, { Key: "spawn:ttl", Value: "15m" }] }],
          },
          { runId: RUN, role, n: budget.take() },
        );
        const id = `i-0${(++this.seq).toString(16).padStart(16, "0")}`;
        const tags = Object.fromEntries((input.TagSpecifications![0].Tags ?? []).map((t) => [t.Key!, t.Value!]));
        const sub = Object.fromEntries((input.TagSpecifications![1].Tags ?? []).map((t) => [t.Key!, t.Value!]));
        this.instances.push({ id, state: "pending", tags, launchTimeMs: this.now, clientToken: input.ClientToken });
        this.volumes.push({ id: `vol-${id}`, state: "in-use", createTimeMs: this.now, tags: sub, attachedTo: [id] });
        this.enis.push({ id: `eni-${id}`, status: "in-use", tags: sub, attachedTo: id });
        return id;
      },
      state: async (id) => {
        if (this.describeLags && !this.described.has(id)) {
          this.described.add(id);
          throw new AwsError("InvalidInstanceID.NotFound");
        }
        return this.find(id).state;
      },
      dryRun: async (action: DryRunAction, id) => {
        this.calls.push(`dryRun ${action} ${id}`);
        const ok = await this.decide(action, this.find(id), "aws:ResourceTag/");
        return { ok: false, err: new AwsError(ok ? "DryRunOperation" : "UnauthorizedOperation") };
      },
      startSession: async (id) => {
        this.calls.push(`startSession ${id}`);
        const inst = this.find(id);
        if (!(await this.decide("ssm:StartSession", inst, "ssm:resourceTag/"))) return { ok: false, err: new AwsError("AccessDeniedException") };
        if (!this.ssmComesOnline) return { ok: false, err: new AwsError("TargetNotConnected") };
        const sid = `spore-e2e-${RUN}-0${++this.sessionSeq}`;
        this.sessions.push({ id: sid, target: id, status: "Connected", startMs: this.now });
        return { ok: true, sessionId: sid };
      },
      terminateSession: async (sid) => {
        if (!this.e2eCanCloseSessions) throw new AwsError("AccessDeniedException");
        this.sessions = this.sessions.filter((s) => s.id !== sid);
      },
    };
  }

  observer(account = EXPECTED_ACCOUNT): ObserverApi {
    const guard = (i: FakeInstance) => ({ id: i.id, state: i.state, tags: i.tags });
    return {
      identity: async () => ({ account, arn: `arn:aws:sts::${account}:assumed-role/OrganizationAccountAccessRole/op` }),
      e2eInstances: async () => this.instances.filter((i) => RUN_TAG in i.tags && i.state !== "terminated").map(guard),
      runInstances: async (runId) => this.instances.filter((i) => i.tags[RUN_TAG] === runId).map(guard),
      snapshot: async () => ({
        atMs: this.now,
        instances: this.instances.filter((i) => i.state !== "terminated").map((i) => ({ ...i, tags: { ...i.tags } })),
        volumes: structuredClone(this.volumes),
        enis: structuredClone(this.enis),
        addresses: [],
        securityGroups: [{ id: "sg-default", name: "default", tags: {} }],
        keyPairs: [],
        sessions: structuredClone(this.sessions),
      }),
      ssmOnline: async (ids) => (this.ssmComesOnline ? ids.filter((id) => this.find(id).state === "running") : []),
      terminate: async (ids) => {
        this.calls.push(`terminate ${ids.join(",")}`);
        if (!this.terminateWorks) return;
        for (const id of ids) {
          const i = this.find(id);
          if (i.tags[RUN_TAG] === undefined) throw new AwsError("UnauthorizedOperation"); // the teardown role's tag condition
          if (i.state !== "terminated") i.state = "shutting-down";
        }
      },
      terminateSession: async (sid) => {
        if (!this.observerCanCloseSessions) throw new AwsError("AccessDeniedException");
        this.sessions = this.sessions.filter((s) => s.id !== sid);
      },
    };
  }

  deps(over: Partial<HarnessDeps> = {}): HarnessDeps {
    return { runId: RUN, observer: this.observer(), e2e: async () => this.e2e(), clock: this.clock, log: () => {}, policy: this.policy, fixture, ...over };
  }
}

describe("e2e harness flow (offline, fake account)", () => {
  it("passes against the checked-in policy: every proof as expected, both instances terminated, nothing left", async () => {
    const aws = new FakeAccount();
    const r = await runHarness(aws.deps());
    expect(problems(r)).toEqual([]);
    expect(r.launched.map((l) => l.role)).toEqual(["managed", "control"]);
    const proofs = r.proofs.map((p) => `${p.action} ${p.target} ${p.outcome.decision}`);
    expect(proofs).toEqual(
      expect.arrayContaining([
        "ec2:RunInstances+ec2:CreateTags+iam:PassRole launch allowed",
        "ssm:StartSession managed allowed",
        "ssm:StartSession control denied",
        "ec2:StopInstances managed denied",
        "ec2:StartInstances managed denied",
        "ec2:TerminateInstances managed denied",
        "ec2:TerminateInstances control denied",
      ]),
    );
    expect(r.teardown.terminated).toHaveLength(2);
    expect(aws.instances.every((i) => i.state === "terminated")).toBe(true);
    expect(aws.sessions).toEqual([]);
    expect(r.leaks).toEqual({ leaks: [], notices: [] });
  });

  it("fails a proof when the policy changes, and still tears down", async () => {
    const loose = structuredClone(realPolicy);
    delete loose.policies.PortalSSMSession.Statement[0].Condition; // StartSession on ANY instance
    const aws = new FakeAccount(loose);
    const r = await runHarness(aws.deps({ policy: loose, fixture }));
    // The plan gate passes (the fixture still has its cases), so the real calls run and catch it.
    expect(problems(r)).toEqual(['proof "open a command line on any other instance": ssm:StartSession on the control instance i-00000000000000002 was allowed (SessionId spore-e2e-r1abc-02), expected denied']);
    expect(aws.instances.every((i) => i.state === "terminated")).toBe(true);
    expect(aws.sessions).toEqual([]);
  });

  it("fails when Stop, Start or Terminate come back on a spawn-managed instance (#678), and still tears down", async () => {
    const lifecycle = structuredClone(realPolicy);
    lifecycle.policies.PortalEC2Launch.Statement.push({
      Sid: "Lifecycle",
      Effect: "Allow",
      Action: ["ec2:StopInstances", "ec2:StartInstances", "ec2:TerminateInstances"],
      Resource: "*",
      Condition: { StringEquals: { "aws:ResourceTag/spawn:managed": "true" } },
    });
    const aws = new FakeAccount(lifecycle);
    // With the statement back, the PLAN gate fails first: three new tag-gated
    // grants with no realCall allowed case. Nothing is launched.
    const gated = await runHarness(aws.deps({ policy: lifecycle }));
    expect(gated.launched).toEqual([]);
    expect(problems(gated).some((p) => /^plan: PortalEC2Launch\/Lifecycle grants ec2:StopInstances/.test(p))).toBe(true);
    expect(aws.e2eCreated).toBe(0);
    // And if the plan were bypassed, the real calls catch it too.
    const bypassed = new FakeAccount(realPolicy);
    bypassed.decisionPolicy = lifecycle;
    const r = await runHarness(bypassed.deps());
    expect(problems(r).filter((p) => /on the managed instance .* was allowed \(DryRunOperation\), expected denied/.test(p))).toHaveLength(3);
    expect(bypassed.instances.every((i) => i.state === "terminated")).toBe(true);
  });

  it("refuses to start while an earlier run's instance is live, and launches nothing", async () => {
    const aws = new FakeAccount();
    aws.instances.push({ id: "i-0dead00000000beef", state: "running", tags: { [RUN_TAG]: "old-run" }, launchTimeMs: aws.now - 3_600_000 });
    const r = await runHarness(aws.deps());
    expect(problems(r)[0]).toMatch(/refusing to start: 1 instance\(s\) from an earlier e2e run are still live.*i-0dead00000000beef/);
    expect(aws.e2eCreated).toBe(0);
    expect(aws.calls).toEqual([]);
  });

  it("refuses to run in any account but the dev account", async () => {
    const aws = new FakeAccount();
    const r = await runHarness(aws.deps({ observer: aws.observer("999988887777") }));
    expect(problems(r)).toEqual([`refusing to start: the observer credentials are for account 999988887777, the harness runs only in ${EXPECTED_ACCOUNT}`]);
    expect(aws.e2eCreated).toBe(0);
  });

  it("refuses to prove anything with credentials that are not the e2e role's (an admin's would pass every allow)", async () => {
    const aws = new FakeAccount();
    aws.e2eArn = `arn:aws:sts::${EXPECTED_ACCOUNT}:assumed-role/OrganizationAccountAccessRole/op`;
    const r = await runHarness(aws.deps());
    expect(problems(r)[0]).toMatch(/refusing to prove anything: the e2e credentials are .*OrganizationAccountAccessRole/);
    expect(aws.calls).toEqual([]);
  });

  it("tears down the first instance when the second launch fails", async () => {
    const aws = new FakeAccount();
    aws.failLaunchOf = "control";
    const r = await runHarness(aws.deps());
    expect(problems(r)).toEqual([
      "launch of the control instance failed: InsufficientInstanceCapacity: InsufficientInstanceCapacity",
      'proof "launch the control instance through spawn-ts": ec2:RunInstances+ec2:CreateTags+iam:PassRole on the launch instance was inconclusive (InsufficientInstanceCapacity: InsufficientInstanceCapacity), expected allowed',
    ]);
    expect(r.teardown.terminated).toEqual([r.launched[0].id]);
    expect(aws.instances.every((i) => i.state === "terminated")).toBe(true);
    expect(r.leaks.leaks).toEqual([]);
  });

  it("waits out EC2's eventual consistency on a new instance id", async () => {
    const aws = new FakeAccount();
    aws.describeLags = true;
    expect(problems(await runHarness(aws.deps()))).toEqual([]);
  });

  it("fails, and tears down, when the SSM agent never comes online", async () => {
    const aws = new FakeAccount();
    aws.ssmComesOnline = false;
    const r = await runHarness(aws.deps());
    expect(problems(r)[0]).toMatch(/did not come online within 8 min/);
    expect(aws.instances.every((i) => i.state === "terminated")).toBe(true);
  });

  it("reports a teardown that did not take, and the leaked instances, volumes and interfaces by id", async () => {
    const aws = new FakeAccount();
    aws.terminateWorks = false;
    const r = await runHarness(aws.deps());
    const p = problems(r);
    expect(p.some((x) => /^teardown: i-0+1 \(running\), i-0+2 \(running\) did not reach terminated$/.test(x))).toBe(true);
    const leaked = r.leaks.leaks.map((l) => `${l.kind} ${l.id}`);
    expect(leaked).toEqual(
      expect.arrayContaining(["instance i-00000000000000001", "instance i-00000000000000002", "volume vol-i-00000000000000001", "network-interface eni-i-00000000000000002"]),
    );
  });

  it("closes a session as the observer when the e2e role cannot, and fails when nobody can", async () => {
    const a = new FakeAccount();
    a.e2eCanCloseSessions = false;
    expect(problems(await runHarness(a.deps()))).toEqual([]);

    const b = new FakeAccount();
    b.e2eCanCloseSessions = false;
    b.observerCanCloseSessions = false;
    const r = await runHarness(b.deps());
    expect(r.leaks.leaks.map((l) => l.kind)).toEqual(["ssm-session"]);
  });

  it("sweeps a run idempotently: terminates by tag, then finds nothing to do", async () => {
    const aws = new FakeAccount();
    const e2e = aws.e2e();
    await e2e.launch("managed");
    await e2e.launch("control");
    aws.instances.push({ id: "i-0ffff0000000other", state: "running", tags: { [RUN_TAG]: "another-run" }, launchTimeMs: aws.now });
    const first = await sweep({ runId: RUN, observer: aws.observer(), clock: aws.clock, log: () => {} });
    expect(problems(first)).toEqual([]);
    expect(first.teardown.terminated).toHaveLength(2);
    expect(aws.instances.find((i) => i.id === "i-0ffff0000000other")!.state).toBe("running");
    const second = await sweep({ runId: RUN, observer: aws.observer(), clock: aws.clock, log: () => {} });
    expect(problems(second)).toEqual([]);
    expect(second.teardown.terminated).toEqual([]);
  });
});
