// The shell's lifecycle contract with its surfaces: when it disposes them, and
// whether the level control tells the truth.
//
// The registry is mocked with a recording stub rather than the real surfaces. This
// is a test about the shell's dispose/mount discipline, and mounting the real
// surfaces would drag in the EC2/SSM SDKs and a live Dashboard to observe it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const disposed: string[] = [];
const mounted: string[] = [];

vi.mock("./surfaces/registry.js", () => {
  const make = (id: string, requiresAuth: boolean) => ({
    id,
    label: id,
    accent: "--spawn",
    requiresAuth,
    async mount(host: HTMLElement) {
      mounted.push(id);
      host.innerHTML = `<div class="stub-${id}"></div>`;
      return {
        dispose() {
          disposed.push(id);
        },
      };
    },
  });
  const surfaces = [make("instances", true), make("truffle", false)];
  return { surfaces, findSurface: (id: string) => surfaces.find((s) => s.id === id) };
});

vi.mock("./auth/globus-login.js", () => ({ startSignIn: vi.fn() }));

const { Shell } = await import("./shell.js");
const { SessionController } = await import("./session.js");
type SessionController = InstanceType<typeof SessionController>;
const { LEVEL_INFO, LEVELS } = await import("./disclosure.js");
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Fire an expiry transition through the session's real listener set.
 *
 * The alternative — arming the timer with a near-past expiration — would make these
 * tests depend on setTimeout ordering to assert something about banner precedence.
 * `emit` is private, so this reaches the private set directly rather than mocking
 * `onExpiry`, which would decouple the test from the wiring it's meant to cover.
 */
function fireExpiry(session: SessionController, state: "warning" | "expired"): void {
  const listeners = (session as unknown as { expiryListeners: Set<(s: string) => void> })
    .expiryListeners;
  for (const fn of listeners) fn(state);
}

/** A session that reports as signed in without touching STS. */
function signedInSession() {
  const session = new SessionController("us-east-1", null);
  vi.spyOn(session, "signedIn", "get").mockReturnValue(true);
  vi.spyOn(session, "accountId", "get").mockReturnValue("123456789012");
  vi.spyOn(session, "getCreds").mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "token",
  } as never);
  return session;
}

