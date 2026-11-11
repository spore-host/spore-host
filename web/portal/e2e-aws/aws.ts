// The real E2EApi and ObserverApi for harness.ts. Only the credential-gated
// suites (harness.live.test.ts, sweep.live.test.ts) import this; no offline
// test does, and nothing here runs at import time.
//
// Credentials:
// - observer: whatever the AWS CLI resolves (AWS_PROFILE=spore-host-dev
//   locally, the teardown role's env credentials in CI), read once with
//   `aws configure export-credentials`. The CLI, not the SDK's chain, because
//   it is what operators already sign in with (`aws login`), and the live IAM
//   job depends on it the same way.
// - e2e: sts:AssumeRole on spore-portal-e2e from the observer, with the run's
//   session name. Its trust admits only same-account operator roles and the
//   teardown role, and only session names starting with spore-e2e-.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DescribeAddressesCommand,
  DescribeKeyPairsCommand,
  EC2Client,
  paginateDescribeInstances,
  paginateDescribeNetworkInterfaces,
  paginateDescribeSecurityGroups,
  paginateDescribeVolumes,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  type Instance,
  type Tag,
} from "@aws-sdk/client-ec2";
import { paginateDescribeInstanceInformation, paginateDescribeSessions, SSMClient, StartSessionCommand, TerminateSessionCommand } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { EC2Provider, SpawnClient } from "@spore-host/spawn-ts";
import { INSTANCE_PROFILE, INSTANCE_TYPE, REGION, RUN_TAG, TTL } from "./config.js";
import type { CallResult, DryRunAction, E2EApi, Identity, ObserverApi, SessionResult } from "./harness.js";
import type { Snapshot } from "./leaks.js";
import { LaunchBudget, sessionName, transformRunInstances, type InstanceRole, type RunInstancesInputLike } from "./run.js";

const run = promisify(execFile);

export interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** The observer's credentials, as the AWS CLI resolves them. Throws (failing the run) when there are none. */
export async function observerCredentials(): Promise<Creds> {
  let stdout: string;
  try {
    ({ stdout } = await run("aws", ["configure", "export-credentials", "--format", "process"], { maxBuffer: 1 << 20 }));
  } catch (e) {
    throw new Error(`PORTAL_E2E_AWS=1 but the AWS CLI has no usable credentials (aws configure export-credentials failed): ${e instanceof Error ? e.message : String(e)}`);
  }
  const j = JSON.parse(stdout) as { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string };
  if (!j.AccessKeyId || !j.SecretAccessKey) throw new Error("aws configure export-credentials returned no access key");
  return { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.SessionToken };
}

const tagMap = (tags: Tag[] | undefined) => Object.fromEntries((tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""]));
const ms = (d: Date | string | undefined) => (d ? new Date(d).getTime() : 0);

async function callerIdentity(sts: STSClient): Promise<Identity> {
  const r = await sts.send(new GetCallerIdentityCommand({}));
  return { account: r.Account ?? "", arn: r.Arn ?? "" };
}

async function collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const p of pages) out.push(p);
  return out;
}

export function observerApi(creds: Creds): ObserverApi {
  const ec2 = new EC2Client({ region: REGION, credentials: creds });
  const ssm = new SSMClient({ region: REGION, credentials: creds });
  const sts = new STSClient({ region: REGION, credentials: creds });

  const instances = async (filters: { Name: string; Values: string[] }[]): Promise<Instance[]> =>
    (await collect(paginateDescribeInstances({ client: ec2 }, { Filters: filters }))).flatMap((p) => (p.Reservations ?? []).flatMap((r) => r.Instances ?? []));
  const guard = (i: Instance) => ({ id: i.InstanceId ?? "", state: i.State?.Name ?? "", tags: tagMap(i.Tags) });
  const notTerminated = { Name: "instance-state-name", Values: ["pending", "running", "shutting-down", "stopping", "stopped"] };

  return {
    identity: () => callerIdentity(sts),
    e2eInstances: async () => (await instances([{ Name: "tag-key", Values: [RUN_TAG] }, notTerminated])).map(guard),
    runInstances: async (runId) => (await instances([{ Name: `tag:${RUN_TAG}`, Values: [runId] }])).map(guard),

    async snapshot(): Promise<Snapshot> {
      const atMs = Date.now();
      const [insts, vols, enis, addrs, sgs, keys, sessions] = await Promise.all([
        instances([notTerminated]),
        collect(paginateDescribeVolumes({ client: ec2 }, {})),
        collect(paginateDescribeNetworkInterfaces({ client: ec2 }, {})),
        ec2.send(new DescribeAddressesCommand({})),
        collect(paginateDescribeSecurityGroups({ client: ec2 }, {})),
        ec2.send(new DescribeKeyPairsCommand({})),
        collect(paginateDescribeSessions({ client: ssm }, { State: "Active" })),
      ]);
      return {
        atMs,
        instances: insts.map((i) => ({
          id: i.InstanceId ?? "",
          state: i.State?.Name ?? "",
          launchTimeMs: ms(i.LaunchTime),
          tags: tagMap(i.Tags),
          clientToken: i.ClientToken,
          instanceType: i.InstanceType,
          instanceProfileArn: i.IamInstanceProfile?.Arn,
        })),
        volumes: vols.flatMap((p) => p.Volumes ?? []).map((v) => ({
          id: v.VolumeId ?? "",
          state: v.State ?? "",
          createTimeMs: ms(v.CreateTime),
          tags: tagMap(v.Tags),
          attachedTo: (v.Attachments ?? []).map((a) => a.InstanceId ?? "").filter(Boolean),
        })),
        enis: enis.flatMap((p) => p.NetworkInterfaces ?? []).map((e) => ({ id: e.NetworkInterfaceId ?? "", status: e.Status ?? "", tags: tagMap(e.TagSet), attachedTo: e.Attachment?.InstanceId })),
        addresses: (addrs.Addresses ?? []).map((a) => ({ id: a.AllocationId ?? a.PublicIp ?? "", tags: tagMap(a.Tags), instanceId: a.InstanceId, eniId: a.NetworkInterfaceId })),
        securityGroups: sgs.flatMap((p) => p.SecurityGroups ?? []).map((g) => ({ id: g.GroupId ?? "", name: g.GroupName ?? "", tags: tagMap(g.Tags) })),
        keyPairs: (keys.KeyPairs ?? []).map((k) => ({ id: k.KeyPairId ?? k.KeyName ?? "", name: k.KeyName ?? "", createTimeMs: ms(k.CreateTime), tags: tagMap(k.Tags) })),
        sessions: sessions.flatMap((p) => p.Sessions ?? []).map((s) => ({ id: s.SessionId ?? "", target: s.Target ?? "", status: s.Status ?? "", startMs: ms(s.StartDate), owner: s.Owner })),
      };
    },

    async ssmOnline(ids) {
      const pages = await collect(paginateDescribeInstanceInformation({ client: ssm }, { Filters: [{ Key: "InstanceIds", Values: ids }] }));
      return pages.flatMap((p) => p.InstanceInformationList ?? []).filter((i) => i.PingStatus === "Online").map((i) => i.InstanceId ?? "");
    },

    async terminate(ids) {
      if (ids.length) await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
    },

    async terminateSession(sessionId) {
      await ssm.send(new TerminateSessionCommand({ SessionId: sessionId }));
    },
  };
}

