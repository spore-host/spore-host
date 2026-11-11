// @vitest-environment node
import { describe, expect, it } from "vitest";
import { RUN_TAG } from "./config.js";
import { detectLeaks, teardownTargets, type RunContext, type Snapshot } from "./leaks.js";

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const MIN = 60_000;
const empty = (atMs = T0): Snapshot => ({ atMs, instances: [], volumes: [], enis: [], addresses: [], securityGroups: [], keyPairs: [], sessions: [] });
const ctx = (over: Partial<RunContext> = {}): RunContext => ({ runId: "r1abc", windowStartMs: T0, windowEndMs: T0 + 10 * MIN, launchedIds: ["i-0aaaaaaaaaaaaaaa1", "i-0aaaaaaaaaaaaaaa2"], sessionIds: [], ...over });
const run = { [RUN_TAG]: "r1abc" };

describe("leak check: clean", () => {
  it("reports nothing when the run's instances are terminated and nothing else changed", () => {
    const before = empty();
    before.instances.push({ id: "i-0other", state: "running", launchTimeMs: T0 - 600 * MIN, tags: {} });
    const after = structuredClone(before);
    expect(detectLeaks(before, after, ctx())).toEqual({ leaks: [], notices: [] });
  });

  it("does not count a run instance that is shutting down (it no longer bills)", () => {
    const after = empty();
    after.instances.push({ id: "i-0aaaaaaaaaaaaaaa1", state: "shutting-down", launchTimeMs: T0 + MIN, tags: run });
    expect(detectLeaks(empty(), after, ctx()).leaks).toEqual([]);
  });

  it("ignores volumes that are being deleted", () => {
    const after = empty();
    after.volumes.push({ id: "vol-1", state: "deleting", createTimeMs: T0 + MIN, tags: run, attachedTo: [] });
    expect(detectLeaks(empty(), after, ctx()).leaks).toEqual([]);
  });
});

describe("leak check: instances", () => {
  for (const state of ["pending", "running", "stopping", "stopped"]) {
    it(`fails a run instance left ${state}, by tag`, () => {
      const after = empty();
      after.instances.push({ id: "i-0aaaaaaaaaaaaaaa1", state, launchTimeMs: T0 + MIN, tags: run });
      expect(detectLeaks(empty(), after, ctx()).leaks).toEqual([{ kind: "instance", id: "i-0aaaaaaaaaaaaaaa1", why: `${state} after teardown (spore-host:e2e-run=r1abc, launched by this run)` }]);
    });
  }

  it("finds an instance that lost its tag, by its ClientToken", () => {
    const after = empty();
    after.instances.push({ id: "i-0bbbbbbbbbbbbbbb9", state: "running", launchTimeMs: T0 + MIN, tags: {}, clientToken: "spore-e2e-r1abc-2" });
    expect(detectLeaks(empty(), after, ctx({ launchedIds: [] })).leaks.map((l) => l.id)).toEqual(["i-0bbbbbbbbbbbbbbb9"]);
  });

  it("finds an instance with no tag and no token, by the id the launch returned", () => {
    const after = empty();
    after.instances.push({ id: "i-0aaaaaaaaaaaaaaa2", state: "running", launchTimeMs: T0 + MIN, tags: {} });
    expect(detectLeaks(empty(), after, ctx()).leaks.map((l) => l.why)).toEqual(["running after teardown (launched by this run)"]);
  });

  it("does not take another run's ClientToken prefix for this one's", () => {
    const after = empty();
    after.instances.push({ id: "i-0ccc", state: "running", launchTimeMs: T0 + MIN, tags: {}, clientToken: "spore-e2e-r1abcd-1" });
    expect(detectLeaks(empty(), after, ctx({ launchedIds: [] })).leaks).toEqual([]);
  });

  it("notes, but does not fail on, someone else's instance launched in the window", () => {
    const after = empty();
    after.instances.push({ id: "i-0someone", state: "running", launchTimeMs: T0 + 3 * MIN, tags: {}, instanceType: "c7g.large" });
    after.instances.push({ id: "i-0oldbox", state: "running", launchTimeMs: T0 - 900 * MIN, tags: {} });
    const r = detectLeaks(empty(), after, ctx());
    expect(r.leaks).toEqual([]);
    expect(r.notices).toEqual(["instance i-0someone (c7g.large, running) was launched during the run window but is not this run's."]);
  });
});

