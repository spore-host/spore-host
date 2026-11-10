// The portal's session: the signed-in user's AWS credentials (in memory only —
// never localStorage), the account they resolve to, an expiry timer that
// warns/tears-down before the STS creds lapse, and the disclosure level.
// Surfaces subscribe via onExpiry.
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AwsCreds } from "@spore-host/spawn-ts/auth";
import { type DisclosureLevel, loadLevel, saveLevel } from "./disclosure.js";

/** Fires when creds are within the warn window or already expired. */
export type ExpiryListener = (state: "warning" | "expired") => void;

/** Fires when the disclosure level changes, so the shell can re-render. */
export type LevelListener = (level: DisclosureLevel) => void;

// Re-auth this long before the hard expiration so an in-flight action doesn't
// die mid-request.
const WARN_BEFORE_MS = 5 * 60 * 1000;

export class SessionController {
  private creds: AwsCreds | null = null;
  private _accountId: string | null = null;
  private _region: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expiryListeners = new Set<ExpiryListener>();
  private levelListeners = new Set<LevelListener>();
  // Read once at construction, not per-access: localStorage is synchronous and
  // every surface render asks for the level.
  private _level: DisclosureLevel;

  /**
   * `storage` is injected so the level's persistence is testable without a DOM
   * shim's localStorage (happy-dom doesn't provide one) — and so a caller can pass
   * null to opt out entirely. Defaults to `undefined`, which means "use
   * localStorage if it exists", the browser path.
   */
  constructor(region: string, private storage?: Pick<Storage, "getItem" | "setItem"> | null) {
    this._region = region;
    this._level = storage === undefined ? loadLevel() : loadLevel(storage);
  }

  get region(): string {
    return this._region;
  }

  /**
   * How much of the portal to reveal. Lives here rather than on the Shell because
   * it must survive a sign-out — an experienced user who signs out and back in
   * should not be dropped into guided mode.
   */
  get level(): DisclosureLevel {
    return this._level;
  }

  /** Set + persist the level and notify listeners. A no-op change stays silent. */
  setLevel(level: DisclosureLevel): void {
    if (level === this._level) return;
    this._level = level;
    if (this.storage === undefined) saveLevel(level);
    else saveLevel(level, this.storage);
    for (const fn of this.levelListeners) fn(level);
  }

  /** Subscribe to level changes; returns an unsubscribe fn. */
  onLevelChange(fn: LevelListener): () => void {
    this.levelListeners.add(fn);
    return () => this.levelListeners.delete(fn);
  }

  get accountId(): string | null {
    return this._accountId;
  }

  get signedIn(): boolean {
    return this.creds !== null;
  }

  /** The live credentials, or null if not signed in. */
  getCreds(): AwsCreds | null {
    return this.creds;
  }

  /**
   * Adopt freshly federated credentials, resolve the account via STS, and arm
   * the expiry timer. Throws if GetCallerIdentity fails (bad creds/region).
   */
  async adopt(creds: AwsCreds): Promise<void> {
    const sts = new STSClient({
      region: this._region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
    const who = await sts.send(new GetCallerIdentityCommand({}));
    this.creds = creds;
    this._accountId = who.Account ?? null;
    this.armExpiry();
  }

  /** Drop creds + timers (sign-out). */
  clear(): void {
    this.creds = null;
    this._accountId = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Subscribe to expiry transitions; returns an unsubscribe fn. */
  onExpiry(fn: ExpiryListener): () => void {
    this.expiryListeners.add(fn);
    return () => this.expiryListeners.delete(fn);
  }

  private armExpiry(): void {
    if (this.timer) clearTimeout(this.timer);
    const exp = this.creds?.expiration?.getTime();
    if (!exp) return; // no expiration → nothing to arm
    const now = performance.timeOrigin + performance.now();
    const warnAt = exp - WARN_BEFORE_MS - now;
    if (warnAt <= 0) {
      this.emit("warning");
      return;
    }
    this.timer = setTimeout(() => {
      this.emit("warning");
      const hardAt = exp - (performance.timeOrigin + performance.now());
      this.timer = setTimeout(() => this.emit("expired"), Math.max(0, hardAt));
    }, warnAt);
  }

  private emit(state: "warning" | "expired"): void {
    for (const fn of this.expiryListeners) fn(state);
  }
}