/** Assume the e2e role for this run. */
export async function assumeE2ERole(observer: Creds, roleArn: string, runId: string): Promise<Creds> {
  const sts = new STSClient({ region: REGION, credentials: observer });
  const r = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName(runId), DurationSeconds: 3600 }));
  const c = r.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error(`AssumeRole ${roleArn} returned no credentials`);
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
}

type Stack = { add: (mw: unknown, opts: { step: string; name: string }) => void };

/**
 * The portal's launch path (legacy-app/surfaces/instances.ts): a SpawnClient
 * over an EC2Provider holding the session's credentials and
 * spored-instance-profile. The harness adds one initialize-step middleware to
 * the provider's own EC2Client, which applies transformRunInstances to each
 * RunInstances request (run tags, ClientToken, the cost guard) and changes
 * nothing else about the call.
 */
export function e2eApi(creds: Creds, runId: string, opts: { budget?: LaunchBudget; endpoint?: string } = {}): E2EApi {
  const budget = opts.budget ?? new LaunchBudget();
  // `endpoint` is for aws.test.ts only (a local capture server); live runs never set it.
  const endpoint = opts.endpoint;
  const provider = new EC2Provider({ region: REGION, ...creds, iamInstanceProfile: INSTANCE_PROFILE, ...(endpoint ? { endpoint } : {}) });
  const inner = (provider as unknown as { client?: { middlewareStack?: Stack } }).client;
  if (!inner?.middlewareStack) throw new Error("spawn-ts EC2Provider no longer exposes its EC2Client; update e2e-aws/aws.ts to tag the launch another way");
  let current: InstanceRole | null = null;
  inner.middlewareStack.add(
    (next: (a: { input: unknown }) => Promise<unknown>, context: { commandName?: string }) => async (args: { input: unknown }) => {
      if (context.commandName === "RunInstancesCommand") {
        if (!current) throw new Error("cost guard: a RunInstances request the harness did not ask for");
        const n = budget.take();
        args = { ...args, input: transformRunInstances(args.input as RunInstancesInputLike, { runId, role: current, n }) };
      }
      return next(args);
    },
    { step: "initialize", name: "sporeE2eRunTags" },
  );
  const client = new SpawnClient({ provider });
  const ec2 = new EC2Client({ region: REGION, credentials: creds, endpoint });
  const ssm = new SSMClient({ region: REGION, credentials: creds, endpoint });
  const sts = new STSClient({ region: REGION, credentials: creds, endpoint });

  const dry = async (action: DryRunAction, id: string): Promise<CallResult> => {
    const input = { InstanceIds: [id], DryRun: true };
    try {
      if (action === "ec2:StopInstances") await ec2.send(new StopInstancesCommand(input));
      else if (action === "ec2:StartInstances") await ec2.send(new StartInstancesCommand(input));
      else await ec2.send(new TerminateInstancesCommand(input));
      return { ok: true };
    } catch (err) {
      return { ok: false, err };
    }
  };

  return {
    identity: () => callerIdentity(sts),
    async launch(role) {
      current = role;
      try {
        // DNS is off (dnsName ""): spored would register a spore.host record,
        // which is outside what the leak check can see. Everything else is a
        // plain portal launch with a 15-minute TTL.
        const inst = await client.launch({ name: `spore-e2e-${runId}-${role}`, instanceType: INSTANCE_TYPE, region: REGION, spot: false, ttl: TTL, dnsName: "" });
        return inst.instanceId;
      } finally {
        current = null;
      }
    },
    state: async (id) => (await provider.get(id))?.state ?? null,
    dryRun: dry,
    async startSession(id): Promise<SessionResult> {
      try {
        const r = await ssm.send(new StartSessionCommand({ Target: id }));
        return { ok: true, sessionId: r.SessionId };
      } catch (err) {
        return { ok: false, err };
      }
    },
    async terminateSession(sessionId) {
      await ssm.send(new TerminateSessionCommand({ SessionId: sessionId }));
    },
  };
}
