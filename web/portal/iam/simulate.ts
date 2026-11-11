// IAM coverage gate, step 4: SimulateCustomPolicy over fixtures with required
// negative cases.
//
// Offline, this module validates the fixtures (the rules below) and runs them
// through an injected simulator. The unit tests inject a fake; the
// credential-gated live job (iam/live.test.ts, .github/workflows/portal-iam-live.yml)
// injects `awsCliSimulator`, which calls `aws iam simulate-custom-policy`.
// Nothing in the default test run calls AWS.
//
// Fixture rules:
// 1. Every fixture has at least one case expected to be denied.
// 2. Every inventory action has at least one case expected to be allowed.
// 3. Every statement with a Condition has, for each of its actions, a case
//    expected to be denied (the condition unmet). A tag gate that is never
//    tested denied is not known to gate anything.
// 4. Every case names an action some policy statement mentions or is
//    explicitly a "must never be allowed" case (expect denied).
// Tag-gated allow cases carry realCall:true: the simulator is known to
// misjudge some tag conditions, so each also gets one real call, both ways, in
// the real-AWS e2e harness (web/portal/e2e-aws/). gates/e2e-aws-plan.test.ts
// fails offline when a tag-gated grant has no such call planned.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Decision = "allowed" | "implicitDeny" | "explicitDeny";

export interface SimCase {
  name: string;
  action: string;
  resource: string;
  context?: Record<string, string>;
  expect: "allowed" | "denied";
  realCall?: boolean;
}

export interface Fixture {
  $comment?: string;
  policyFile: string;
  account: string;
  sporedInstanceRole: string;
  cases: SimCase[];
}

export interface PolicyStatement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDoc {
  Version: string;
  Statement: PolicyStatement[];
}

export interface PolicyFile {
  $comment?: string;
  role: string;
  policies: Record<string, PolicyDoc>;
}

export interface SimRequest {
  policies: string[];
  action: string;
  resource: string;
  context: Record<string, string>;
}

export type Simulator = (req: SimRequest) => Promise<Decision>;

const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

/** Substitute the fixture's account and role into a policy file. */
export function renderPolicies(file: PolicyFile, vars: { account: string; sporedInstanceRole: string }): Record<string, PolicyDoc> {
  const raw = JSON.stringify(file.policies)
    .replaceAll("${ACCOUNT_ID}", vars.account)
    .replaceAll("${SPORED_INSTANCE_ROLE}", vars.sporedInstanceRole);
  return JSON.parse(raw) as Record<string, PolicyDoc>;
}

function render(s: string, f: Fixture): string {
  return s.replaceAll("${ACCOUNT_ID}", f.account).replaceAll("${SPORED_INSTANCE_ROLE}", f.sporedInstanceRole);
}

/** Every rule above, as problems. Empty means the fixtures are complete. */
export function fixtureProblems(fixtures: Fixture[], policies: PolicyFile[], inventoryActions: string[]): string[] {
  const out: string[] = [];
  const statements = policies.flatMap((p) => Object.entries(p.policies).flatMap(([name, d]) => d.Statement.map((s) => ({ name, s }))));
  const mentioned = new Set(statements.flatMap(({ s }) => list(s.Action)));
  const cases = fixtures.flatMap((f) => f.cases);

  for (const f of fixtures) {
    if (!f.cases.some((c) => c.expect === "denied")) out.push(`fixture for ${f.policyFile} has no case expected to be denied`);
    for (const c of f.cases) {
      if (!/^[a-z0-9-]+:[A-Za-z0-9]+$/.test(c.action)) out.push(`case "${c.name}": "${c.action}" is not an IAM action`);
      if (c.expect === "allowed" && !mentioned.has(c.action)) out.push(`case "${c.name}" expects ${c.action} allowed, but no statement grants it`);
    }
  }
  for (const a of inventoryActions) {
    if (!cases.some((c) => c.action === a && c.expect === "allowed")) out.push(`inventory action ${a} has no case expected to be allowed`);
  }
  for (const { name, s } of statements) {
    if (!s.Condition) continue;
    for (const a of list(s.Action)) {
      if (!cases.some((c) => c.action === a && c.expect === "denied")) {
        out.push(`${name}${s.Sid ? `/${s.Sid}` : ""} grants ${a} under a condition, but no case tests it denied`);
      }
    }
  }
  return out;
}

export interface CaseResult {
  fixture: string;
  case: SimCase;
  /** The resource ARN as simulated, with the fixture's account substituted. */
  resource: string;
  decision: Decision;
  ok: boolean;
}

/** Run every case through `simulate`. */
export async function runFixtures(fixtures: Fixture[], policyFor: (f: Fixture) => PolicyFile, simulate: Simulator): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const f of fixtures) {
    const docs = Object.values(renderPolicies(policyFor(f), f)).map((d) => JSON.stringify(d));
    for (const c of f.cases) {
      const context = Object.fromEntries(Object.entries(c.context ?? {}).map(([k, v]) => [k, render(v, f)]));
      const resource = render(c.resource, f);
      const decision = await simulate({ policies: docs, action: c.action, resource, context });
      const ok = c.expect === "allowed" ? decision === "allowed" : decision !== "allowed";
      results.push({ fixture: f.policyFile, case: c, resource, decision, ok });
    }
  }
  return results;
}

export function failures(results: CaseResult[]): string[] {
  return results.filter((r) => !r.ok).map((r) => `"${r.case.name}": ${r.case.action} on ${r.resource} was ${r.decision}, expected ${r.case.expect}`);
}

const run = promisify(execFile);

