import { describe, expect, it } from "vitest";
import { CATALOGUE, classify, entryFor, errorCode, supportDetails } from "./errors.js";

const awsErr = (name: string, status?: number) => Object.assign(new Error(`${name} message`), { name, $metadata: { httpStatusCode: status, requestId: "req-1" } });

describe("error catalogue", () => {
  it("classifies by AWS code first", () => {
    expect(classify(awsErr("UnauthorizedOperation", 403))).toBe("not-permitted");
    expect(classify(awsErr("VcpuLimitExceeded", 400))).toBe("quota");
    expect(classify(awsErr("InsufficientInstanceCapacity", 500))).toBe("capacity");
    expect(classify(awsErr("ExpiredToken", 400))).toBe("signed-out");
    expect(classify(awsErr("InvalidParameterValue", 400))).toBe("invalid-request");
    expect(classify(awsErr("RequestLimitExceeded", 503))).toBe("throttled");
  });

  it("uses spawn's capacity codes (spawn/pkg/aws/zone_fallback.go)", () => {
    for (const c of ["InsufficientInstanceCapacity", "InsufficientHostCapacity", "MaxSpotInstanceCountExceeded", "SpotMaxPriceTooLow"]) {
      expect(classify(awsErr(c)), c).toBe("capacity");
    }
  });

  it("falls back to network failures, then HTTP status", () => {
    expect(classify(new TypeError("Failed to fetch"))).toBe("network");
    expect(classify(Object.assign(new Error("x"), { $metadata: { httpStatusCode: 502 } }))).toBe("service-error");
    expect(classify(Object.assign(new Error("x"), { $metadata: { httpStatusCode: 403 } }))).toBe("not-permitted");
    expect(classify(Object.assign(new Error("x"), { $metadata: { httpStatusCode: 401 } }))).toBe("signed-out");
    expect(classify("something odd")).toBe("unknown");
    expect(classify(null)).toBe("unknown");
  });

  it("never treats the generic Error name as a code", () => {
    expect(errorCode(new Error("x"))).toBeUndefined();
  });

  it("every entry has what happened, why, and one action", () => {
    for (const [k, e] of Object.entries(CATALOGUE)) {
      expect(e.kind).toBe(k);
      expect(e.title).not.toMatch(/HTTP|\d{3}|Exception|Error$/);
      expect(e.action.label.length).toBeGreaterThan(0);
    }
  });

  it("no AWS code belongs to two entries", () => {
    const codes = Object.values(CATALOGUE).flatMap((e) => e.codes);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("support details carry code, status, request id and message, nothing else", () => {
    const d = supportDetails(Object.assign(awsErr("AccessDenied", 403), { headers: { authorization: "AWS4-HMAC-SHA256 secret" } }));
    expect(d).toBe("Code: AccessDenied\nHTTP status: 403\nRequest id: req-1\nMessage: AccessDenied message");
    expect(d).not.toContain("secret");
    expect(supportDetails({})).toBe("No further detail was returned.");
  });

  it("entryFor returns the catalogue entry", () => {
    expect(entryFor(awsErr("VcpuLimitExceeded")).title).toBe("Your AWS account isn't approved for this size yet");
  });
});
