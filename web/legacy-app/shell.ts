// The portal shell: brand header, tool sidebar, sign-in gate, and the hash
// router that mounts/disposes ToolSurfaces. Tool-agnostic — it renders whatever
// registry.ts lists, so lagotto-ts et al. drop in with no shell change.
import { surfaces, findSurface } from "./surfaces/registry.js";
import type { PortalConfig, SurfaceContext, Disposable } from "./surfaces/types.js";
import type { SessionController } from "./session.js";
import { startSignIn } from "./auth/globus-login.js";
import {
  DEFAULT_LEVEL,
  isLevel,
  LEVEL_CONTROL_NAME,
  LEVEL_INFO,
  LEVELS,
  type DisclosureLevel,
} from "./disclosure.js";

export class Shell {
  private navEl!: HTMLElement;
  private mainEl!: HTMLElement;
  private bannerEl!: HTMLElement;
  private current: { id: string; disposable: Disposable } | null = null;
  // Once expiry has fired, the banner belongs to it — see showLevelNote().
  private expiryShown = false;

  constructor(
    private root: HTMLElement,
    private session: SessionController,
    private config: PortalConfig,
  ) {}

  /** Build the chrome, wire the router, and route to the initial hash. */
  start(): void {
    this.render();
    window.addEventListener("hashchange", () => void this.route());
    this.session.onExpiry((state) => this.showExpiry(state));
    // A level change re-mounts the current surface. Surfaces therefore read
    // ctx.level once at mount instead of subscribing — one update mechanism, and
    // it reuses route()'s existing dispose/mount path.
    //
    // The control is re-rendered too, not just the surface: a surface can raise the
    // level itself (guided mode's "I know what I need"), and without this the
    // header would still read "Guided" while the user was looking at the standard
    // view — the control lying about the one piece of state it exists to show.
    this.session.onLevelChange((level) => {
      this.renderLevel();
      this.announceLevel(level);
      // A surface can raise the level itself — the guided picker's "Show me all the
      // options" is the whole point of the escape hatch. But that one click writes
      // localStorage and changes every surface, forever, and the return trip means
      // finding the header control: precisely the knowledge the escape hatch existed
      // to spare them. So say what just happened and where to undo it.
      if (level !== DEFAULT_LEVEL) this.showLevelNote(level);
      else this.hideBanner();
      void this.route({ remount: true });
    });
    void this.route();
  }

  private render(): void {
    this.root.innerHTML = `
      <header class="portal-header">
        <a class="portal-brand" href="/" aria-label="spore.host home">
          <!-- A 3x-DPR derivative of spore-host-logo.png, not the master: the header
               renders it 26px tall, and shipping the 1983x793 original there would
               cost 914 KB on every page load for 65 CSS pixels of wordmark. -->
          <img class="portal-brand-img" src="../assets/brand/spore-host-logo-header.png"
               alt="spore.host" width="195" height="78">
        </a>
        <div class="portal-level"></div>
        <div class="portal-account"></div>
      </header>
      <div class="portal-banner" hidden></div>
      <!-- Announces level changes, which silently rebuild .portal-main. Outside
           .portal-main so a re-mount doesn't destroy the element mid-announcement. -->
      <div class="portal-live" role="status" aria-live="polite"></div>
      <div class="portal-body">
        <nav class="portal-nav" aria-label="Tools"></nav>
        <main class="portal-main" id="surface-host"></main>
      </div>`;
    this.navEl = this.root.querySelector(".portal-nav")!;
    this.mainEl = this.root.querySelector(".portal-main")!;
    this.bannerEl = this.root.querySelector(".portal-banner")!;
    this.renderNav();
    this.renderLevel();
    this.renderAccount();
  }

