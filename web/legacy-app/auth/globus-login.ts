// Portal sign-in: Globus Auth (institutional identity via CILogon/InCommon) →
// AWS STS AssumeRoleWithWebIdentity. This replaces the old Cognito Identity Pool.
// The heavy lifting lives in @spore-host/spawn-ts/auth (proven end-to-end); this
// module just wires it to the portal's config + SessionController.
import {
  beginLogin,
  hasAuthCode,
  completeLogin,
  credsFromIdToken,
  type GlobusConfig,
} from "@spore-host/spawn-ts/auth";
import type { PortalConfig } from "../surfaces/types.js";
import type { SessionController } from "../session.js";

function globusConfig(cfg: PortalConfig): GlobusConfig {
  return {
    clientId: cfg.globusClientId,
    redirectUri: cfg.redirectUri,
    // Show the institution picker so users land on their university IdP.
    forcePrompt: true,
  };
}

/** Kick off the OAuth redirect (PKCE S256). Does not return in practice. */
export async function startSignIn(cfg: PortalConfig): Promise<void> {
  await beginLogin(globusConfig(cfg));
}

/** True when we've just been redirected back with an authorization code. */
export function isAuthReturn(): boolean {
  return hasAuthCode();
}

/**
 * Complete the redirect-back: exchange the code, federate into AWS, and adopt
 * the creds into the session (which resolves the account + arms expiry).
 * Returns the resolved account id.
 */
export async function finishSignIn(
  cfg: PortalConfig,
  session: SessionController,
): Promise<string | null> {
  const { idToken } = await completeLogin(globusConfig(cfg));
  const creds = await credsFromIdToken(idToken, {
    roleArn: cfg.roleArn,
    region: cfg.region,
    sessionName: "spore-portal",
  });
  await session.adopt(creds);
  return session.accountId;
}
