// Real-AWS e2e harness (spore-host#683): the fixed parameters of a run.
//
// Everything here is a constant on purpose. A run launches at most two
// t4g.nano On-Demand instances in us-east-1 with a 15-minute TTL, in the dev
// account only. Changing any of these is a code change, reviewed, not an
// environment variable someone sets in a hurry.

/** The only account the harness will touch. Overridable for a fork, never at random. */
export const EXPECTED_ACCOUNT = process.env.PORTAL_E2E_ACCOUNT_ID ?? "435415984226";
export const REGION = "us-east-1";
export const INSTANCE_TYPE = "t4g.nano";
/** Hard cap per run: one spawn-managed instance and one otherwise-identical control. */
export const MAX_INSTANCES = 2;
/** spawn:ttl on every instance. spored and the reaper are the backstop if teardown never runs. */
export const TTL = "15m";
export const TTL_MS = 15 * 60_000;
/** The portal's instance profile (legacy-app/surfaces/instances.ts), so iam:PassRole is the portal's. */
export const INSTANCE_PROFILE = "spored-instance-profile";

/** Every resource a run creates carries this tag, valued with the run id. */
export const RUN_TAG = "spore-host:e2e-run";
/** Which of the two instances this is: "managed" (spawn:managed=true) or "control" (no spawn:managed). */
export const ROLE_TAG = "spore-host:e2e-instance";

export const E2E_ROLE_NAME = "spore-portal-e2e";
export const TEARDOWN_ROLE_NAME = "spore-portal-e2e-teardown";
/** The e2e role's trust requires sts:RoleSessionName to start with this, so its sessions are attributable. */
export const SESSION_PREFIX = "spore-e2e-";

/** EC2 states that bill or can bill again. A run leaves none of these behind. */
export const LIVE_STATES = ["pending", "running", "stopping", "stopped"] as const;

/** Waits. Generous: a slow boot must fail as a timeout, not as a wrong answer. */
export const WAIT = {
  running: 5 * 60_000,
  ssmOnline: 8 * 60_000,
  terminated: 6 * 60_000,
  leakSettle: 3 * 60_000,
  poll: 10_000,
} as const;
