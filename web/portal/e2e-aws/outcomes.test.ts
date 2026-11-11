// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyDryRun, classifyStartSession, errorCode } from "./outcomes.js";

const err = (name: string) => Object.assign(new Error(name), { name });

describe("real-call outcomes fail closed", () => {
  it("reads the SDK's error code", () => {
    expect(errorCode(err("UnauthorizedOperation"))).toBe("UnauthorizedOperation");
    expect(errorCode({ Code: "DryRunOperation", name: "Error" })).toBe("DryRunOperation");
    expect(errorCode("boom")).toBe("boom");
  });

  it("DryRun: DryRunOperation is allowed, UnauthorizedOperation denied, anything else inconclusive", () => {
    expect(classifyDryRun({ ok: false, err: err("DryRunOperation") }).decision).toBe("allowed");
    expect(classifyDryRun({ ok: false, err: err("UnauthorizedOperation") }).decision).toBe("denied");
    expect(classifyDryRun({ ok: false, err: err("IncorrectInstanceState") })).toEqual({ decision: "inconclusive", evidence: "IncorrectInstanceState" });
    expect(classifyDryRun({ ok: false, err: err("RequestLimitExceeded") }).decision).toBe("inconclusive");
    expect(classifyDryRun({ ok: true }).decision).toBe("inconclusive");
  });

  it("StartSession: a SessionId is allowed, AccessDenied denied, TargetNotConnected retried, never a pass", () => {
    expect(classifyStartSession({ ok: true, sessionId: "s-1" })).toEqual({ decision: "allowed", evidence: "SessionId s-1", retry: false });
    expect(classifyStartSession({ ok: true }).decision).toBe("inconclusive");
    expect(classifyStartSession({ ok: false, err: err("AccessDeniedException") })).toEqual({ decision: "denied", evidence: "AccessDeniedException", retry: false });
    expect(classifyStartSession({ ok: false, err: err("TargetNotConnected") })).toEqual({ decision: "inconclusive", evidence: "TargetNotConnected", retry: true });
    expect(classifyStartSession({ ok: false, err: err("ThrottlingException") }).retry).toBe(false);
  });
});
