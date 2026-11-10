// Portal entry point. Resolves config, handles the Globus OAuth redirect-back if
// present (exchange code → federate → adopt session), then boots the shell.
import "../css/style.css";
import { resolveConfig } from "./config.js";
import { SessionController } from "./session.js";
import { Shell } from "./shell.js";
import { isAuthReturn, finishSignIn } from "./auth/globus-login.js";

async function boot(): Promise<void> {
  const config = resolveConfig();
  const session = new SessionController(config.region);

  // If we were just redirected back from Globus, complete sign-in before the
  // shell renders so the user lands already-authenticated.
  if (isAuthReturn()) {
    try {
      await finishSignIn(config, session);
    } catch (err) {
      console.error("sign-in failed", err);
    }
    // Strip the OAuth query string; keep any hash route.
    history.replaceState(null, "", window.location.pathname + window.location.hash);
  }

  const root = document.getElementById("portal-root");
  if (!root) throw new Error("missing #portal-root");
  new Shell(root, session, config).start();
}

void boot();
