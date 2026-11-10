// The signed-in user's AWS credentials (in memory only, never storage), the
// account they resolve to, and the expiry logic that warns before they lapse.
//
// Ported from legacy-app/session.ts (brief §9 reuse table). Changes:
// - The disclosure level no longer lives here; see disclosure.ts.
// - The expiry decision is a pure function, `expiryPhase()`, so it can be
//   tested without timers.
// - Fixed: credentials that were ALREADY expired when adopted emitted
//   "warning" and never "expired". They now emit "expired".
// - The warning carries the minutes left (SC 2.2.1: say how long, at least
//   2 minutes ahead), and the window is 5 minutes, so there is time to act.
// - The account lookup is injectable, so tests and the gate build never
//   construct an STS client call.
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

/** The shape @spore-host/spawn-ts/auth returns from credsFromIdToken. */
export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

export type ExpiryState = "warning" | "expired";

export interface ExpiryEvent {
  state: ExpiryState;
  /** Whole minutes until expiry, rounded up. 0 once expired. */
  minutesLeft: number;
  expiresAt: Date;
}

export type ExpiryListener = (e: ExpiryEvent) => void;

/** Warn this long before expiry. SC 2.2.1 needs at least 2 minutes; 5 leaves time to finish a form. */
export const WARN_BEFORE_MS = 5 * 60 * 1000;

export type Phase = { phase: "ok"; msUntilWarning: number } | { phase: "warning"; msUntilExpiry: number } | { phase: "expired" };

/** Where credentials expiring at `expiresAt` stand at `now`. Pure. */
export function expiryPhase(expiresAt: number, now: number, warnBeforeMs = WARN_BEFORE_MS): Phase {
  const left = expiresAt - now;
  if (left <= 0) return { phase: "expired" };
  if (left <= warnBeforeMs) return { phase: "warning", msUntilExpiry: left };
  return { phase: "ok", msUntilWarning: left - warnBeforeMs };
}

/** Minutes left, rounded up, so "1 minute" is said while any time remains. */
export function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60000));
}

/** Resolves the account id for a set of credentials. The default asks STS. */
export type AccountResolver = (creds: AwsCreds, region: string) => Promise<string | null>;

export const stsAccountResolver: AccountResolver = async (creds, region) => {
  const sts = new STSClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
  const who = await sts.send(new GetCallerIdentityCommand({}));
  return who.Account ?? null;
};

export interface SessionOptions {
  resolveAccount?: AccountResolver;
  /** Injected clock, for tests. */
  now?: () => number;
}

export class SessionController {
  private creds: AwsCreds | null = null;
  private _accountId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<ExpiryListener>();
  private signInListeners = new Set<(signedIn: boolean) => void>();
  private readonly resolveAccount: AccountResolver;
  private readonly now: () => number;

  constructor(
    readonly region: string,
    opts: SessionOptions = {},
  ) {
    this.resolveAccount = opts.resolveAccount ?? stsAccountResolver;
    this.now = opts.now ?? (() => Date.now());
  }

  get accountId(): string | null {
    return this._accountId;
  }

  get signedIn(): boolean {
    return this.creds !== null;
  }

  /** The live credentials, or null when signed out. */
  getCreds(): AwsCreds | null {
    return this.creds;
  }

  /**
   * Adopt freshly federated credentials, resolve the account, and arm expiry.
   * Throws if the account lookup fails; the session stays signed out then.
   */
  async adopt(creds: AwsCreds): Promise<void> {
    const account = await this.resolveAccount(creds, this.region);
    this.creds = creds;
    this._accountId = account;
    this.arm();
    for (const fn of this.signInListeners) fn(true);
  }

  /** Drop credentials and timers (sign out). */
  clear(): void {
    const was = this.signedIn;
    this.creds = null;
    this._accountId = null;
    this.disarm();
    if (was) for (const fn of this.signInListeners) fn(false);
  }

  /** Subscribe to warning/expired transitions. Returns an unsubscribe function. */
  onExpiry(fn: ExpiryListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribe to sign-in and sign-out. Returns an unsubscribe function. */
  onSignInChange(fn: (signedIn: boolean) => void): () => void {
    this.signInListeners.add(fn);
    return () => this.signInListeners.delete(fn);
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.disarm();
    const exp = this.creds?.expiration?.getTime();
    if (exp === undefined) return;
    const p = expiryPhase(exp, this.now());
    if (p.phase === "ok") {
      this.timer = setTimeout(() => this.arm(), p.msUntilWarning);
      return;
    }
    if (p.phase === "warning") {
      this.emit("warning", exp);
      this.timer = setTimeout(() => this.arm(), p.msUntilExpiry);
      return;
    }
    this.emit("expired", exp);
  }

  private emit(state: ExpiryState, exp: number): void {
    const e: ExpiryEvent = {
      state,
      minutesLeft: state === "expired" ? 0 : minutesLeft(exp, this.now()),
      expiresAt: new Date(exp),
    };
    for (const fn of this.listeners) fn(e);
  }
}