  /**
   * The one portal-wide disclosure control, in the header beside the account block.
   *
   * A single visible control is the whole state — no per-surface toggles, which
   * would leave the user unable to say what mode they were in.
   *
   * A radiogroup of three buttons, not a `<select>`. Three reasons, each a defect
   * in the `<select>` this replaced:
   *
   * 1. The LEVEL_INFO blurbs were attached as `title` on each `<option>`, and
   *    native `<option title>` is not reliably rendered anywhere — Safari never
   *    shows it, and mobile pickers show labels only. So the copy explaining what
   *    each level is FOR was written, shipped, and seen by almost nobody. It is now
   *    visible text under the control.
   * 2. A collapsed control hides the scale. These levels are ORDERED — that
   *    ordering is the entire semantics `atLeast()` depends on — and three
   *    side-by-side options show it where a dropdown showing one does not.
   * 3. "Detail" named the wrong axis: the control changes *capability* (spot, TTL,
   *    AZ, placement), not verbosity. It's "Mode" now.
   *
   * The label is a real `<span id>` referenced by aria-labelledby rather than a
   * `<label for>`, because a radiogroup is not a labelable form control.
   */
  private renderLevel(): void {
    const el = this.root.querySelector<HTMLElement>(".portal-level")!;
    const current = this.session.level;
    const buttons = LEVELS.map(
      (l) =>
        `<button type="button" class="portal-level-opt${l === current ? " active" : ""}"
                 role="radio" aria-checked="${l === current}" data-level="${l}"
                 tabindex="${l === current ? "0" : "-1"}">${escapeHtml(LEVEL_INFO[l].label)}</button>`,
    ).join("");
    el.innerHTML = `
      <span class="portal-level-label" id="portal-level-label">${escapeHtml(LEVEL_CONTROL_NAME)}</span>
      <div class="portal-level-group" role="radiogroup" aria-labelledby="portal-level-label"
           >${buttons}</div>
      <span class="portal-level-blurb">${escapeHtml(LEVEL_INFO[current].blurb)}</span>`;

    const group = el.querySelector<HTMLElement>(".portal-level-group")!;
    const opts = [...group.querySelectorAll<HTMLButtonElement>(".portal-level-opt")];

    const pick = (btn: HTMLButtonElement): void => {
      const v = btn.dataset.level;
      // Guard rather than cast: a hand-edited DOM must not put an unknown string
      // into the level, where every atLeast() comparison would silently read as
      // below-guided — i.e. the most restrictive mode, for no visible reason.
      if (!isLevel(v)) return;
      this.session.setLevel(v);
    };

    group.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".portal-level-opt");
      if (btn) pick(btn);
    });

    // Arrow-key navigation is not optional for role="radiogroup" — a screen-reader
    // user is told this is a radio group and will try to arrow through it. Roving
    // tabindex (one stop for the whole group) matches that expectation too.
    group.addEventListener("keydown", (e) => {
      const idx = opts.findIndex((o) => o === document.activeElement);
      if (idx === -1) return;
      const delta =
        e.key === "ArrowRight" || e.key === "ArrowDown"
          ? 1
          : e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? -1
            : 0;
      if (!delta) return;
      e.preventDefault();
      const next = opts[(idx + delta + opts.length) % opts.length]!;
      next.focus();
      pick(next);
    });
  }

  /**
   * Announce a level change to assistive tech.
   *
   * Changing the level silently rebuilds `.portal-main`. Sighted users see that;
   * a screen-reader user gets an unannounced document mutation, having activated a
   * control whose effect is exactly that mutation. `aria-checked` on the button
   * says which option is selected but not that the page behind it changed.
   */
  private announceLevel(level: DisclosureLevel): void {
    const live = this.root.querySelector<HTMLElement>(".portal-live");
    if (!live) return;
    live.textContent = `${LEVEL_INFO[level].label} mode — ${LEVEL_INFO[level].blurb}`;
  }

  /**
   * The sidebar. Nothing is ever hidden by level — see the note in disclosure.ts on
   * why: hiding a nav entry means the user can neither find the feature nor learn it
   * exists, and guided's promise is "you can't hurt yourself", not "fewer features".
   *
   * The one reorder is by auth, not by level. The default route is `instances`,
   * which is auth-gated, so a first-time visitor's landing is a sign-in gate — and
   * "Connect account", the surface explaining how to GET an account to sign in with,
   * sat last in a nine-item list. For a signed-out visitor the auth-free surfaces
   * come first, "Connect account" at the top, with the relative order otherwise
   * preserved so the list doesn't reshuffle unrecognisably on sign-in.
   */
  private navSurfaces(): typeof surfaces {
    if (this.session.signedIn) return surfaces;
    const rank = (s: (typeof surfaces)[number]): number =>
      s.id === "connect" ? 0 : s.requiresAuth ? 2 : 1;
    return [...surfaces].sort((a, b) => rank(a) - rank(b));
  }

  private renderNav(): void {
    const active = this.currentId();
    this.navEl.innerHTML = this.navSurfaces()
      .map(
        (s) =>
          `<a class="portal-tool${s.id === active ? " active" : ""}" href="#/${s.id}"
             style="--accent: var(${s.accent})">${escapeHtml(s.label)}</a>`,
      )
      .join("");
  }

  private renderAccount(): void {
    const el = this.root.querySelector<HTMLElement>(".portal-account")!;
    if (this.session.signedIn) {
      el.innerHTML = `<span class="acct">account <b>${escapeHtml(
        this.session.accountId ?? "?",
      )}</b></span> <button class="portal-signout">sign out</button>`;
      el.querySelector(".portal-signout")!.addEventListener("click", () => {
        // Dispose the mounted surface BEFORE clearing the session, and do it here
        // rather than leaving it to route().
        //
        // route() only disposes when the route id changes, and signing out doesn't
        // change it: location.hash = "" falls through currentId() to surfaces[0],
        // which is `instances` — the surface most likely to be mounted. So without
        // this, `this.current.id === id` and the dispose branch is skipped.
        //
        // That is not cosmetic. The instances surface holds a SpawnClient whose
        // startMonitor() interval is still running, over an EC2Provider that
        // captured the credential *values* — which session.clear() cannot
        // invalidate. The result is authenticated DescribeInstances calls
        // continuing after the user believes they signed out, until STS expiry.
        // The same applies to a live SSM session on the terminal surface.
        this.current?.disposable.dispose();
        this.current = null;
        this.session.clear();
        location.hash = "";
        this.render();
        void this.route();
      });
    } else {
      el.innerHTML = `<button class="portal-signin">sign in</button>`;
      el.querySelector(".portal-signin")!.addEventListener("click", () => {
        void startSignIn(this.config);
      });
    }
  }

  private currentId(): string {
    // Strip a trailing ?query before splitting the path — a surface can be
    // returned to with params (e.g. the Slack OAuth callback lands on
    // #/slack?bot=connected), and the route id must still resolve.
    const id = location.hash.replace(/^#\/?/, "").split("?")[0]!.split("/")[0];
    return id || surfaces[0]?.id || "";
  }

  /**
   * Mount the surface for the current hash.
   *
   * `remount` forces a fresh mount of the *same* surface — needed when something
   * the surface read at mount time (the disclosure level) has changed. Without it
   * the `already mounted` short-circuit below would swallow the update.
   */
  private async route(opts: { remount?: boolean } = {}): Promise<void> {
    const id = this.currentId();
    const surface = findSurface(id);
    // Dispose the outgoing surface first.
    if (this.current && (this.current.id !== id || opts.remount)) {
      this.current.disposable.dispose();
      this.current = null;
    }
    this.renderNav();

    if (!surface) {
      this.mainEl.innerHTML = `<div class="portal-empty">Unknown tool: ${escapeHtml(id)}</div>`;
      return;
    }
    if (surface.requiresAuth && !this.session.signedIn) {
      this.renderSignInGate(surface.label);
      return;
    }
    if (this.current?.id === id) return; // already mounted

    this.mainEl.innerHTML = "";
    const ctx: SurfaceContext = {
      session: this.session,
      config: this.config,
      level: this.session.level,
      navigate: (sid) => {
        location.hash = `#/${sid}`;
      },
    };
    try {
      const disposable = await surface.mount(this.mainEl, ctx);
      this.current = { id, disposable };
    } catch (err) {
      this.mainEl.innerHTML = `<div class="portal-error">Failed to load ${escapeHtml(
        surface.label,
      )}: ${escapeHtml((err as Error).message)}</div>`;
    }
  }

  private renderSignInGate(label: string): void {
    this.mainEl.innerHTML = `
      <div class="portal-gate">
        <h2>Sign in to use ${escapeHtml(label)}</h2>
        <p>spore.host federates your institutional identity (via Globus) into your
           own AWS account — credentials stay in this browser tab.</p>
        <button class="portal-signin-lg">Sign in with Globus</button>
      </div>`;
    this.mainEl.querySelector(".portal-signin-lg")!.addEventListener("click", () => {
      void startSignIn(this.config);
    });
  }

  /**
   * The expiry banner.
   *
   * Both strings name the instances, because expiry stops the *portal* and not the
   * machines. The instances surface calls client.stopMonitor() when creds expire, so
   * the list freezes and the cost meter stops advancing while the instances keep
   * billing. "Session expired. Sign in again" is, at that moment, read as "nothing
   * is happening" — the opposite of what's true, and expensive to believe.
   */
  private showExpiry(state: "warning" | "expired"): void {
    this.expiryShown = true;
    this.bannerEl.hidden = false;
    if (state === "warning") {
      this.bannerEl.className = "portal-banner warn";
      this.bannerEl.textContent =
        "Your session expires soon — sign in again to stay connected. Anything you have running keeps running.";
    } else {
      this.bannerEl.className = "portal-banner expired";
      this.bannerEl.innerHTML = `Session expired — this page has stopped updating, but any
        machines you started are still running and still costing money.
        <button class="portal-reauth">Sign in again</button> to see and stop them.`;
      this.bannerEl.querySelector(".portal-reauth")!.addEventListener("click", () => {
        void startSignIn(this.config);
      });
    }
  }

  /**
   * A dismissible note that the mode changed, in the EXISTING banner element.
   *
   * Reuses `.portal-banner` rather than adding a second notification slot: two
   * stacked banners is how a header starts eating the viewport, and there is never a
   * reason to show both of these at once.
   *
   * Never overwrites an expiry banner. That one is telling the user their machines
   * are still running and still costing money; replacing it with "Showing more
   * options" to explain a control they just clicked and can already see would trade
   * the most expensive message in the portal for the least.
   */
  private showLevelNote(level: DisclosureLevel): void {
    if (this.expiryShown) return;
    this.bannerEl.hidden = false;
    this.bannerEl.className = "portal-banner info";
    this.bannerEl.innerHTML = `Showing ${escapeHtml(
      LEVEL_INFO[level].label.toLowerCase(),
    )} controls. Change this any time with <b>${escapeHtml(LEVEL_CONTROL_NAME)}</b> in the header.
      <button class="portal-banner-x" aria-label="Dismiss">×</button>`;
    this.bannerEl.querySelector(".portal-banner-x")!.addEventListener("click", () => {
      this.hideBanner();
    });
  }

  private hideBanner(): void {
    if (this.expiryShown) return;
    this.bannerEl.hidden = true;
    this.bannerEl.innerHTML = "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
