// How a real call's result maps to an authorisation decision. Pure.
//
// Fail closed: anything that is not an authoritative "allowed" or "denied"
// answer is "inconclusive", and an inconclusive proof fails the run.

export type Decision = "allowed" | "denied" | "inconclusive";

export interface Outcome {
  decision: Decision;
  /** The error code or result the decision rests on, for the report. */
  evidence: string;
}

/** The name/code the AWS SDK puts on a service error. */
export function errorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; Code?: unknown; code?: unknown };
    for (const v of [e.Code, e.code, e.name]) if (typeof v === "string" && v && v !== "Error") return v;
  }
  return String(err);
}

/**
 * EC2 DryRun. AWS documents DryRun as checking "whether you have the required
 * permissions for the action, without actually making the request":
 * DryRunOperation means the IAM evaluation allowed it, UnauthorizedOperation
 * means it denied it. The evaluation includes the instance's tags, so this is
 * an authoritative answer for a tag-conditioned EC2 grant without stopping,
 * starting or terminating anything. A DryRun call that SUCCEEDS is impossible
 * by contract and counts as inconclusive.
 */
export function classifyDryRun(result: { ok: true } | { ok: false; err: unknown }): Outcome {
  if (result.ok) return { decision: "inconclusive", evidence: "the DryRun call returned success, which DryRun never does" };
  const code = errorCode(result.err);
  if (code === "DryRunOperation") return { decision: "allowed", evidence: code };
  if (code === "UnauthorizedOperation") return { decision: "denied", evidence: code };
  return { decision: "inconclusive", evidence: code };
}

/**
 * ssm:StartSession has no DryRun. A returned SessionId is "allowed" (the caller
 * closes it at once); AccessDeniedException is "denied". TargetNotConnected
 * means IAM let the request through but the agent is not online yet, which the
 * harness retries until the agent is up rather than accept as a proof.
 */
export function classifyStartSession(result: { ok: true; sessionId?: string } | { ok: false; err: unknown }): Outcome & { retry: boolean } {
  if (result.ok) {
    if (result.sessionId) return { decision: "allowed", evidence: `SessionId ${result.sessionId}`, retry: false };
    return { decision: "inconclusive", evidence: "StartSession returned no SessionId", retry: false };
  }
  const code = errorCode(result.err);
  if (code === "AccessDeniedException") return { decision: "denied", evidence: code, retry: false };
  if (code === "TargetNotConnected") return { decision: "inconclusive", evidence: code, retry: true };
  return { decision: "inconclusive", evidence: code, retry: false };
}
