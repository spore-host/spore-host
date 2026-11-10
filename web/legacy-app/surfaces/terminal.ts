// The terminal surface: a live shell into a portal-launched instance over AWS
// SSM Session Manager — no SSH, no port 22, no key. The browser calls
// ssm:StartSession with the session's in-memory creds, gets a session-scoped
// StreamUrl + token, and attachTerminal (from @spore-host/spawn-ts/terminal)
// opens the data channel and renders with xterm. On teardown we close the socket
// AND TerminateSession (StartSession leaks a server-side session otherwise).
import { SSMClient, StartSessionCommand, TerminateSessionCommand } from "@aws-sdk/client-ssm";
import { attachTerminal, type AttachedTerminal } from "@spore-host/spawn-ts/terminal";
import { EC2Provider } from "@spore-host/spawn-ts";
import type { Disposable, SurfaceContext, ToolSurface } from "./types.js";
import { atLeast, LEVEL_CONTROL_NAME } from "../disclosure.js";

export const terminalSurface: ToolSurface = {
  id: "terminal",
  label: "Terminal",
  accent: "--spored",
  requiresAuth: true,

  async mount(host: HTMLElement, ctx: SurfaceContext): Promise<Disposable> {
    const creds = ctx.session.getCreds();
    if (!creds) throw new Error("terminal surface mounted without a session");
    const region = ctx.session.region;
    const credentials = {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    };

    // Read-only here: this surface lists to populate the picker and never launches,
    // so no iamInstanceProfile — passing one would imply a launch path that doesn't
    // exist. `list()` filters `tag:spawn:managed=true` server-side.
    const provider = new EC2Provider({ region, ...credentials });

    // Guards the two async paths (the list load, and attach) against writing into a
    // surface the shell has already torn down — dispose() can land first.
    let disposed = false;

    const root = document.createElement("div");
    root.className = "terminal-surface";
    root.innerHTML = `
      <div class="terminal-connect">
        <h2>Connect a terminal</h2>
        <p class="terminal-hint">Opens a shell over SSM Session Manager (no SSH). The
          instance must have the SSM agent + an instance profile allowing SSM —
          spawn-launched instances do.</p>
        <form class="terminal-form">
          <!-- The picker is the primary control and the text field the fallback, not
               the other way round. Both are always present: the list can only offer
               spawn-managed instances in this region, and a shell into something the
               portal didn't launch is a legitimate thing to want. -->
          <select class="terminal-pick" aria-label="Instance to connect to">
            <option value="">loading your instances…</option>
          </select>
          <input class="terminal-target" type="text" placeholder="i-0123456789abcdef0" autocomplete="off" spellcheck="false" hidden />
          <button type="submit" class="terminal-open">Connect</button>
          <button type="button" class="terminal-close" hidden>Disconnect</button>
        </form>
        <!-- Hidden at guided: an instance id is not a thing a guided user has, and
             offering the escape to typing one would be offering a dead end. -->
        <button type="button" class="terminal-byid">Connect to an id instead →</button>
        <div class="terminal-status" aria-live="polite"></div>
      </div>
      <div class="terminal-host" hidden></div>`;
    host.appendChild(root);

    const form = root.querySelector<HTMLFormElement>(".terminal-form")!;
    const pick = root.querySelector<HTMLSelectElement>(".terminal-pick")!;
    const target = root.querySelector<HTMLInputElement>(".terminal-target")!;
    const byIdBtn = root.querySelector<HTMLButtonElement>(".terminal-byid")!;
    const openBtn = root.querySelector<HTMLButtonElement>(".terminal-open")!;
    const closeBtn = root.querySelector<HTMLButtonElement>(".terminal-close")!;
    const status = root.querySelector<HTMLElement>(".terminal-status")!;
    const termHost = root.querySelector<HTMLElement>(".terminal-host")!;

    let attached: AttachedTerminal | null = null;
    let sessionId: string | null = null;

    // ── Choosing what to connect to ───────────────────────────────────────────
    //
    // This surface used to be a bare text field validated by /^i-[0-9a-f]{8,}$/,
    // which had two problems and only one of them was cosmetic.
    //
    // The cosmetic one: an instance id is not something a person has. Getting one
    // meant leaving for the Instances page, copying an id, and coming back — so a
    // page that never read ctx.level was effectively expert-only without saying so.
    //
    // The other one: that regex is a *syntax* check, so it accepts any instance id
    // in the account, including instances the portal never launched. The IAM role
    // scopes ec2:TerminateInstances to `spawn:managed=true` and does NOT scope
    // ssm:StartSession at all, so the narrowest thing standing between a portal
    // session and a shell on an unrelated production box was this field. Listing
    // instead of parsing makes the spawn-managed set the *default* set — the list
    // comes from EC2Provider.list(), which filters `tag:spawn:managed=true`
    // server-side. See the note at `byIdBtn` on why that is a usability fix and not
    // a security boundary.
    //
    // The provider is shared with the Instances surface rather than a second
    // DescribeInstances client of our own, which is what deferred this from the
    // original disclosure pass: this is already the heaviest chunk in the bundle.
    const guided = !atLeast(ctx.level, "standard");
    let byId = false;

    /** Which control the Connect button reads. Keeps one source of truth. */
    function chosenTarget(): string {
      return byId ? target.value : pick.value;
    }

    /**
     * Swap between the list and the text field.
     *
     * Both stay in the DOM either way, because `chosenTarget()` reads whichever is
     * active and hiding is cheaper than rebuilding — the same reason the lagotto
     * surface hides its fields rather than removing them.
     */
    function setById(on: boolean): void {
      byId = on;
      pick.hidden = on;
      target.hidden = !on;
      byIdBtn.textContent = on ? "← Pick from your instances" : "Connect to an id instead →";
      if (on) target.focus();
    }

    /**
     * Fill the list from the shared provider.
     *
     * Every branch says which fact it knows. "No instances" and "we couldn't ask" are
     * different states and conflating them would send a user hunting for instances
     * they have, or vice versa — the same rule the guided picker follows for a failed
     * catalog lookup.
     */
    async function loadInstances(): Promise<void> {
      try {
        const all = await provider.list();
        if (disposed) return;
        // Only `running` can take a shell. A stopped instance is listed nowhere here
        // because "Connect" against it fails inside SSM with a message about the
        // agent, which reads as a broken portal rather than a stopped machine.
        const usable = all.filter((i) => i.state === "running");
        if (usable.length === 0) {
          pick.innerHTML = `<option value="">${
            all.length === 0
              ? "no spawn-launched instances in this region"
              : `none of your ${all.length} instance(s) are running`
          }</option>`;
          openBtn.disabled = true;
          // The id field is the way out of an empty list, so point at it rather than
          // leaving a disabled button and no next step.
          if (!guided) status.textContent = "Nothing to connect to — or connect to an id.";
          return;
        }
        pick.innerHTML = usable
          .map(
            (i) =>
              `<option value="${escapeHtml(i.instanceId)}">${escapeHtml(
                `${i.name || i.instanceId} — ${i.instanceType}${i.spot ? " (spot)" : ""}`,
              )}</option>`,
          )
          .join("");
        openBtn.disabled = false;
      } catch (err) {
        if (disposed) return;
        pick.innerHTML = `<option value="">couldn't list your instances</option>`;
        // Not "no instances": we don't know that. Say what failed and leave the id
        // field as the way through.
        status.textContent = `couldn't list your instances: ${(err as Error).message}`;
        openBtn.disabled = true;
        // A guided user has no id to fall back on, so the escape has to appear even
        // though it's normally hidden at that level. A dead end is worse than a
        // control they may not understand.
        if (guided) byIdBtn.hidden = false;
      }
    }

    // Set by every path that ends the session *deliberately* — the Disconnect button,
    // credential expiry, dispose() — and read by attachTerminal's onClosed callback,
    // which fires asynchronously because a real `WebSocket.close()` dispatches
    // `onclose` as a task rather than inline. Without it the socket's own notification
    // lands after the user-initiated message and overwrites it: click Disconnect, read
    // "disconnected", then watch it become "session closed: …" a moment later
    // (spore-host#530).
    //
    // `session closed: <reason>` is the wording for a session that ended on its own —
    // the agent exited, the socket dropped, the instance went away. Using it for a
    // disconnect the user just asked for reports a requested event as an unexpected
    // one, and trains the reader to treat the message as noise for the next time it
    // appears unprompted and means something.
    //
    // Deliberately NOT cleared in resetUi(): that runs synchronously right after
    // teardown() on every path, i.e. before the async onclose it exists to suppress.
    // connect() clears it, which is the real boundary — a new session, a new socket.
    let intentionalClose = false;

    // Best-effort SSM cleanup: close the socket + TerminateSession (a bare
    // StartSession leaves a live session server-side until it times out).
    // Every caller is a deliberate end, so this is where the flag is set rather than
    // in each of the three of them.
    async function teardown(): Promise<void> {
      intentionalClose = true;
      attached?.dispose();
      attached = null;
      const sid = sessionId;
      sessionId = null;
      if (sid) {
        try {
          await new SSMClient({ region, credentials }).send(new TerminateSessionCommand({ SessionId: sid }));
        } catch {
          // The session may already be gone (agent exit); ignore.
        }
      }
    }

    function resetUi(): void {
      termHost.hidden = true;
      termHost.innerHTML = "";
      closeBtn.hidden = true;
      openBtn.disabled = false;
      target.disabled = false;
      pick.disabled = false;
      // Re-offer the swap, which is disabled while connected: switching how you
      // choose a target has no meaning when you already have a session.
      byIdBtn.disabled = false;
      // Drop the connected-state styling; the caller sets the next message itself.
      status.className = "terminal-status";
    }

    async function connect(instanceId: string): Promise<void> {
      const id = instanceId.trim();
      if (!/^i-[0-9a-f]{8,}$/.test(id)) {
        // Reachable from the picker too, not just the text field: an empty list
        // leaves `pick.value` as "". Wording covers both, since the user knows which
        // control they used and we don't need to tell them.
        status.textContent = byId
          ? "enter a valid instance id (i-…)"
          : "pick an instance to connect to";
        return;
      }
      openBtn.disabled = true;
      target.disabled = true;
      pick.disabled = true;
      byIdBtn.disabled = true;
      status.textContent = "starting SSM session…";
      // A new session and a new socket, so the previous session's deliberate-close
      // flag must not carry over and silence a real drop on this one.
      intentionalClose = false;
      try {
        const ssm = new SSMClient({ region, credentials });
        const started = await ssm.send(new StartSessionCommand({ Target: id }));
        if (!started.StreamUrl || !started.TokenValue || !started.SessionId) {
          throw new Error("StartSession returned an incomplete session");
        }
        sessionId = started.SessionId;
        // Say what ends the session, while it's live and the warning is actionable.
        // dispose() terminates it, and dispose() runs on navigation AND on a
        // disclosure-level change (which remounts the surface) — so an unrelated
        // click in the header drops a shell the user is typing into. Naming it is
        // the cheap half of the fix; not losing the session is issue-sized.
        status.className = "terminal-status warn";
        // `textContent`, so the name is interpolated raw rather than escaped.
        status.textContent = `Connected. Leaving this page, reloading, or changing ${LEVEL_CONTROL_NAME} in the header ends this session.`;
        // Un-hide BEFORE attach so xterm's fit addon measures a real size.
        termHost.hidden = false;
        attached = await attachTerminal(
          termHost,
          { streamUrl: started.StreamUrl, tokenValue: started.TokenValue, sessionId: started.SessionId },
          (reason) => {
            // The socket closed. If we closed it, the path that did so has already
            // said what happened in words that fit — leave its message alone and just
            // finish the cleanup. teardown() and resetUi() are both idempotent, so
            // running them again here is harmless and keeps the unexpected-drop path
            // (where nothing else has run) complete.
            if (!intentionalClose) {
              status.textContent = `session closed${reason ? ": " + reason : ""}`;
            }
            void teardown();
            resetUi();
          },
        );
        closeBtn.hidden = false;
      } catch (err) {
        status.textContent = `couldn't connect: ${(err as Error).message}`;
        await teardown();
        resetUi();
      }
    }

    const onSubmit = (e: Event) => {
      e.preventDefault();
      void connect(chosenTarget());
    };
    const onClose = () => {
      void teardown();
      resetUi();
      status.textContent = "disconnected";
    };
    const onById = () => {
      setById(!byId);
      // Clear a stale "pick an instance" / "enter a valid id" from the other mode.
      if (status.className === "terminal-status") status.textContent = "";
    };
    form.addEventListener("submit", onSubmit);
    closeBtn.addEventListener("click", onClose);
    byIdBtn.addEventListener("click", onById);

    // Guided keeps the picker and loses the escape: an instance id is not something a
    // guided user has, so a button offering to take one is a dead end dressed as an
    // option. It comes back if the list fails to load, where a dead end is the
    // alternative rather than the risk (see loadInstances).
    byIdBtn.hidden = guided;
    // Nothing to connect to until the list arrives, and a Connect click before then
    // would fail the id check and print an error about the user's own timing.
    openBtn.disabled = true;
    void loadInstances();

    // If the session's creds expire, drop the live shell.
    const offExpiry = ctx.session.onExpiry((state) => {
      if (state === "expired") {
        void teardown();
        resetUi();
        status.textContent = "session expired — sign in again";
      }
    });

    return {
      dispose() {
        disposed = true;
        offExpiry();
        form.removeEventListener("submit", onSubmit);
        closeBtn.removeEventListener("click", onClose);
        byIdBtn.removeEventListener("click", onById);
        void teardown();
        root.remove();
      },
    };
  },
};

/**
 * Instance names come from a user-controlled `Name` tag, so both the option label
 * and its value are interpolated escaped.
 *
 * An `<option>`'s text is not a place a `<script>` runs, and instance ids are
 * AWS-generated — so neither is exploitable as written. It's done anyway because
 * "this sink happens to be safe" is a property of the current markup, not of the
 * data, and the value is what `connect()` then trusts. Matches the picker's own
 * helper (`guided/picker.ts`).
 */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
