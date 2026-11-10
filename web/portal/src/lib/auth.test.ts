// The sign-in wiring (ported from legacy-app/auth/globus-login.ts). spawn-ts's
// auth module is mocked: no redirect, no token exchange, no STS call.
import { describe, expect, it, vi } from "vitest";

vi.mock("@spore-host/spawn-ts/auth", () => ({
  beginLogin: vi.fn(async () => "https://auth.example/authorize"),
  hasAuthCode: vi.fn(() => true),
  completeLogin: vi.fn(async () => ({ idToken: "id-token", claims: {} })),
  credsFromIdToken: vi.fn(async () => ({ accessKeyId: "a", secretAccessKey: "b", sessionToken: "c", expiration: new Date(Date.now() + 3600_000) })),
}));

const spawnAuth = await import("@spore-host/spawn-ts/auth");
const { finishSignIn, globusConfig, isAuthReturn, ROLE_SESSION_NAME, startSignIn } = await import("./auth.js");
const { SessionController } = await import("./session.js");

const cfg = { region: "us-east-1", apiBase: "https://api.spore.host", globusClientId: "cid", roleArn: "arn:aws:iam::111122223333:role/r", redirectUri: "https://spore.host/app/" };

describe("auth", () => {
  it("asks Globus for the institution picker with this page as the redirect", () => {
    expect(globusConfig(cfg)).toEqual({ clientId: "cid", redirectUri: "https://spore.host/app/", forcePrompt: true });
  });

  it("starts sign-in with that config", async () => {
    await startSignIn(cfg);
    expect(spawnAuth.beginLogin).toHaveBeenCalledWith(globusConfig(cfg));
  });

  it("detects the redirect back", () => {
    expect(isAuthReturn()).toBe(true);
  });

  it("finishes sign-in: exchanges the code, federates with the configured role and adopts the credentials", async () => {
    const session = new SessionController("us-east-1", { resolveAccount: async () => "123456789012" });
    const account = await finishSignIn(cfg, session);
    expect(spawnAuth.credsFromIdToken).toHaveBeenCalledWith("id-token", { roleArn: cfg.roleArn, region: "us-east-1", sessionName: ROLE_SESSION_NAME });
    expect(account).toBe("123456789012");
    expect(session.signedIn).toBe(true);
  });
});
