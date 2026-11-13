// The ported pure modules (brief §9 reuse table): disclosure, session expiry,
// hashstate, config and the cost math. Plus format and regions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appliedLevel, atLeast, DEFAULT_LEVEL, isLevel, levelForNavigation, loadLevel, saveLevel, STORAGE_KEY } from "./disclosure.js";
import { expiryPhase, minutesLeft, SessionController, WARN_BEFORE_MS, type ExpiryEvent } from "./session.js";
import { hashPath, readHashParam, readHashParams, writeHashParams } from "./hashstate.js";
import { identityOverridesAllowed, missingConfig, resolveConfig, SS_CONFIG } from "./config.js";
import { COST_LIMIT_HEADROOM, costLimitFor, maxCostFor } from "./cost.js";
import { accountLabel, formatAgo, formatClock, formatDuration, formatMoney, formatRate, plural } from "./format.js";
import { regionName } from "./regions.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
}

describe("disclosure", () => {
  it("has exactly basic and advanced, in that order (D3)", () => {
    expect(atLeast("basic", "basic")).toBe(true);
    expect(atLeast("advanced", "basic")).toBe(true);
    expect(atLeast("basic", "advanced")).toBe(false);
    expect(isLevel("guided")).toBe(false);
    expect(isLevel("expert")).toBe(false);
  });

  it("is off by default", () => {
    expect(DEFAULT_LEVEL).toBe("basic");
    expect(loadLevel(fakeStorage())).toBe("basic");
  });

  it("ignores a legacy or unknown value instead of trusting it", () => {
    expect(loadLevel(fakeStorage({ [STORAGE_KEY]: "expert" }))).toBe("basic");
    expect(loadLevel(fakeStorage({ "spore.disclosure": "expert" }))).toBe("basic");
  });

  it("survives storage that throws", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadLevel(bad)).toBe("basic");
    expect(() => saveLevel("advanced", bad)).not.toThrow();
  });

  it("saving does not change the applied level; the next navigation does", () => {
    const s = fakeStorage();
    expect(levelForNavigation(s)).toBe("basic");
    saveLevel("advanced", s);
    expect(appliedLevel()).toBe("basic");
    expect(levelForNavigation(s)).toBe("advanced");
    expect(appliedLevel()).toBe("advanced");
  });
});

describe("session expiry", () => {
  const T = 1_000_000_000_000;

  it("decides the phase from the expiry time alone", () => {
    expect(expiryPhase(T + WARN_BEFORE_MS + 1000, T)).toEqual({ phase: "ok", msUntilWarning: 1000 });
    expect(expiryPhase(T + WARN_BEFORE_MS, T)).toEqual({ phase: "warning", msUntilExpiry: WARN_BEFORE_MS });
    expect(expiryPhase(T, T)).toEqual({ phase: "expired" });
    expect(expiryPhase(T - 1, T)).toEqual({ phase: "expired" });
  });

  it("warns at least 2 minutes ahead (SC 2.2.1)", () => {
    expect(WARN_BEFORE_MS).toBeGreaterThanOrEqual(2 * 60 * 1000);
  });

  it("rounds minutes left up, so time remaining is never called 0", () => {
    expect(minutesLeft(T + 1, T)).toBe(1);
    expect(minutesLeft(T + 4 * 60000 + 1, T)).toBe(5);
    expect(minutesLeft(T - 5, T)).toBe(0);
  });

  describe("SessionController", () => {
    let now = T;
    beforeEach(() => {
      vi.useFakeTimers();
      now = T;
    });
    afterEach(() => vi.useRealTimers());

    const creds = (expMs: number) => ({ accessKeyId: "a", secretAccessKey: "b", sessionToken: "c", expiration: new Date(expMs) });
    const make = () => new SessionController("us-east-1", { resolveAccount: async () => "123456789012", now: () => now });

    it("resolves the account through the injected resolver, never STS", async () => {
      const s = make();
      await s.adopt(creds(T + 3600_000));
      expect(s.signedIn).toBe(true);
      expect(s.accountId).toBe("123456789012");
    });

    it("stays signed out when the account lookup fails", async () => {
      const s = new SessionController("us-east-1", { resolveAccount: async () => { throw new Error("denied"); } });
      await expect(s.adopt(creds(T + 3600_000))).rejects.toThrow("denied");
      expect(s.signedIn).toBe(false);
    });

    it("warns with the minutes left, then expires", async () => {
      const s = make();
      const events: ExpiryEvent[] = [];
      s.onExpiry((e) => events.push(e));
      await s.adopt(creds(T + WARN_BEFORE_MS + 60_000));
      expect(events).toEqual([]);
      now += 60_000;
      vi.advanceTimersByTime(60_000);
      expect(events.map((e) => [e.state, e.minutesLeft])).toEqual([["warning", 5]]);
      now += WARN_BEFORE_MS;
      vi.advanceTimersByTime(WARN_BEFORE_MS);
      expect(events.map((e) => [e.state, e.minutesLeft])).toEqual([["warning", 5], ["expired", 0]]);
    });

    it("emits expired, not warning, for credentials that are already expired (legacy bug)", async () => {
      const s = make();
      const states: string[] = [];
      s.onExpiry((e) => states.push(e.state));
      await s.adopt(creds(T - 1000));
      expect(states).toEqual(["expired"]);
    });

    it("clear() drops credentials, timers and tells listeners", async () => {
      const s = make();
      const signIn: boolean[] = [];
      const states: string[] = [];
      s.onSignInChange((v) => signIn.push(v));
      s.onExpiry((e) => states.push(e.state));
      await s.adopt(creds(T + WARN_BEFORE_MS + 1000));
      s.clear();
      vi.advanceTimersByTime(WARN_BEFORE_MS * 2);
      expect(s.getCreds()).toBeNull();
      expect(signIn).toEqual([true, false]);
      expect(states).toEqual([]);
    });

    it("unsubscribes", async () => {
      const s = make();
      const fn = vi.fn();
      s.onExpiry(fn)();
      await s.adopt(creds(T - 1));
      expect(fn).not.toHaveBeenCalled();
    });
  });
});