describe("leak check: volumes, interfaces, addresses", () => {
  it("fails a run volume by tag, and one still attached to a run instance", () => {
    const after = empty();
    after.volumes.push({ id: "vol-tagged", state: "available", createTimeMs: T0 + MIN, tags: run, attachedTo: [] });
    after.volumes.push({ id: "vol-attached", state: "in-use", createTimeMs: T0 + MIN, tags: {}, attachedTo: ["i-0aaaaaaaaaaaaaaa1"] });
    expect(detectLeaks(empty(), after, ctx()).leaks.map((l) => `${l.kind} ${l.id}`)).toEqual(["volume vol-tagged", "volume vol-attached"]);
  });

  it("fails an untagged volume created in the window and attached to nothing (an orphaned root volume)", () => {
    const after = empty();
    after.volumes.push({ id: "vol-orphan", state: "available", createTimeMs: T0 + 2 * MIN, tags: {}, attachedTo: [] });
    expect(detectLeaks(empty(), after, ctx()).leaks).toEqual([{ kind: "volume", id: "vol-orphan", why: "available, created during the run window and attached to nothing" }]);
  });

  it("only notes a new volume attached to someone else's instance", () => {
    const after = empty();
    after.volumes.push({ id: "vol-theirs", state: "in-use", createTimeMs: T0 + 2 * MIN, tags: {}, attachedTo: ["i-0someone"] });
    const r = detectLeaks(empty(), after, ctx());
    expect(r.leaks).toEqual([]);
    expect(r.notices).toHaveLength(1);
  });

  it("does not fail a pre-existing unattached volume", () => {
    const before = empty();
    before.volumes.push({ id: "vol-old", state: "available", createTimeMs: T0 - 99 * MIN, tags: {}, attachedTo: [] });
    expect(detectLeaks(before, structuredClone(before), ctx()).leaks).toEqual([]);
  });

  it("fails a run interface by tag or attachment, and a new available interface", () => {
    const after = empty();
    after.enis.push({ id: "eni-tagged", status: "available", tags: run });
    after.enis.push({ id: "eni-attached", status: "in-use", tags: {}, attachedTo: "i-0aaaaaaaaaaaaaaa2" });
    after.enis.push({ id: "eni-orphan", status: "available", tags: {} });
    after.enis.push({ id: "eni-theirs", status: "in-use", tags: {}, attachedTo: "i-0someone" });
    expect(detectLeaks(empty(), after, ctx()).leaks.map((l) => l.id)).toEqual(["eni-tagged", "eni-attached", "eni-orphan"]);
  });

  it("fails an address tied to the run, and a new unassociated address", () => {
    const before = empty();
    before.enis.push({ id: "eni-run", status: "in-use", tags: run, attachedTo: "i-0aaaaaaaaaaaaaaa1" });
    before.addresses.push({ id: "eipalloc-old", tags: {} });
    const after = empty();
    after.addresses.push({ id: "eipalloc-old", tags: {} });
    after.addresses.push({ id: "eipalloc-inst", tags: {}, instanceId: "i-0aaaaaaaaaaaaaaa1" });
    after.addresses.push({ id: "eipalloc-eni", tags: {}, eniId: "eni-run" });
    after.addresses.push({ id: "eipalloc-new", tags: {} });
    after.addresses.push({ id: "eipalloc-theirs", tags: {}, instanceId: "i-0someone" });
    expect(detectLeaks(before, after, ctx()).leaks.map((l) => l.id)).toEqual(["eipalloc-inst", "eipalloc-eni", "eipalloc-new"]);
  });
});