/**
 * The live simulator: `aws iam simulate-custom-policy`. ONLY the
 * credential-gated job uses it. Uses the AWS CLI, which spore.host already
 * depends on, rather than adding @aws-sdk/client-iam to the web package.
 */
export const awsCliSimulator: Simulator = async (req) => {
  const args = [
    "iam",
    "simulate-custom-policy",
    "--output",
    "json",
    "--policy-input-list",
    ...req.policies,
    "--action-names",
    req.action,
    "--resource-arns",
    req.resource,
  ];
  const entries = Object.entries(req.context).map(([k, v]) => ({ ContextKeyName: k, ContextKeyValues: [v], ContextKeyType: "string" }));
  if (entries.length) args.push("--context-entries", JSON.stringify(entries));
  const { stdout } = await run("aws", args, { maxBuffer: 1 << 20 });
  const out = JSON.parse(stdout) as { EvaluationResults: { EvalDecision: Decision }[] };
  const d = out.EvaluationResults[0]?.EvalDecision;
  if (d !== "allowed" && d !== "implicitDeny" && d !== "explicitDeny") throw new Error(`unexpected simulator decision: ${String(d)}`);
  return d;
};

/**
 * Normalise a policy document for the drift comparison, so only meaning
 * counts: IAM accepts a string or a one-element list for Action, Resource and
 * each condition value, and does not care about their order. Sids, effects,
 * operators and condition keys are kept as they are, so changing any of them
 * is drift.
 */
export function normalisePolicy(doc: PolicyDoc): unknown {
  const sorted = (v: string | string[]) => [...list(v)].sort();
  return {
    Version: doc.Version,
    Statement: doc.Statement.map((s) => ({
      ...s,
      Action: sorted(s.Action),
      Resource: sorted(s.Resource),
      ...(s.Condition
        ? {
            Condition: Object.fromEntries(
              Object.entries(s.Condition).map(([op, kv]) => [op, Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, sorted(v)]))]),
            ),
          }
        : {}),
    })),
  };
}

/** A role's trust policy, as the drift check reads it. */
export interface TrustDoc {
  Version: string;
  Statement: {
    Sid?: string;
    Effect: string;
    Principal: Record<string, string | string[]>;
    Action: string | string[];
    Condition?: Record<string, Record<string, string | string[]>>;
  }[];
}

/** normalisePolicy for a trust policy: Principal values, Action and condition values as sorted lists. */
export function normaliseTrust(doc: TrustDoc): unknown {
  const sorted = (v: string | string[]) => [...list(v)].sort();
  return {
    Version: doc.Version,
    Statement: doc.Statement.map((s) => ({
      ...s,
      Principal: Object.fromEntries(Object.entries(s.Principal).map(([k, v]) => [k, sorted(v)])),
      Action: sorted(s.Action),
      ...(s.Condition
        ? { Condition: Object.fromEntries(Object.entries(s.Condition).map(([op, kv]) => [op, Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, sorted(v)]))])) }
        : {}),
    })),
  };
}

/** IAM-style wildcard match: `*` is any run of characters, everything else literal. */
export function glob(pattern: string, value: string, caseInsensitive: boolean): boolean {
  const p = caseInsensitive ? pattern.toLowerCase() : pattern;
  const v = caseInsensitive ? value.toLowerCase() : value;
  const parts = p.split("*");
  if (parts.length === 1) return p === v;
  if (!v.startsWith(parts[0]) || !v.endsWith(parts[parts.length - 1])) return false;
  let at = parts[0].length;
  const end = v.length - parts[parts.length - 1].length;
  for (const mid of parts.slice(1, -1)) {
    const i = v.indexOf(mid, at);
    if (i === -1 || i + mid.length > end) return false;
    at = i + mid.length;
  }
  return at <= end;
}

/**
 * An offline approximation of IAM evaluation, so the default test run checks
 * that the fixtures agree with the checked-in policy without calling AWS.
 * It understands Allow/Deny, Action and Resource wildcards, and the
 * StringEquals and Null operators; anything else throws rather than guessing. The live
 * simulator is the authority; this only catches a fixture and a policy
 * drifting apart before that job runs.
 */
export function offlineSimulator(): Simulator {
  return async (req) => {
    let allowed = false;
    for (const raw of req.policies) {
      const doc = JSON.parse(raw) as PolicyDoc;
      for (const s of doc.Statement) {
        if (!list(s.Action).some((a) => glob(a, req.action, true))) continue;
        if (!list(s.Resource).some((r) => glob(r, req.resource, false))) continue;
        let conditionMet = true;
        for (const [op, kv] of Object.entries(s.Condition ?? {})) {
          if (op !== "StringEquals" && op !== "Null") throw new Error(`offline simulator does not evaluate ${op}; run the live job`);
          for (const [k, v] of Object.entries(kv)) {
            const have = Object.entries(req.context).find(([ck]) => ck.toLowerCase() === k.toLowerCase())?.[1];
            if (op === "Null") {
              // Null "true": the key is absent; "false": it is present.
              const wantAbsent = list(v).map((x) => x.toLowerCase());
              if (wantAbsent.length !== 1 || !["true", "false"].includes(wantAbsent[0])) throw new Error(`offline simulator: Null takes "true" or "false", not ${JSON.stringify(v)}`);
              if ((have === undefined) !== (wantAbsent[0] === "true")) conditionMet = false;
            } else if (have === undefined || !list(v).includes(have)) conditionMet = false;
          }
        }
        if (!conditionMet) continue;
        if (s.Effect === "Deny") return "explicitDeny";
        allowed = true;
      }
    }
    return allowed ? "allowed" : "implicitDeny";
  };
}