describe("hashstate", () => {
  beforeEach(() => {
    location.hash = "#/types";
  });

  it("reads params and paths", () => {
    expect(readHashParams("#/types?q=gpu+h100&days=90").get("q")).toBe("gpu h100");
    expect(readHashParam("q", "#/types")).toBeNull();
    expect(hashPath("#/instances/i-1?x=1")).toBe("/instances/i-1");
    expect(hashPath("")).toBe("/");
    expect(hashPath("#")).toBe("/");
  });

  it("merges, removes empty values and keeps the path", () => {
    writeHashParams({ q: "gpu", days: "90" });
    writeHashParams({ q: "" });
    expect(readHashParam("q")).toBeNull();
    expect(readHashParam("days")).toBe("90");
    expect(location.hash.split("?")[0]).toBe("#/types");
  });

  it("replaces history instead of pushing", () => {
    const before = history.length;
    writeHashParams({ q: "a" });
    writeHashParams({ q: "ab" });
    expect(history.length).toBe(before);
  });

  it("writes onto a bare route as #/", () => {
    location.hash = "";
    writeHashParams({ q: "gpu" });
    expect(location.hash).toBe("#/?q=gpu");
  });
});

describe("config", () => {
  const env = { VITE_AWS_REGION: "us-west-2", VITE_GLOBUS_CLIENT_ID: "cid", VITE_ROLE_ARN: "arn:aws:iam::111122223333:role/r" };
  const pageUrl = "https://spore.host/app/";

  it("layers defaults, storage and URL, and persists the result (overrides allowed)", () => {
    const store = fakeStorage({ [SS_CONFIG]: JSON.stringify({ region: "eu-west-1" }) });
    const cfg = resolveConfig({ env, search: "?client_id=override", pageUrl, store, allowIdentityOverrides: true });
    expect(cfg).toEqual({ region: "eu-west-1", apiBase: "https://api.spore.host", globusClientId: "override", roleArn: env.VITE_ROLE_ARN, redirectUri: pageUrl });
    expect(JSON.parse(store.map.get(SS_CONFIG)!)).toEqual(cfg);
  });

  // #704: a phishing link to the real page must not choose the Globus app or
  // the AWS role, and nothing a link or an earlier build stored may either.
  it("never takes client_id or role_arn from the URL or storage by default", () => {
    const attacker = { client_id: "attacker-app", role_arn: "arn:aws:iam::444455556666:role/x" };
    const store = fakeStorage({ [SS_CONFIG]: JSON.stringify({ globusClientId: "stored-app", roleArn: "arn:aws:iam::777788889999:role/y" }) });
    const cfg = resolveConfig({ env, search: `?${new URLSearchParams(attacker)}&region=eu-west-1`, pageUrl, store });
    expect(cfg.globusClientId).toBe(env.VITE_GLOBUS_CLIENT_ID);
    expect(cfg.roleArn).toBe(env.VITE_ROLE_ARN);
    expect(cfg.region).toBe("eu-west-1");
    // What is persisted is the build's identity, so a later visit can't inherit an override.
    expect(JSON.parse(store.map.get(SS_CONFIG)!)).toMatchObject({ globusClientId: "cid", roleArn: env.VITE_ROLE_ARN });
  });

  it("allows identity overrides only in dev or a build that opts in", () => {
    expect(identityOverridesAllowed({})).toBe(false);
    expect(identityOverridesAllowed({ DEV: false, VITE_PORTAL_CONFIG_OVERRIDES: "" })).toBe(false);
    expect(identityOverridesAllowed({ DEV: false, VITE_PORTAL_CONFIG_OVERRIDES: "true" })).toBe(false);
    expect(identityOverridesAllowed({ DEV: true })).toBe(true);
    expect(identityOverridesAllowed({ VITE_PORTAL_CONFIG_OVERRIDES: "1" })).toBe(true);
  });

  it("never takes apiBase or redirectUri from the URL", () => {
    const cfg = resolveConfig({ env, search: "?apiBase=https://evil.example&redirect_uri=https://evil.example", pageUrl, store: null });
    expect(cfg.apiBase).toBe("https://api.spore.host");
    expect(cfg.redirectUri).toBe(pageUrl);
  });

  it("survives corrupt stored config", () => {
    const cfg = resolveConfig({ env, search: "", pageUrl, store: fakeStorage({ [SS_CONFIG]: "{not json" }) });
    expect(cfg.region).toBe("us-west-2");
  });

  it("names missing build variables for the console", () => {
    expect(missingConfig(resolveConfig({ env: {}, search: "", pageUrl, store: null }))).toEqual(["VITE_GLOBUS_CLIENT_ID", "VITE_ROLE_ARN"]);
    expect(missingConfig(resolveConfig({ env, search: "", pageUrl, store: null }))).toEqual([]);
  });
});