describe("Shell sign-out", () => {
  let root: HTMLElement;

  beforeEach(() => {
    disposed.length = 0;
    mounted.length = 0;
    location.hash = "";
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  it("disposes the mounted surface on sign-out", async () => {
    // The bug this pins down: route() only disposes when the route id CHANGES, and
    // signing out doesn't change it — location.hash = "" falls through currentId()
    // to surfaces[0], which is `instances`. So `this.current.id === id` and the
    // dispose branch was skipped.
    //
    // That is not cosmetic. The instances surface holds a SpawnClient whose
    // startMonitor() interval is still running over an EC2Provider that captured the
    // credential VALUES — which session.clear() cannot invalidate. The user who signs
    // out keeps making authenticated DescribeInstances calls until STS expiry.
    const session = signedInSession();
    const shell = new Shell(root, session, { region: "us-east-1" } as never);
    shell.start();
    await settle();
    expect(mounted).toContain("instances");
    const disposeMark = disposed.length;

    // Sign out for real: the mock's signedIn getter has to follow, or the shell
    // would re-mount the same surface and the assertion would pass for the wrong
    // reason.
    vi.spyOn(session, "signedIn", "get").mockReturnValue(false);
    root.querySelector<HTMLButtonElement>(".portal-signout")!.click();
    await settle();

    expect(disposed.slice(disposeMark)).toEqual(["instances"]);
  });

  it("does not re-mount an auth-gated surface after signing out", async () => {
    const session = signedInSession();
    const shell = new Shell(root, session, { region: "us-east-1" } as never);
    shell.start();
    await settle();
    const mountMark = mounted.length;

    vi.spyOn(session, "signedIn", "get").mockReturnValue(false);
    root.querySelector<HTMLButtonElement>(".portal-signout")!.click();
    await settle();

    expect(mounted.slice(mountMark)).toEqual([]); // not mounted a second time
    expect(root.querySelector(".portal-gate")).not.toBeNull();
  });

  it("disposes before clearing the session, so teardown still has its creds", async () => {
    // Ordering matters for the surfaces whose dispose() makes an AWS call — the
    // terminal's TerminateSession is the live example. Disposing after clear() would
    // leave a session open server-side.
    //
    // Both events land in one ordered list, so this asserts the interleaving rather
    // than just that each happened.
    const order: string[] = [];
    const session = signedInSession();
    vi.spyOn(session, "clear").mockImplementation(() => order.push("clear"));
    disposed.length = 0;

    const shell = new Shell(root, session, { region: "us-east-1" } as never);
    shell.start();
    await settle();

    // Mirror dispose() calls into the same list. The stub's own dispose pushes to
    // `disposed`, so watch that array's growth via a proxy on the recorded surface.
    const origPush = disposed.push.bind(disposed);
    disposed.push = ((...args: string[]) => {
      order.push("dispose");
      return origPush(...args);
    }) as typeof disposed.push;

    root.querySelector<HTMLButtonElement>(".portal-signout")!.click();
    await settle();
    disposed.push = origPush;

    expect(order).toEqual(["dispose", "clear"]);
  });
});

describe("Shell level changes", () => {
  let root: HTMLElement;

  beforeEach(() => {
    disposed.length = 0;
    mounted.length = 0;
    location.hash = "#/truffle";
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  it("re-mounts the current surface when the level changes", async () => {
    // Surfaces read ctx.level once at mount rather than subscribing, so the remount
    // IS the update mechanism. If it stopped happening, every surface would silently
    // keep rendering the level the user had when they arrived.
    //
    // Measured as a delta, not an absolute count: Shell.start() registers a
    // window-level hashchange listener and the class has no teardown (there is one
    // Shell for the app's lifetime), so shells from earlier tests in this file still
    // react to the beforeEach hash change. Counting from a mark keeps this test
    // about the level, not about listener bookkeeping.
    const session = new SessionController("us-east-1", null);
    const shell = new Shell(root, session, { region: "us-east-1" } as never);
    shell.start();
    await settle();
    const mountMark = mounted.length;
    const disposeMark = disposed.length;

    session.setLevel("expert");
    await settle();
    expect(disposed.slice(disposeMark)).toContain("truffle");
    expect(mounted.slice(mountMark)).toContain("truffle");
  });
});

describe("Shell level control", () => {
  let root: HTMLElement;
  let session: SessionController;

  const opts = () => [...root.querySelectorAll<HTMLButtonElement>(".portal-level-opt")];
  const optFor = (level: string) =>
    root.querySelector<HTMLButtonElement>(`.portal-level-opt[data-level="${level}"]`)!;

  beforeEach(async () => {
    disposed.length = 0;
    mounted.length = 0;
    location.hash = "#/truffle";
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    session = new SessionController("us-east-1", null);
    new Shell(root, session, { region: "us-east-1" } as never).start();
    await settle();
  });

  it("renders one option per level, in order", () => {
    // The levels are ORDERED — that ordering is the entire semantics atLeast()
    // depends on — and three side-by-side options show it where a collapsed
    // <select> showing one did not.
    expect(opts().map((o) => o.dataset.level)).toEqual([...LEVELS]);
  });

  it("shows the current level's blurb as visible text", async () => {
    // These blurbs were attached as `title` on each <option>, and native
    // `<option title>` is not reliably rendered anywhere: Safari never shows it and
    // mobile pickers show labels only. So the copy explaining what each level is FOR
    // was written, shipped, and seen by almost nobody.
    expect(root.querySelector(".portal-level-blurb")!.textContent).toBe(
      LEVEL_INFO[session.level].blurb,
    );
    optFor("expert").click();
    await settle();
    expect(root.querySelector(".portal-level-blurb")!.textContent).toBe(LEVEL_INFO.expert.blurb);
  });

  it("sets the level on click and marks exactly one option checked", async () => {
    optFor("expert").click();
    await settle();
    expect(session.level).toBe("expert");
    const checked = opts().filter((o) => o.getAttribute("aria-checked") === "true");
    expect(checked.map((o) => o.dataset.level)).toEqual(["expert"]);
  });

  it("keeps one tab stop for the whole group, on the selected option", async () => {
    // Roving tabindex: a radiogroup is one stop, not three, and the stop must follow
    // the selection or Tab would land on an option the user didn't choose.
    optFor("standard").click();
    await settle();
    expect(opts().filter((o) => o.tabIndex === 0).map((o) => o.dataset.level)).toEqual([
      "standard",
    ]);
  });

  it("moves through the group with arrow keys", async () => {
    // Not optional for role="radiogroup" — a screen-reader user is told this is a
    // radio group and will try to arrow through it, so without this the control
    // announces an interaction model it doesn't implement.
    optFor("guided").focus();
    const group = root.querySelector<HTMLElement>(".portal-level-group")!;
    group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await settle();
    expect(session.level).toBe("standard");
  });

  it("wraps at the ends of the group", async () => {
    optFor("guided").focus();
    root
      .querySelector<HTMLElement>(".portal-level-group")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await settle();
    expect(session.level).toBe("expert");
  });

  it("announces the change in a live region", async () => {
    // Changing the level silently rebuilds .portal-main. Sighted users see that; a
    // screen-reader user gets an unannounced document mutation, having activated a
    // control whose entire effect is that mutation.
    optFor("expert").click();
    await settle();
    const live = root.querySelector<HTMLElement>(".portal-live")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toContain(LEVEL_INFO.expert.label);
  });

  it("says where to undo a raised level, dismissibly", async () => {
    // A surface can raise the level itself (the guided picker's "Show me all the
    // options"), and that one click writes localStorage and changes every surface
    // forever. The return trip means finding the header control — precisely the
    // knowledge the escape hatch existed to spare them.
    optFor("expert").click();
    await settle();
    const banner = root.querySelector<HTMLElement>(".portal-banner")!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("Mode");
    banner.querySelector<HTMLButtonElement>(".portal-banner-x")!.click();
    expect(banner.hidden).toBe(true);
  });

  it("shows no note when returning to the default level", async () => {
    // "Showing guided controls" would be explaining the absence of a change.
    optFor("expert").click();
    await settle();
    optFor("guided").click();
    await settle();
    expect(root.querySelector<HTMLElement>(".portal-banner")!.hidden).toBe(true);
  });

  it("never replaces an expiry banner with a level note", async () => {
    // The expiry banner is telling the user their machines are still running and
    // still costing money. Trading that for "Showing more options" — explaining a
    // control they just clicked and can already see — would swap the most expensive
    // message in the portal for the least.
    //
    // Driven through the shell's own onExpiry subscription rather than by poking the
    // banner, so this fails if that wiring changes too.
    const banner = root.querySelector<HTMLElement>(".portal-banner")!;
    fireExpiry(session, "expired");
    expect(banner.textContent).toContain("costing money");

    optFor("expert").click();
    await settle();
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("costing money");
  });
});

describe("Shell nav order", () => {
  let root: HTMLElement;

  beforeEach(() => {
    location.hash = "#/truffle";
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  const ids = () =>
    [...root.querySelectorAll<HTMLAnchorElement>(".portal-tool")].map((a) =>
      a.getAttribute("href")!.replace("#/", ""),
    );

  it("puts the auth-free surfaces first when signed out", async () => {
    // The default route is auth-gated, so a first-time visitor's landing is a sign-in
    // gate — while the surface explaining how to GET an account to sign in with sat
    // last in a nine-item list. The mocked registry here has no `connect`, so what
    // this pins is the auth-free-first half of the rule.
    const session = new SessionController("us-east-1", null);
    new Shell(root, session, { region: "us-east-1" } as never).start();
    await settle();
    expect(ids()).toEqual(["truffle", "instances"]);
  });

  it("leaves the registry order alone when signed in", async () => {
    // The list must not reshuffle unrecognisably at the moment of sign-in.
    new Shell(root, signedInSession(), { region: "us-east-1" } as never).start();
    await settle();
    expect(ids()).toEqual(["instances", "truffle"]);
  });
});
