// Test hooks for the gate build ONLY (vite --mode gate, VITE_PORTAL_TEST_HOOKS=1).
//
// The gates need the signed-in shell, the account menu and both expiry states,
// and Phase 0 has no sign-in. These hooks fake them from the page URL with
// made-up credentials and NO AWS call: the account resolver is replaced, so no
// STS client is ever sent a request.
//
//   ?state=signed-in              signed in as account 123456789012
//   &account=210987654321         a different account
//   &expiry=warning|expired       credentials 4 minutes from expiry, or expired
//
// main.ts imports this module only behind a build-time constant, so a
// production build does not contain it (checked by
// portal/gates/iam-inventory.test.ts, which builds the production bundle).
import type { SessionController, SessionOptions } from "./lib/session.js";
import type { Shell } from "./shell/shell.js";

export const TEST_HOOKS_MARKER = "spore-portal-test-hooks";

function params(): URLSearchParams {
  return new URLSearchParams(location.search);
}

export function sessionOptions(): SessionOptions {
  const account = params().get("account") ?? "123456789012";
  return { resolveAccount: async () => account };
}

export async function applyState(session: SessionController, shell: Shell): Promise<void> {
  document.documentElement.dataset.testHooks = TEST_HOOKS_MARKER;
  const p = params();
  if (p.get("state") !== "signed-in") return;
  const expiry = p.get("expiry");
  const now = Date.now();
  const expiration = new Date(expiry === "expired" ? now - 1000 : expiry === "warning" ? now + 3.5 * 60 * 1000 : now + 60 * 60 * 1000);
  await session.adopt({ accessKeyId: "TESTHOOK", secretAccessKey: "TESTHOOK", sessionToken: "TESTHOOK", expiration });
  shell.refresh();
}
