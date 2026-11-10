// Portal configuration: Vite build-time values, overridable per visit by URL
// params, persisted in sessionStorage so they survive the sign-in redirect
// (which replaces the query string).
//
// Ported from legacy-app/config.ts (brief §9 reuse table). Changes:
// - Pure: env, URL, origin and storage are parameters, so it is testable
//   without a window.
// - The onboarding/phone-home block is gone. Account setup is CLI-only
//   (`spawn onboard`, #645), and the terminal's config returns with slice 4.
// - `missingConfig()` names unset build variables for the CONSOLE only. Users
//   see "This site isn't finished being set up" (brief §4 Flow E, #681);
//   VITE_* names never reach the page.

export interface PortalConfig {
  region: string;
  apiBase: string;
  globusClientId: string;
  roleArn: string;
  redirectUri: string;
}

/** The VITE_* values config reads. Matches the subset of ImportMetaEnv used. */
export interface ConfigEnv {
  VITE_AWS_REGION?: string;
  VITE_API_BASE?: string;
  VITE_GLOBUS_CLIENT_ID?: string;
  VITE_ROLE_ARN?: string;
  VITE_REDIRECT_URI?: string;
}

export const SS_CONFIG = "spore.portal.config";

type SessionStore = Pick<Storage, "getItem" | "setItem">;

export interface ResolveInput {
  env: ConfigEnv;
  /** `location.search`. */
  search: string;
  /** `location.origin + location.pathname`: the default redirect URI. */
  pageUrl: string;
  store: SessionStore | null;
}

export function defaults(env: ConfigEnv, pageUrl: string): PortalConfig {
  return {
    region: env.VITE_AWS_REGION || "us-east-1",
    apiBase: env.VITE_API_BASE || "https://api.spore.host",
    globusClientId: env.VITE_GLOBUS_CLIENT_ID || "",
    roleArn: env.VITE_ROLE_ARN || "",
    redirectUri: env.VITE_REDIRECT_URI || pageUrl,
  };
}

function readStored(store: SessionStore | null): Partial<PortalConfig> | null {
  try {
    const raw = store?.getItem(SS_CONFIG);
    return raw ? (JSON.parse(raw) as Partial<PortalConfig>) : null;
  } catch {
    return null;
  }
}

/**
 * Build-time defaults, then stored values, then URL overrides, persisted.
 * apiBase and redirectUri are never taken from the URL: a link must not be
 * able to send credentials elsewhere or redirect sign-in off this page.
 */
export function resolveConfig({ env, search, pageUrl, store }: ResolveInput): PortalConfig {
  const base = defaults(env, pageUrl);
  const stored = readStored(store);
  const params = new URLSearchParams(search);
  const merged: PortalConfig = {
    region: params.get("region") ?? stored?.region ?? base.region,
    apiBase: base.apiBase,
    globusClientId: params.get("client_id") ?? stored?.globusClientId ?? base.globusClientId,
    roleArn: params.get("role_arn") ?? stored?.roleArn ?? base.roleArn,
    redirectUri: base.redirectUri,
  };
  try {
    store?.setItem(SS_CONFIG, JSON.stringify(merged));
  } catch {
    // Unpersisted config only matters across the sign-in redirect; slice 1 handles that failure.
  }
  return merged;
}

/** Build variables that sign-in needs and that are unset. For console.warn only, never the page. */
export function missingConfig(cfg: PortalConfig): string[] {
  const missing: string[] = [];
  if (!cfg.globusClientId) missing.push("VITE_GLOBUS_CLIENT_ID");
  if (!cfg.roleArn) missing.push("VITE_ROLE_ARN");
  return missing;
}
