// The terminal surface picks a target, and what it offers to pick from is the point.
//
// What shipped was a text field validated by /^i-[0-9a-f]{8,}$/. That has a usability
// failure and a blast-radius failure, and they pull in the same direction:
//
//   - An instance id is not something a person has. Getting one meant leaving for the
//     Instances page and copying one, so a surface that never read ctx.level was
//     effectively expert-only without saying so.
//   - The regex is a SYNTAX check. It accepts any instance id in the account,
//     including instances the portal never launched.
//
// The IAM fix (scoping ssm:StartSession to spawn:managed=true) is the actual authz
// boundary and lives in infra/tofu + the CFN template; these tests cover the browser
// half — that the default set of targets is the spawn-managed set, and that the
// surface never claims to know something it doesn't.
//
// The load-bearing assertions are the negative and the failure ones: that the list is
// populated from the provider rather than free text, that an empty list and a failed
// lookup say DIFFERENT things, and that a guided user is never left with a dead end.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../session.js";
import type { PortalConfig, SurfaceContext } from "./types.js";
import { LEVEL_CONTROL_NAME, type DisclosureLevel } from "../disclosure.js";

/** What the mocked EC2Provider returns from list(). Each test sets what it needs. */
let instances: Array<Record<string, unknown>> = [];
/** Set to make list() reject, so the lookup-failed branch is reachable. */
let listError: Error | null = null;
/**
 * Set to hold list() open, so "dispose() lands before the list resolves" is reachable
 * at all. The default mock resolves in the same microtask, which never reproduces
 * that race — and a test that cannot reproduce the race it names would pass whether
 * or not the guard exists.
 */
let listGate: Promise<void> | null = null;
/** Every EC2Provider constructed, so its options are assertable. */
let providerOpts: Array<Record<string, unknown>> = [];
/** StartSession targets the surface actually asked for. */
let started: string[] = [];
/**
 * The reason the mocked socket reports when it closes, mirroring what the real data
 * channel supplies. Only read by the unexpected-drop path — a deliberate close must
 * not print it at all.
 */
let closeReason: string | undefined = "stub";
/**
 * Fires the surface's onClosed callback, so a drop the user did NOT ask for can be
 * simulated without going through dispose().
 */
let dropSocket: (() => void) | null = null;

vi.mock("@spore-host/spawn-ts", () => ({
  class: undefined,
  EC2Provider: class {
    constructor(opts: Record<string, unknown>) {
      providerOpts.push(opts);
    }
    async list(): Promise<unknown[]> {
      if (listGate) await listGate;
      if (listError) throw listError;
      return instances;
    }
  },
}));

vi.mock("@spore-host/spawn-ts/terminal", () => ({
  // Resolves to a disposable so a "successful" connect is reachable without xterm.
  //
  // `dispose()` now fires the surface's `onClosed` callback **on a later task**,
  // because that is what the real thing does: `WebSocket.close()` dispatches `onclose`
  // as a task rather than inline. The mock never fired it at all, which is why
  // spore-host#530 — the socket's own "session closed: …" landing after and
  // overwriting the user's "disconnected" — was invisible to this suite and had to be
  // found by driving the harness in a browser.
  //
  // The deferral is what makes it meaningful. Calling onClosed synchronously would run
  // it *inside* teardown(), before the message it races with has been written, and
  // would recurse: close → onClosed → teardown → dispose → close.
  attachTerminal: vi.fn(
    async (_host: unknown, _session: unknown, onClosed: (reason?: string) => void) => {
      dropSocket = () => onClosed(closeReason);
      let closed = false;
      return {
        dispose: vi.fn(() => {
          // Idempotent, like the real socket: teardown() can run more than once per
          // session (the onClosed path calls it again), and a second onClosed would
          // re-enter the same race this exists to test.
          if (closed) return;
          closed = true;
          setTimeout(() => onClosed(closeReason), 0);
        }),
      };
    },
  ),
}));

vi.mock("@aws-sdk/client-ssm", () => {
  class StartSessionCommand {
    constructor(public input: { Target?: string }) {}
  }
  class TerminateSessionCommand {
    constructor(public input: unknown) {}
  }
  class SSMClient {
    async send(cmd: unknown): Promise<unknown> {
      if (cmd instanceof StartSessionCommand) {
        started.push(cmd.input.Target ?? "");
        return { StreamUrl: "wss://x", TokenValue: "t", SessionId: "s-1" };
      }
      return {};
    }
  }
  return { SSMClient, StartSessionCommand, TerminateSessionCommand };
});

const { terminalSurface } = await import("./terminal.js");

const settle = () => new Promise((r) => setTimeout(r, 0));

const config = { region: "us-east-1" } as PortalConfig;

