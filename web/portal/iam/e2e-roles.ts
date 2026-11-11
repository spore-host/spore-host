// The real-AWS e2e roles' checked-in documents (iam/policies/portal-e2e-roles.json),
// for the gates and the live drift job.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PolicyDoc, PolicyFile, TrustDoc } from "./simulate.js";

export interface E2ERoles {
  roles: Record<string, { trust: TrustDoc; inlinePoliciesFrom?: string; policies?: Record<string, PolicyDoc> }>;
}

export const TEARDOWN_ROLE = "spore-portal-e2e-teardown";

export function loadE2ERoles(): E2ERoles {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "policies/portal-e2e-roles.json"), "utf8")) as E2ERoles;
}

/** The teardown role's own policies, in the shape the fixture runner takes. */
export function teardownPolicyFile(roles: E2ERoles = loadE2ERoles()): PolicyFile {
  const policies = roles.roles[TEARDOWN_ROLE]?.policies;
  if (!policies) throw new Error(`portal-e2e-roles.json has no policies for ${TEARDOWN_ROLE}`);
  return { role: TEARDOWN_ROLE, policies };
}
