// Sign-in: Globus Auth (institutional identity) then STS
// AssumeRoleWithWebIdentity. The protocol lives in @spore-host/spawn-ts/auth;
// this module wires it to the portal's config and session.
//
// Ported from legacy-app/auth/globus-login.ts (brief §9 reuse table) with the
// behaviour unchanged. Slice 1 (#684) adds the in-page failure causes (#682)
// and popup re-auth. Phase 0 does not call it from the shell.
import {
  beginLogin,
  completeLogin,
  credsFromIdToken,
  hasAuthCode,
  type GlobusConfig,
} from "@spore-host/spawn-ts/auth";
import type { PortalConfig } from "./config.js";
import type { SessionController } from "./session.js";

/** The STS role-session name every portal sign-in uses, so CloudTrail shows where a call came from. */
export const ROLE_SESSION_NAME = "spore-portal";

export function globusConfig(cfg: PortalConfig): GlobusConfig {
  return {
    clientId: cfg.globusClientId,
    redirectUri: cfg.redirectUri,
    // Show the institution picker so users land on their own sign-in page.
    forcePrompt: true,
  };
}

/** Start the OAuth redirect (PKCE S256). Does not return in practice. */
export async function startSignIn(cfg: PortalConfig): Promise<void> {
  await beginLogin(globusConfig(cfg));
}

/** True when the page has just been redirected back with an authorization code. */
export function isAuthReturn(): boolean {
  return hasAuthCode();
}

/** Finish the redirect: exchange the code, federate into AWS, adopt the credentials. Returns the account id. */
export async function finishSignIn(cfg: PortalConfig, session: SessionController): Promise<string | null> {
  const { idToken } = await completeLogin(globusConfig(cfg));
  const creds = await credsFromIdToken(idToken, {
    roleArn: cfg.roleArn,
    region: cfg.region,
    sessionName: ROLE_SESSION_NAME,
  });
  await session.adopt(creds);
  return session.accountId;
}