/** A running spawn-managed instance, as EC2Provider.list() would report it. */
function inst(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instanceId: "i-0123456789abcdef0",
    name: "trial-run",
    instanceType: "t4g.xlarge",
    state: "running",
    spot: false,
    ...over,
  };
}

function ctxAt(level: DisclosureLevel = "standard"): SurfaceContext {
  const session = new SessionController("us-east-1", null);
  session.setLevel(level);
  vi.spyOn(session, "getCreds").mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "token",
  } as never);
  return { session, config, level, navigate: vi.fn() };
}

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  instances = [inst()];
  listError = null;
  listGate = null;
  providerOpts = [];
  started = [];
  closeReason = "stub";
  dropSocket = null;
});

const pick = () => host.querySelector<HTMLSelectElement>(".terminal-pick")!;
const field = () => host.querySelector<HTMLInputElement>(".terminal-target")!;
const byId = () => host.querySelector<HTMLButtonElement>(".terminal-byid")!;
const openBtn = () => host.querySelector<HTMLButtonElement>(".terminal-open")!;
const status = () => host.querySelector<HTMLElement>(".terminal-status")!;
const text = () => status().textContent!.replace(/\s+/g, " ");

describe("terminalSurface target picker", () => {
  it("offers the account's spawn-managed instances instead of asking for an id", async () => {
    instances = [inst({ instanceId: "i-00000000000000aaa", name: "alpha" }), inst({ instanceId: "i-00000000000000bbb", name: "beta" })];
    const d = await terminalSurface.mount(host, ctxAt());
    await settle();

    const opts = [...pick().options];
    expect(opts.map((o) => o.value)).toEqual(["i-00000000000000aaa", "i-00000000000000bbb"]);
    // The label has to carry something a person recognises. An id-only list would be
    // the same problem in a different control.
    expect(opts[0]!.textContent).toContain("alpha");
    expect(opts[0]!.textContent).toContain("t4g.xlarge");
    // And the free-text field is the fallback, not the default.
    expect(field().hidden).toBe(true);
    expect(pick().hidden).toBe(false);
    d.dispose();
  });

  it("lists only running instances", async () => {
    // A stopped instance fails inside SSM with a message about the agent, which reads
    // as a broken portal rather than a stopped machine.
    instances = [
      inst({ instanceId: "i-000000000000000a1", state: "running" }),
      inst({ instanceId: "i-000000000000000b2", state: "stopped" }),
      inst({ instanceId: "i-000000000000000c3", state: "pending" }),
    ];
    const d = await terminalSurface.mount(host, ctxAt());
    await settle();
    expect([...pick().options].map((o) => o.value)).toEqual(["i-000000000000000a1"]);
    d.dispose();
  });

  it("connects to the picked instance, not to whatever is in the text field", async () => {
    // Ids are hex — the surface's own /^i-[0-9a-f]{8,}$/ rejects anything else, so a
    // mnemonic fixture ("i-picked111") fails the id check rather than the assertion.
    instances = [inst({ instanceId: "i-00000000000000ace" })];
    const d = await terminalSurface.mount(host, ctxAt());
    await settle();
    // A value in the hidden field must not win: `chosenTarget()` reads the ACTIVE
    // control, and getting that backwards would connect somewhere unintended.
    field().value = "i-00000000000000bad";
    host.querySelector<HTMLFormElement>(".terminal-form")!.dispatchEvent(new Event("submit"));
    await settle();
    expect(started).toEqual(["i-00000000000000ace"]);
    d.dispose();
  });

  it("constructs the provider read-only, with no instance profile", async () => {
    // This surface lists and never launches. Passing iamInstanceProfile would imply a
    // launch path that doesn't exist here.
    const d = await terminalSurface.mount(host, ctxAt());
    await settle();
    expect(providerOpts).toHaveLength(1);
    expect(providerOpts[0]).not.toHaveProperty("iamInstanceProfile");
    expect(providerOpts[0]!.region).toBe("us-east-1");
    d.dispose();
  });
});