describe("leak check: security groups, key pairs, sessions", () => {
  it("fails groups and key pairs by tag or run-name prefix, notes other new ones", () => {
    const after = empty();
    after.securityGroups.push({ id: "sg-run", name: "spore-e2e-r1abc-sg", tags: {} }, { id: "sg-tag", name: "x", tags: run }, { id: "sg-new", name: "launch-wizard-9", tags: {} });
    after.keyPairs.push({ id: "key-run", name: "spore-e2e-r1abc", createTimeMs: T0 + MIN, tags: {} }, { id: "key-new", name: "alice", createTimeMs: T0 + MIN, tags: {} });
    const r = detectLeaks(empty(), after, ctx());
    expect(r.leaks.map((l) => `${l.kind} ${l.id}`)).toEqual(["security-group sg-run", "security-group sg-tag", "key-pair key-run"]);
    expect(r.notices).toHaveLength(2);
  });

  it("fails a session still open on a run instance, one the run opened, and one named for the run", () => {
    const after = empty();
    after.sessions.push(
      { id: "someone-0aaa", target: "i-0aaaaaaaaaaaaaaa1", status: "Connected", startMs: T0 + MIN },
      { id: "x-0bbb", target: "i-0elsewhere", status: "Connected", startMs: T0 + MIN },
      { id: "spore-e2e-r1abc-0ccc", target: "i-0elsewhere", status: "Connected", startMs: T0 + MIN },
      { id: "e2e-role-0ddd", target: "i-0elsewhere", status: "Connected", startMs: T0 + MIN, owner: "arn:aws:sts::435415984226:assumed-role/spore-portal-e2e/x" },
      { id: "bob-0eee", target: "i-0bobs", status: "Connected", startMs: T0 + MIN, owner: "arn:aws:sts::435415984226:assumed-role/Admin/bob" },
    );
    expect(detectLeaks(empty(), after, ctx({ sessionIds: ["x-0bbb"] })).leaks.map((l) => l.id)).toEqual(["someone-0aaa", "x-0bbb", "spore-e2e-r1abc-0ccc", "e2e-role-0ddd"]);
  });
});

describe("teardown filter", () => {
  const instances: { id: string; state: string; tags: Record<string, string> }[] = [
    { id: "i-0aaaaaaaaaaaaaaa1", state: "running", tags: run },
    { id: "i-0aaaaaaaaaaaaaaa2", state: "stopped", tags: run },
    { id: "i-0aaaaaaaaaaaaaaa3", state: "terminated", tags: run },
    { id: "i-0aaaaaaaaaaaaaaa4", state: "shutting-down", tags: run },
    { id: "i-0bbbbbbbbbbbbbbb1", state: "running", tags: { [RUN_TAG]: "another-run" } },
    { id: "i-0bbbbbbbbbbbbbbb2", state: "running", tags: { "spawn:managed": "true" } },
    { id: "not-an-instance-id", state: "running", tags: run },
  ];

  it("terminates this run's live instances only", () => {
    expect(teardownTargets(instances, "r1abc")).toEqual(["i-0aaaaaaaaaaaaaaa1", "i-0aaaaaaaaaaaaaaa2"]);
  });

  it("is idempotent: nothing to do once they are on their way out", () => {
    const after = instances.map((i) => (i.tags[RUN_TAG] === "r1abc" ? { ...i, state: "shutting-down" } : i));
    expect(teardownTargets(after, "r1abc")).toEqual([]);
  });

  it("never touches another run's or an untagged instance", () => {
    expect(teardownTargets(instances, "another-run")).toEqual(["i-0bbbbbbbbbbbbbbb1"]);
    expect(teardownTargets(instances, "")).toEqual([]);
  });
});