describe("cost (ported from guided/cost.ts)", () => {
  it("sits above the time-limit total, not on it", () => {
    const limit = costLimitFor(0.5, 4)!;
    expect(limit).toBeGreaterThan(2);
    expect(limit).toBe(Math.ceil(0.5 * 4 * COST_LIMIT_HEADROOM));
  });

  it("rounds up to whole dollars and never to zero", () => {
    expect(costLimitFor(0.1344, 4)).toBe(1);
    expect(costLimitFor(0.0042, 1)).toBe(1);
    expect(Number.isInteger(costLimitFor(2.83, 4)!)).toBe(true);
  });

  it("is undefined, never 0, for an unknown or non-positive price or time", () => {
    expect(costLimitFor(undefined, 4)).toBeUndefined();
    expect(costLimitFor(0, 4)).toBeUndefined();
    expect(costLimitFor(-1, 4)).toBeUndefined();
    expect(costLimitFor(0.5, 0)).toBeUndefined();
  });

  it("states the maximum: rate times time, capped by a lower spending limit", () => {
    expect(maxCostFor(0.3, 2)).toBeCloseTo(0.6);
    expect(maxCostFor(10, 2, 5)).toBe(5);
    expect(maxCostFor(0.3, 2, 100)).toBeCloseTo(0.6);
    expect(maxCostFor(undefined, 2)).toBeUndefined();
  });
});

describe("format", () => {
  it("formats money with Intl, 2 decimals and separators", () => {
    expect(formatMoney(2106)).toBe("$2,106.00");
    expect(formatMoney(0.6)).toBe("$0.60");
    expect(formatMoney(0.0042, { fine: true })).toBe("$0.0042");
    expect(formatRate(0.4)).toBe("$0.40 an hour");
    expect(() => formatMoney(Number.NaN)).toThrow();
  });

  it("formats durations, clock times and ages", () => {
    expect(formatDuration((5 * 60 + 29) * 60000 + 30_000)).toBe("5 h 29 min");
    expect(formatDuration(2 * 3600000)).toBe("2 h");
    expect(formatDuration(45 * 60000)).toBe("45 min");
    expect(formatDuration(10_000)).toBe("under 1 min");
    expect(formatClock(new Date(Date.UTC(2026, 0, 1, 16, 15)), "UTC")).toBe("4:15 pm");
    expect(formatAgo(12_000)).toBe("12 s ago");
    expect(formatAgo(3 * 60000)).toBe("3 min ago");
  });

  it("shows an account by its last four digits only", () => {
    expect(accountLabel("123456789012")).toBe("AWS account ending 9012");
    expect(() => accountLabel("12345")).toThrow();
  });

  it("pluralises", () => {
    expect(plural(1, "minute")).toBe("1 minute");
    expect(plural(4, "minute")).toBe("4 minutes");
  });
});

describe("regions", () => {
  it("names locations in words", () => {
    expect(regionName("us-east-1")).toBe("US East (N. Virginia)");
    expect(regionName("xx-nowhere-9")).toBeUndefined();
  });
});