describe("terminalSurface when there is nothing to pick", () => {
  it("distinguishes an empty account from a failed lookup", async () => {
    // The #63 invariant, in this surface: "you have no instances" and "we couldn't
    // ask" are different facts, and reporting the first when we only know the second
    // sends the user hunting for instances they may well have.
    instances = [];
    let d = await terminalSurface.mount(host, ctxAt());
    await settle();
    expect(pick().textContent).toMatch(/no spawn-launched instances/i);
    expect(text()).not.toMatch(/couldn't list/i);
    d.dispose();

    host.innerHTML = "";
    listError = new Error("AccessDenied");
    d = await terminalSurface.mount(host, ctxAt());
    await settle();
    expect(text()).toMatch(/couldn't list your instances: AccessDenied/);
    expect(pick().textContent).not.toMatch(/no spawn-launched/i);
    d.dispose();
  });

  it("says how many instances exist when none of them are running", async () => {
    // "No instances" would be false — they have two, both stopped, and the fix is to
    // start one rather than to launch another.
    instances = [inst({ state: "stopped" }), inst({ state: "terminated" })];
    const d = await terminalSurface.mount(host, ctxAt());
    await settle();
    expect(pick().textContent).toMatch(/none of your 2 instance\(s\) are running/i);
    d.dispose();
  });

  it("cannot submit before the list has loaded", async () => {
    // A Connect click against an empty select would fail the id check and print an
    // error about the user's own timing.
    instances = [];
    const d = await terminalSurface.mount(host, ctxAt());
    expect(openBtn().disabled).toBe(true);
    await settle();
    d.dispose();
  });
});

describe("terminalSurface disclosure", () => {
  it("hides the by-id escape at guided", async () => {
    // An instance id is not something a guided user has, so a control offering to
    // take one is a dead end dressed as an option.
    const d = await terminalSurface.mount(host, ctxAt("guided"));
    await settle();
    expect(byId().hidden).toBe(true);
    // But the picker itself is the whole point of the surface at every level.
    expect(pick().hidden).toBe(false);
    expect([...pick().options].map((o) => o.value)).toEqual(["i-0123456789abcdef0"]);
    d.dispose();
  });

  it("offers the by-id escape from standard up", async () => {
    for (const level of ["standard", "expert"] as const) {
      host.innerHTML = "";
      const d = await terminalSurface.mount(host, ctxAt(level));
      await settle();
      expect(byId().hidden, level).toBe(false);
      d.dispose();
    }
  });

  it("reveals the escape at guided when the list fails, rather than dead-ending", async () => {
    // The one case where a guided user needs the id field: the list is the only way
    // in and it didn't load. A dead end is worse than a control they may not
    // understand.
    listError = new Error("AccessDenied");
    const d = await terminalSurface.mount(host, ctxAt("guided"));
    await settle();
    expect(byId().hidden).toBe(false);
    d.dispose();
  });

  it("swaps between the picker and the field without losing either", async () => {
    const d = await terminalSurface.mount(host, ctxAt());
    await settle();
    byId().click();
    expect(pick().hidden).toBe(true);
    expect(field().hidden).toBe(false);
    expect(byId().textContent).toMatch(/pick from your instances/i);
    // Both stay in the DOM: chosenTarget() reads whichever is active, and rebuilding
    // would throw away a list already fetched.
    expect(pick().options.length).toBe(1);

    byId().click();
    expect(pick().hidden).toBe(false);
    expect(field().hidden).toBe(true);
    d.dispose();
  });

  it("connects to a typed id once the escape is taken", async () => {
    const d = await terminalSurface.mount(host, ctxAt());
    await settle();
    byId().click();
    field().value = "i-deadbeef00";
    host.querySelector<HTMLFormElement>(".terminal-form")!.dispatchEvent(new Event("submit"));
    await settle();
    expect(started).toEqual(["i-deadbeef00"]);
    d.dispose();
  });
});

describe("terminalSurface while connected", () => {
  it("locks the target controls and still names what ends the session", async () => {
    const d = await terminalSurface.mount(host, ctxAt());
    await settle();
    host.querySelector<HTMLFormElement>(".terminal-form")!.dispatchEvent(new Event("submit"));
    await settle();

    // Changing how you choose a target is meaningless once you have a session, and
    // leaving it live invites a click that appears to do something and doesn't.
    expect(pick().disabled).toBe(true);
    expect(byId().disabled).toBe(true);
    // The warning from the earlier honesty pass must survive this change: dispose()
    // terminates the session, and dispose() runs on a Mode change.
    expect(text()).toContain(LEVEL_CONTROL_NAME);
    expect(status().className).toContain("warn");
    d.dispose();
  });

  it("re-enables the target controls after disconnecting", async () => {
    const d = await terminalSurface.mount(host, ctxAt());
    await settle();
    host.querySelector<HTMLFormElement>(".terminal-form")!.dispatchEvent(new Event("submit"));
    await settle();
    host.querySelector<HTMLButtonElement>(".terminal-close")!.click();
    await settle();
    // Or a disconnect would leave a surface that can never connect again.
    expect(pick().disabled).toBe(false);
    expect(byId().disabled).toBe(false);
    expect(openBtn().disabled).toBe(false);
    d.dispose();
  });

  describe("what the status line says when the session ends (#530)", () => {
    /** Connect, then run out the deferred onClosed the mocked socket schedules. */
    async function connectThen(act: () => void): Promise<void> {
      host.querySelector<HTMLFormElement>(".terminal-form")!.dispatchEvent(new Event("submit"));
      await settle();
      act();
      // Two: one for the click's own synchronous work, one for the task the socket's
      // close is dispatched on. A single settle() would let the bug pass.
      await settle();
      await settle();
    }

    it("does not overwrite 'disconnected' with the socket's own message", async () => {
      // The bug: Disconnect wrote "disconnected" synchronously, then the socket's
      // onclose landed a task later and replaced it with "session closed: stub".
      // `session closed: <reason>` is the wording for a session that ended on its own,
      // so using it for a disconnect the user just clicked reports a requested event as
      // an unexpected one.
      const d = await terminalSurface.mount(host, ctxAt());
      await settle();
      await connectThen(() => host.querySelector<HTMLButtonElement>(".terminal-close")!.click());

      expect(text()).toBe("disconnected");
      expect(text()).not.toContain("session closed");
      d.dispose();
    });

    it("still reports a drop the user did not ask for", async () => {
      // The other direction, and the reason this isn't just "never print that message".
      // An agent exit or a dropped socket is exactly what the wording is for, and
      // suppressing it would leave a dead terminal with a stale "Connected." above it —
      // a worse bug than the one being fixed.
      const d = await terminalSurface.mount(host, ctxAt());
      await settle();
      await connectThen(() => dropSocket!());

      expect(text()).toContain("session closed");
      expect(text()).toContain("stub");
      // And the surface is usable again, not stuck in the connected state.
      expect(openBtn().disabled).toBe(false);
      expect(host.querySelector<HTMLElement>(".terminal-close")!.hidden).toBe(true);
      d.dispose();
    });

    it("reports a drop with no reason without a trailing colon", async () => {
      closeReason = undefined;
      const d = await terminalSurface.mount(host, ctxAt());
      await settle();
      await connectThen(() => dropSocket!());

      expect(text()).toBe("session closed");
      d.dispose();
    });

    it("keeps the expiry message rather than replacing it with the socket's", async () => {
      // Credential expiry also tears down deliberately, and "sign in again" is the
      // actionable half. `session closed: stub` in its place names the symptom and
      // drops the instruction.
      // The surface's own listener is captured as it subscribes, rather than reaching
      // for a private emit() or adding a test-only method to SessionController.
      const ctx = ctxAt();
      let fireExpiry: ((s: "warning" | "expired") => void) | null = null;
      const realOnExpiry = ctx.session.onExpiry.bind(ctx.session);
      vi.spyOn(ctx.session, "onExpiry").mockImplementation((fn) => {
        fireExpiry = fn;
        return realOnExpiry(fn);
      });
      const d = await terminalSurface.mount(host, ctx);
      await settle();
      await connectThen(() => fireExpiry!("expired"));

      expect(text()).toContain("sign in again");
      expect(text()).not.toContain("session closed");
      d.dispose();
    });

    it("does not suppress a drop on the next session after a deliberate close", async () => {
      // The flag has to be cleared when a new session starts. If it leaked, a real drop
      // on the second connection would be silent — the failure mode this fix could
      // introduce, and the reason it's cleared in connect() rather than in resetUi()
      // (which runs synchronously before the onClosed it exists to suppress).
      const d = await terminalSurface.mount(host, ctxAt());
      await settle();
      await connectThen(() => host.querySelector<HTMLButtonElement>(".terminal-close")!.click());
      expect(text()).toBe("disconnected");

      await connectThen(() => dropSocket!());
      expect(text()).toContain("session closed");
      d.dispose();
    });
  });
});

describe("terminalSurface teardown", () => {
  it("does not write into a disposed surface when the list resolves late", async () => {
    // dispose() can land before list() settles — a Mode change immediately after
    // navigating here. Writing then would touch a detached DOM and, worse, overwrite
    // whatever the next mount had already rendered.
    let release = () => {};
    listGate = new Promise<void>((r) => (release = r));

    const d = await terminalSurface.mount(host, ctxAt());
    // Captured, not re-queried: dispose() removes the root from `host`, so a fresh
    // querySelector afterwards returns null and would pass this test for the wrong
    // reason. The point is that THIS node — the one the pending list() closure holds —
    // is never written to.
    const el = pick();
    const before = el.innerHTML;
    expect(before, "list must still be pending, or the race isn't under test").toMatch(/loading/i);

    d.dispose();
    release();
    await settle();
    expect(el.innerHTML).toBe(before);
  });

  it("escapes an instance name from a user-controlled tag", async () => {
    // `name` comes from the Name tag, which the account's own users write. Not
    // exploitable in an <option>, which is why it's asserted rather than assumed —
    // the property belongs to the current markup, not to the data.
    instances = [inst({ name: `<img src=x onerror=alert(1)>` })];
    const d = await terminalSurface.mount(host, ctxAt());
    await settle();
    expect(pick().querySelector("img")).toBeNull();
    expect(pick().options[0]!.textContent).toContain("<img");
    d.dispose();
  });
});
