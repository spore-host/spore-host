// Build-time feature flags. Each is read from a Vite env var when the bundle is
// built, and is OFF unless the build sets it to exactly "true". The committed
// .env.production sets none of them, so the deployed portal ships with every
// flag off.

/** The env shape the flags read: Vite's import.meta.env, or a test's stand-in. */
export type FlagEnv = Record<string, string | boolean | undefined>;

/**
 * Chat-platform integrations (the Slack surface; spore-bot). Walled off for 1.0
 * (spore-host#611): the hosted spore-bot is decommissioned and the setup is not
 * part of the supported product. The code stays so it can return after 1.0;
 * build with VITE_EXPERIMENTAL_CHAT=true to show it.
 */
export function experimentalChat(env: FlagEnv = import.meta.env): boolean {
  return env.VITE_EXPERIMENTAL_CHAT === "true";
}
