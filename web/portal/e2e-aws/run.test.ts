// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ROLE_TAG, RUN_TAG } from "./config.js";
import { clientToken, LaunchBudget, newRunId, preflightRefusal, sessionName, transformRunInstances, validateRunId, type RunInstancesInputLike } from "./run.js";

const spawnTsInput = (over: Partial<RunInstancesInputLike> = {}): RunInstancesInputLike => ({
  ImageId: "ami-0123",
  InstanceType: "t4g.nano",
  MinCount: 1,
  MaxCount: 1,
  IamInstanceProfile: { Name: "spored-instance-profile" },
  TagSpecifications: [
    {
      ResourceType: "instance",
      Tags: [
        { Key: "Name", Value: "spore-e2e-r1-managed" },
        { Key: "spawn:managed", Value: "true" },
        { Key: "spawn:ttl", Value: "15m" },
        { Key: "spawn:ttl-deadline", Value: "2026-11-10T12:15:00.000Z" },
      ],
    },
  ],
  ...over,
});
const tagsOf = (input: RunInstancesInputLike, type: string) =>
  Object.fromEntries((input.TagSpecifications?.find((s) => s.ResourceType === type)?.Tags ?? []).map((t) => [t.Key, t.Value]));

describe("run id", () => {
  it("is short, lowercase and stable for a given time and nonce", () => {
    const id = newRunId(Date.UTC(2026, 10, 10, 15, 30, 0), "AB12CD");
    expect(id).toBe("local-20261110t153000z-ab12cd");
    expect(sessionName(id).length).toBeLessThanOrEqual(64);
    expect(clientToken(id, 2).length).toBeLessThanOrEqual(64);
  });

  it("rejects ids that could not be a tag value, a session name and a ClientToken", () => {
    for (const bad of ["", "UPPER", "a b", "x".repeat(41), "-lead", "has_underscore"]) expect(() => validateRunId(bad), bad).toThrow();
    expect(validateRunId("gh-1234567890-1")).toBe("gh-1234567890-1");
  });
});

describe("RunInstances transform", () => {
  it("adds the run tags to the instance, its volumes and its interfaces, and a run ClientToken", () => {
    const out = transformRunInstances(spawnTsInput(), { runId: "r1abc", role: "managed", n: 1 });
    expect(tagsOf(out, "instance")).toMatchObject({ "spawn:managed": "true", "spawn:ttl": "15m", [RUN_TAG]: "r1abc", [ROLE_TAG]: "managed" });
    expect(tagsOf(out, "volume")).toEqual({ [RUN_TAG]: "r1abc", [ROLE_TAG]: "managed" });
    expect(tagsOf(out, "network-interface")).toEqual({ [RUN_TAG]: "r1abc", [ROLE_TAG]: "managed" });
    expect(out.ClientToken).toBe("spore-e2e-r1abc-1");
    expect(out.InstanceInitiatedShutdownBehavior).toBe("terminate");
    // The rest of the portal's request is untouched.
    expect(out.IamInstanceProfile).toEqual({ Name: "spored-instance-profile" });
    expect(out.ImageId).toBe("ami-0123");
  });

  it("drops spawn:managed, and only that, for the control instance", () => {
    const managed = tagsOf(transformRunInstances(spawnTsInput(), { runId: "r1abc", role: "managed", n: 1 }), "instance");
    const control = tagsOf(transformRunInstances(spawnTsInput(), { runId: "r1abc", role: "control", n: 2 }), "instance");
    expect(control["spawn:managed"]).toBeUndefined();
    const { "spawn:managed": _m, [ROLE_TAG]: _r1, ...restManaged } = managed;
    const { [ROLE_TAG]: _r2, ...restControl } = control;
    expect(restControl).toEqual(restManaged);
  });

  it("refuses anything but one t4g.nano On-Demand with a TTL of at most 15m", () => {
    const o = { runId: "r1abc", role: "managed" as const, n: 1 };
    expect(() => transformRunInstances(spawnTsInput({ InstanceType: "p5.48xlarge" }), o)).toThrow(/t4g.nano only/);
    expect(() => transformRunInstances(spawnTsInput({ MaxCount: 3 }), o)).toThrow(/one instance per launch/);
    expect(() => transformRunInstances(spawnTsInput({ InstanceMarketOptions: { MarketType: "spot" } }), o)).toThrow(/On-Demand only/);
    const longTtl = spawnTsInput();
    longTtl.TagSpecifications![0].Tags = longTtl.TagSpecifications![0].Tags!.map((t) => (t.Key === "spawn:ttl" ? { ...t, Value: "4h" } : t));
    expect(() => transformRunInstances(longTtl, o)).toThrow(/at most 15m/);
    const noTtl = spawnTsInput();
    noTtl.TagSpecifications![0].Tags = noTtl.TagSpecifications![0].Tags!.filter((t) => t.Key !== "spawn:ttl");
    expect(() => transformRunInstances(noTtl, o)).toThrow(/at most 15m/);
    expect(() => transformRunInstances(spawnTsInput({ TagSpecifications: [] }), o)).toThrow(/no instance TagSpecification/);
  });
});

describe("cost guard", () => {
  it("caps a run at two launches", () => {
    const b = new LaunchBudget();
    expect(b.take()).toBe(1);
    expect(b.take()).toBe(2);
    expect(() => b.take()).toThrow(/cap is 2/);
    expect(b.count).toBe(2);
  });

  it("refuses to start while an earlier run's instance is live, and names it", () => {
    const r = preflightRefusal([
      { id: "i-0aaa", state: "running", tags: { [RUN_TAG]: "old-run" } },
      { id: "i-0bbb", state: "terminated", tags: { [RUN_TAG]: "older" } },
    ]);
    expect(r).toMatch(/i-0aaa \(running, spore-host:e2e-run=old-run\)/);
    expect(r).not.toMatch(/i-0bbb/);
  });

  it("counts stopped as live: it bills for storage and can be started again", () => {
    expect(preflightRefusal([{ id: "i-0aaa", state: "stopped", tags: { [RUN_TAG]: "x" } }])).not.toBeNull();
  });

  it("goes ahead when nothing of a run is live, or only untagged instances are", () => {
    expect(preflightRefusal([])).toBeNull();
    expect(preflightRefusal([{ id: "i-0ccc", state: "running", tags: { "spawn:managed": "true" } }])).toBeNull();
    expect(preflightRefusal([{ id: "i-0ddd", state: "shutting-down", tags: { [RUN_TAG]: "x" } }])).toBeNull();
  });
});
