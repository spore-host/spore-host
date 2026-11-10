// Portal config: Vite build-time defaults, overridable per-visit via URL params
// (persisted in sessionStorage so they survive the Globus OAuth round-trip, which
// replaces the query string on redirect-back).
import type { PortalConfig } from "./surfaces/types.js";

const SS_CONFIG = "portal.config";

// Build-time defaults. import.meta.env values come from Vite (.env / define);
// the fallbacks keep dev working before infra is wired.
const DEFAULTS: PortalConfig = {
  region: import.meta.env.VITE_AWS_REGION ?? "us-east-1",
  apiBase: import.meta.env.VITE_API_BASE ?? "https://api.spore.host",
  globusClientId: import.meta.env.VITE_GLOBUS_CLIENT_ID ?? "",
  roleArn: import.meta.env.VITE_ROLE_ARN ?? "",
  redirectUri: import.meta.env.VITE_REDIRECT_URI ?? defaultRedirectUri(),
  onboarding: {
    // The onboarding template deploys alongside the portal (copy-static →
    // dist/cloudformation/); default to its served URL on this origin.
    templateUrl:
      import.meta.env.VITE_ONBOARD_TEMPLATE_URL ??
      `${window.location.origin}/cloudformation/portal-onboarding-role.yaml`,
    phoneHomeRoleArn: import.meta.env.VITE_PHONE_HOME_ROLE_ARN ?? "",
    phoneHomeUrl: import.meta.env.VITE_PHONE_HOME_URL ?? "",
  },
};

function defaultRedirectUri(): string {
  // The portal SPA's own URL, sans query/hash.
  return `${window.location.origin}${window.location.pathname}`;
}

/**
 * Resolve config: start from build-time defaults, layer any URL overrides, and
 * persist the merged result so a later completeLogin() (after the OAuth redirect
 * wiped the query string) sees the same clientId/roleArn/region.
 */
export function resolveConfig(search = window.location.search): PortalConfig {
  const stored = readStored();
  const params = new URLSearchParams(search);
  const merged: PortalConfig = {
    region: params.get("region") ?? stored?.region ?? DEFAULTS.region,
    // apiBase is build-time only (not overridable per-visit).
    apiBase: stored?.apiBase ?? DEFAULTS.apiBase,
    globusClientId:
      params.get("client_id") ?? stored?.globusClientId ?? DEFAULTS.globusClientId,
    roleArn: params.get("role_arn") ?? stored?.roleArn ?? DEFAULTS.roleArn,
    // redirectUri is always this page — never take it from the URL.
    redirectUri: DEFAULTS.redirectUri,
    // Onboarding config isn't overridable per-visit (build-time only).
    onboarding: DEFAULTS.onboarding,
  };
  sessionStorage.setItem(SS_CONFIG, JSON.stringify(merged));
  return merged;
}

function readStored(): Partial<PortalConfig> | null {
  const raw = sessionStorage.getItem(SS_CONFIG);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<PortalConfig>;
  } catch {
    return null;
  }
}
