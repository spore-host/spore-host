// Portal entry point.
//
// NOT DEPLOYED. spore.host/app/ serves web/app/index.html, a static
// placeholder, until slice 1 (#684) passes its gates. This app is built only
// into web/.portal-build/ for the CI gates, never into web/dist/ (see
// portal/vite.config.ts and scripts/portal-not-deployed.test.mjs).
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/layout.css";
import { missingConfig, resolveConfig } from "./lib/config.js";
import { SessionController, type SessionOptions } from "./lib/session.js";
import { announce } from "./shell/announce.js";
import { createShell } from "./shell/shell.js";

async function main(): Promise<void> {
  const config = resolveConfig({
    env: import.meta.env,
    search: location.search,
    pageUrl: `${location.origin}${location.pathname}`,
    store: sessionStorage,
  });
  const missing = missingConfig(config);
  // Build variables are for the operator, never the page (#681).
  if (missing.length) console.warn(`spore.host portal: unset build variables: ${missing.join(", ")}`);

  // The gate build (vite --mode gate) compiles in test hooks that fake a
  // signed-in session with no AWS call. In every other build this condition is
  // the literal `false`, so the hooks module is not bundled at all.
  const hooks = import.meta.env.VITE_PORTAL_TEST_HOOKS === "1" ? await import("./testhooks.js") : null;
  const sessionOpts: SessionOptions = hooks ? hooks.sessionOptions() : {};
  const session = new SessionController(config.region, sessionOpts);

  const shell = createShell({
    session,
    // Slice 1 (#684) replaces this with popup re-auth that keeps page state.
    reauth: () => announce("Signing in again isn't available yet.", { assertive: true }),
  });
  shell.start();
  if (hooks) await hooks.applyState(session, shell);
}

void main();
