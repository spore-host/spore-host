// The lagotto surface: watch for EC2 instance-type capacity and say when it
// appears. This is the ninth tool in the portal and the first added AFTER the
// shell was built — the whole point of the ToolSurface contract. Adding it
// touched exactly this file, one registry entry, a CSS block, and one IAM action.
//
// The decision logic is NOT reimplemented here: @spore-host/lagotto-ts/live's
// CapacityWatcher drives check/poll and the pure matcher decides what counts as a
// match (price cap, AZ pin, spot vs on-demand), identical to the `lagotto` CLI.
// What the browser must supply is the CapacityFinder seam — lagotto-ts owns the
// interface and deliberately ships no AWS client.
//
// Why a portal-local finder instead of truffle-ts's AwsLiveFinder: capacity
// watching needs AZ-LEVEL offering data ("is p5.48xlarge offered in us-east-1b
// right now?"), and truffle-ts's live finder is region-agnostic — its
// InstanceType carries no region/availableAZs (results are deduped across
// regions) and its getSpotPricing is still a stub (truffle-ts#18). So this file
// implements the seam directly over ec2:DescribeInstanceTypeOfferings (+
// DescribeSpotPriceHistory for a Spot watch), the same two calls Go truffle's
// getAvailabilityZones / GetSpotPricing make. When truffle-ts#18 lands and its
// finder grows per-region AZs, this can collapse to lagotto-ts's
// truffleFinderAdapter.
import {
  DescribeInstanceTypeOfferingsCommand,
  DescribeSpotPriceHistoryCommand,
  EC2Client,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import { CapacityWatcher, type CapacityFinder, type FinderInstanceType, type FinderSpotPrice } from "@spore-host/lagotto-ts/live";
import type { MatchResult, Watch } from "@spore-host/lagotto-ts";
import { onDemandPrice } from "@spore-host/truffle-ts";
import type { Disposable, SurfaceContext, ToolSurface } from "./types.js";
import { atLeast, LEVEL_CONTROL_NAME } from "../disclosure.js";
import { readHashParam, writeHashParams } from "../hashstate.js";
import { mountGuidedPicker } from "../guided/picker.js";
import { WATCH_SHAPES, watchPattern, type GuidedRecommendation } from "../guided/shapes.js";

/** Poll cadence offered in the UI. A browser tab is a short-lived watcher. */
const INTERVALS = [
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
] as const;

/** Pre-selected cadence, and the one value `every` is omitted from the hash for. */
const DEFAULT_INTERVAL_MS = 60_000;

export const lagottoSurface: ToolSurface = {
  id: "lagotto",
  label: "Watch capacity",
  accent: "--lagotto",
  requiresAuth: true,

  async mount(host: HTMLElement, ctx: SurfaceContext): Promise<Disposable> {
    const creds = ctx.session.getCreds();
    if (!creds) throw new Error("lagotto surface mounted without a session");
    const region = ctx.session.region;
    const ec2 = new EC2Client({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    });
    const watcher = new CapacityWatcher({ finder: portalCapacityFinder(ec2, region) });

    const root = document.createElement("div");
    // The guided variant is a class on the root rather than a different template: the
    // form still exists and is still the single source of what's being watched (see
    // "Guided mode" below), so what differs is what's *shown*, which is CSS's job.
    root.className = atLeast(ctx.level, "standard")
      ? "lagotto-surface"
      : "lagotto-surface lagotto-guided";
    root.innerHTML = `
      <div class="lagotto-head">
        <h2>Watch for capacity</h2>
        <p class="lagotto-hint lagotto-hint-query">Scarce instance types (<code>p5.*</code>, <code>trn2.*</code>)
          come and go. Describe what you want and this polls
          <b>${escapeHtml(region)}</b> until it appears — the same matching the
          <code>lagotto</code> CLI does, running in this tab against your own account.</p>
        <p class="lagotto-hint lagotto-hint-guided">The big GPUs are often all taken.
          Pick what you're waiting for and this checks <b>${escapeHtml(region)}</b>
          every minute until some appears, then tells you which zone to launch in.</p>
        <p class="lagotto-hint warn">A watch lives only as long as this tab. Closing it,
          reloading, or changing <b>${escapeHtml(LEVEL_CONTROL_NAME)}</b> in the header stops the watch — nothing
          keeps checking on your behalf, though ${
            // "your settings are kept" describes something a guided user never entered.
            // What's kept is the same thing either way; only the name for it changes.
            atLeast(ctx.level, "standard")
              ? "your settings are kept"
              : "what you picked is remembered"
          } and you'll be offered a one-click resume. For a watch that outlives a
          browser, use the <code>lagotto</code> CLI.</p>
      </div>

      <form class="lagotto-form">
        <div class="lagotto-fields">
        <div class="lagotto-field lagotto-field-wide">
          <label for="lg-pattern">Instance types</label>
          <input id="lg-pattern" class="lagotto-pattern" type="text" value="p5.*"
                 placeholder="p5.*" autocomplete="off" spellcheck="false" required />
          <span class="lagotto-fieldhint">Glob (<code>p5.*</code>) or a regex</span>
        </div>
        <div class="lagotto-field">
          <label for="lg-maxprice">Max $/hr</label>
          <input id="lg-maxprice" class="lagotto-maxprice" type="number" min="0" step="0.01"
                 placeholder="any" />
          <span class="lagotto-fieldhint lagotto-pricehint">blank = no cap</span>
        </div>
        <div class="lagotto-field">
          <label for="lg-azs">Only these AZs</label>
          <input id="lg-azs" class="lagotto-azs" type="text" placeholder="any"
                 autocomplete="off" spellcheck="false" />
          <span class="lagotto-fieldhint">comma-separated, in preference order</span>
        </div>
        <div class="lagotto-field">
          <label for="lg-interval">Check every</label>
          <select id="lg-interval" class="lagotto-interval">
            ${INTERVALS.map((i) => `<option value="${i.ms}"${i.ms === 60_000 ? " selected" : ""}>${i.label}</option>`).join("")}
          </select>
        </div>
        </div>
        <div class="lagotto-controls">
        <label class="lagotto-check">
          <input class="lagotto-spot" type="checkbox" /> Spot capacity (price by AZ)
        </label>
        <div class="lagotto-actions">
          <button type="submit" class="lagotto-start">Start watching</button>
          <button type="button" class="lagotto-stop" hidden>Stop</button>
          <button type="button" class="lagotto-once">Check once</button>
        </div>
        </div>
      </form>

      <!-- Resume BEFORE the picker, not after. At standard the picker is empty and the
           order is unobservable; at guided the card list is ~1000px tall, so a notice
           below it sits under the fold — telling a returning user their watch stopped
           somewhere they will never look. Verified in a browser, not inferred: the
           unit tests assert presence and can't see position. -->
      <div class="lagotto-resume" hidden></div>
      <div class="lagotto-picker"></div>
      <div class="lagotto-result" aria-live="polite"></div>
      <ol class="lagotto-log" aria-live="polite"></ol>`;
    host.appendChild(root);

    const form = root.querySelector<HTMLFormElement>(".lagotto-form")!;
    const patternEl = root.querySelector<HTMLInputElement>(".lagotto-pattern")!;
    const maxPriceEl = root.querySelector<HTMLInputElement>(".lagotto-maxprice")!;
    const azsEl = root.querySelector<HTMLInputElement>(".lagotto-azs")!;
    const intervalEl = root.querySelector<HTMLSelectElement>(".lagotto-interval")!;
    const spotEl = root.querySelector<HTMLInputElement>(".lagotto-spot")!;
    const startBtn = root.querySelector<HTMLButtonElement>(".lagotto-start")!;
    const stopBtn = root.querySelector<HTMLButtonElement>(".lagotto-stop")!;
    const onceBtn = root.querySelector<HTMLButtonElement>(".lagotto-once")!;
    const resume = root.querySelector<HTMLElement>(".lagotto-resume")!;
    const result = root.querySelector<HTMLElement>(".lagotto-result")!;
    const log = root.querySelector<HTMLElement>(".lagotto-log")!;

    let aborter: AbortController | null = null;
    // True once the watch was ended by something other than the user: a re-mount
    // (dispose) or credential expiry. Both are cases where "your watch stopped"
    // is news, so the `watching` flag must survive into the next mount.
    let interrupted = false;

    // ── Surviving a re-mount ──────────────────────────────────────────────────
    //
    // Changing Mode re-mounts this surface (that IS how a level change propagates),
    // and dispose() aborts the poll. What shipped therefore killed a running watch
    // and handed back a blank form — the user lost both the watch and the four
    // fields describing it, with nothing saying so. Issue #513: "either the watch
    // should survive the remount, or the surface should say what happened — the
    // current behaviour is the worst of both."
    //
    // The form is restored from the hash, following costs/truffle/teams. The poll is
    // NOT auto-resumed, and that asymmetry is deliberate: truffle's `?q=` is
    // replayable data, whereas a watch is a live loop billing DescribeInstanceType-
    // Offerings against the user's account every interval. Silently restarting it on
    // a mount the user didn't ask for — including a bookmark opened tomorrow, since
    // the hash outlives the tab — spends their money on their behalf. So the params
    // come back, the loop doesn't, and a Resume button says exactly what happened.
    //
    // Scope, stated plainly: the hash belongs to the *route*, so this covers a Mode
    // change and a reload of #/lagotto — the reported case — and not navigating to
    // another surface, which replaces the hash before dispose() runs. Same boundary
    // as truffle's `?q=` and costs' `?days=`; a store that survived navigation would
    // be a different mechanism, not a bigger version of this one.
    const fields = { pattern: patternEl, max: maxPriceEl, azs: azsEl } as const;
    for (const [key, el] of Object.entries(fields)) {
      const v = readHashParam(key);
      if (v !== null) el.value = v;
    }
    const urlEvery = Number(readHashParam("every"));
    if (INTERVALS.some((i) => i.ms === urlEvery)) intervalEl.value = String(urlEvery);
    spotEl.checked = readHashParam("spot") === "1";

    /** Mirror the form into the hash. Defaults are omitted so the URL stays short. */
    function saveForm(): void {
      writeHashParams({
        pattern: patternEl.value.trim() || null,
        max: maxPriceEl.value.trim() || null,
        azs: azsEl.value.trim() || null,
        every: Number(intervalEl.value) === DEFAULT_INTERVAL_MS ? null : intervalEl.value,
        spot: spotEl.checked ? "1" : null,
      });
    }

    /**
     * Tell the user their watch stopped, and offer one click to restart it.
     *
     * Only shown when a watch was actually running when the surface went away —
     * `watching=1` is written on start and cleared on every other exit (stop, match,
     * error, session expiry), so this can't fire for someone who merely filled the
     * form in and navigated off.
     */
    function showResumeIfInterrupted(): void {
      if (readHashParam("watching") !== "1") return;
      // Consume the flag: the user has now been told. Leaving it set would replay
      // "your watch stopped" on every later mount, including ones where nothing was
      // running — and a notice that cries wolf is one the user learns to ignore.
      writeHashParams({ watching: null });
      resume.hidden = false;
      resume.className = "lagotto-resume";
      // Deliberately does not name a cause. The flag survives a Mode change, a
      // reload, and a re-sign-in after expiry; "when you changed Mode" would be
      // wrong in two of the three, and the actionable part is identical in all.
      //
      // Guided gets a different second sentence because the form it refers to isn't on
      // screen at that level. Naming the type instead is the better answer anyway: it's
      // the one fact the user needs to decide whether to resume, and at guided they
      // never typed it, so "as you left them" would describe something they never did.
      const what = patternEl.value.trim();
      const reassure =
        guided && what
          ? `Still waiting for <code>${escapeHtml(what)}</code>.`
          : "Your settings below are as you left them.";
      resume.innerHTML = `<span>Your watch was stopped — nothing has been checking since.
        ${reassure}</span>
        <button type="button" class="lagotto-resume-go">Resume watching</button>`;
      resume.querySelector<HTMLButtonElement>(".lagotto-resume-go")!.addEventListener("click", () => {
        resume.hidden = true;
        void startWatching();
      });
    }

    /** Read the form into a lagotto Watch. Throws on an invalid pattern. */
    function readWatch(): Watch {
      const azs = azsEl.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const maxPrice = maxPriceEl.value.trim() === "" ? undefined : Number(maxPriceEl.value);
      return {
        // The browser holds no watch store, so the id is just for display.
        watchId: `tab-${region}-${patternEl.value.trim()}`,
        instanceTypePattern: patternEl.value.trim(),
        regions: [region],
        ...(azs.length ? { availabilityZones: azs } : {}),
        ...(spotEl.checked ? { spot: true } : {}),
        ...(maxPrice !== undefined && Number.isFinite(maxPrice) && maxPrice > 0 ? { maxPrice } : {}),
      };
    }

    // ── Guided mode ───────────────────────────────────────────────────────────
    //
    // The form asks for a glob or a regex over instance-type names, an AZ list, and a
    // price cap in $/hr. Every one of those is only writable by someone who already
    // knows the answer — which makes this the surface where the guided/standard split
    // matters most, not least: a user who *needs* this page is by definition someone
    // whose launch just failed for capacity, and at that moment "p5.*" is exactly the
    // string they don't have.
    //
    // So guided swaps the fields for the same curated cards the truffle and instances
    // surfaces use, over WATCH_SHAPES rather than GUIDED_SHAPES — you do not wait for
    // a t4g.xlarge, and offering one would be offering a poll that always succeeds
    // immediately. Picking a card resolves a real instance type through the offline
    // catalog, fills the form with its *family* glob, and starts the watch.
    //
    // The form is hidden rather than absent, and that is load-bearing rather than
    // laziness: the picker writes into it, `readWatch()` reads out of it, and the
    // hash restore + Resume path from #513 keeps working at every level without a
    // second code path. One state, one reader.
    const guided = !atLeast(ctx.level, "standard");
    const picker = root.querySelector<HTMLElement>(".lagotto-picker")!;
    let disposePicker: (() => void) | null = null;

    function setRunning(running: boolean): void {
      // At guided the picker IS the start control, so a bare "Start watching" above
      // no visible fields would be a button with nothing to describe what it starts.
      startBtn.hidden = running || guided;
      stopBtn.hidden = !running;
      onceBtn.disabled = running;
      for (const el of [patternEl, maxPriceEl, azsEl, intervalEl, spotEl]) el.disabled = running;
      // Choosing a second shape mid-watch would abandon the first without saying so.
      // Hiding the cards while one is running makes Stop the only way forward, which
      // is the honest shape of "one watch per tab".
      if (guided) picker.hidden = running;
    }

    // What "Max $/hr" is compared against differs by an order of trustworthiness
    // between the two modes, and the difference decides whether the cap works:
    // a Spot watch prices live per AZ, while an on-demand watch is compared against
    // truffle-ts's static us-east-1 table. Outside us-east-1 that makes the
    // on-demand cap approximate — a cost guard that doesn't quite guard — and
    // that fact previously existed only in a comment on portalCapacityFinder.
    const priceHint = root.querySelector<HTMLElement>(".lagotto-pricehint")!;
    const syncPriceHint = (): void => {
      priceHint.textContent = spotEl.checked
        ? "blank = no cap; compared against live Spot prices"
        : `blank = no cap; compared against a static us-east-1 estimate${
            region === "us-east-1" ? "" : ` — approximate in ${region}`
          }`;
    };
    spotEl.addEventListener("change", syncPriceHint);
    syncPriceHint();

    function appendLog(text: string): void {
      const li = document.createElement("li");
      li.textContent = text; // AWS-derived strings → textContent
      log.prepend(li);
      // Keep the tail bounded; a 30s watch left open all afternoon is ~500 checks.
      while (log.children.length > 50) log.lastElementChild!.remove();
    }

    function showMatch(m: MatchResult, spot: boolean): void {
      const azs = m.candidateAzs.length ? m.candidateAzs.join(", ") : "—";
      // What to do next differs by level, because what's *available* next differs.
      // Guided mode's Instances page offers five launch shapes, and only the H100 one
      // overlaps this list — so telling a guided user who just waited for a B200 to
      // "launch it from Instances" would send them to a picker that can't. Naming the
      // control that can is the difference between an answer and a dead end.
      //
      // Not fixed by adding B200 cards to the launch picker: a $114/hr machine behind a
      // beginner's single click is a deliberate omission there, not an oversight here.
      const next = guided
        ? `<p class="lagotto-match-next"><code>${escapeHtml(m.instanceType)}</code> is
             free in <b>${escapeHtml(m.availabilityZone || m.region)}</b> right now.
             To launch this exact type, switch
             <b>${escapeHtml(LEVEL_CONTROL_NAME)}</b> to Standard and use
             <a href="#/instances">Instances</a>. Capacity can vanish within minutes,
             so it's worth doing now.</p>`
        : `<p class="lagotto-match-next">Capacity is available now — launch it from
             <a href="#/instances">Instances</a>. Availability can vanish between this
             check and a launch; retry the next zone above on
             <code>InsufficientInstanceCapacity</code>.</p>`;
      result.className = "lagotto-result found";
      result.innerHTML = `
        <div class="lagotto-match">
          <div class="lagotto-match-head">
            <span class="lagotto-match-type">${escapeHtml(m.instanceType)}</span>
            <span class="lagotto-match-kind">${spot ? "Spot" : "on-demand"}</span>
            <span class="lagotto-match-price">${m.price != null ? `$${m.price.toFixed(4)}/hr` : "price unknown"}</span>
          </div>
          <dl class="lagotto-match-meta">
            <dt>Region</dt><dd>${escapeHtml(m.region)}</dd>
            <dt>Zone</dt><dd>${escapeHtml(m.availabilityZone || "—")}</dd>
            <dt>Also offered in</dt><dd>${escapeHtml(azs)}</dd>
          </dl>
          ${next}
        </div>`;
    }

    function showError(msg: string): void {
      result.className = "lagotto-result error";
      result.textContent = msg;
    }

    async function checkOnce(): Promise<void> {
      let watch: Watch;
      try {
        watch = readWatch();
      } catch (err) {
        showError((err as Error).message);
        return;
      }
      onceBtn.disabled = true;
      result.className = "lagotto-result";
      result.textContent = "checking…";
      try {
        const m = await watcher.check(watch);
        if (m) showMatch(m, Boolean(watch.spot));
        else {
          result.className = "lagotto-result";
          result.textContent = `No matching capacity in ${region} right now.`;
        }
      } catch (err) {
        showError(describeAwsError(err));
      } finally {
        onceBtn.disabled = false;
      }
    }

    async function startWatching(): Promise<void> {
      let watch: Watch;
      try {
        watch = readWatch();
      } catch (err) {
        showError((err as Error).message);
        return;
      }
      const intervalMs = Number(intervalEl.value);
      aborter = new AbortController();
      setRunning(true);
      // Save unconditionally here, not just on `input`: a user who accepts every
      // default and hits Start has fired no input event, so without this the one
      // case with a live watch to lose would be the one with nothing persisted.
      saveForm();
      // Recorded while the poll is live so a re-mount can tell "your watch was
      // interrupted" from "you never started one". Cleared in the finally below,
      // which every exit path runs through.
      writeHashParams({ watching: "1" });
      resume.hidden = true;
      log.replaceChildren();
      result.className = "lagotto-result";
      result.textContent = `Watching ${watch.instanceTypePattern} in ${region}…`;
      try {
        const m = await watcher.poll(watch, {
          intervalMs,
          signal: aborter.signal,
          onCheck: (r, n) => {
            appendLog(r ? `check ${n}: found ${r.instanceType} in ${r.availabilityZone || r.region}` : `check ${n}: no capacity yet`);
          },
        });
        if (m) showMatch(m, Boolean(watch.spot));
        else if (!aborter.signal.aborted) {
          result.className = "lagotto-result";
          result.textContent = "Watch ended without a match.";
        }
      } catch (err) {
        showError(describeAwsError(err));
      } finally {
        aborter = null;
        setRunning(false);
        // Not cleared when the watch was interrupted rather than stopped: that is
        // precisely the case the next mount needs to know about. Clearing it here
        // would also let this settling promise write to the hash of whatever
        // surface replaced us, which is not ours to touch.
        if (!interrupted) writeHashParams({ watching: null });
      }
    }

    function stopWatching(): void {
      aborter?.abort();
      result.className = "lagotto-result";
      result.textContent = "Stopped.";
    }

    const onSubmit = (e: Event) => {
      e.preventDefault();
      void startWatching();
    };
    const onOnce = () => void checkOnce();
    // `input` on the whole form covers all four fields and the checkbox, including a
    // paste and an autofill, which a per-element keyup would miss.
    const onInput = () => saveForm();
    form.addEventListener("submit", onSubmit);
    form.addEventListener("input", onInput);
    form.addEventListener("change", onInput); // <select> and the checkbox
    stopBtn.addEventListener("click", stopWatching);
    onceBtn.addEventListener("click", onOnce);

    if (guided) {
      // The initial state has to be set here too, not only in setRunning: nothing calls
      // setRunning until a watch starts, so a bare "Start watching" would sit above no
      // visible fields until the user clicked a card.
      startBtn.hidden = true;
      disposePicker = mountGuidedPicker(picker, {
        shapes: WATCH_SHAPES,
        heading: "What are you waiting for?",
        hint: "Pick the closest match. We'll watch for anything in that family — a smaller one in the same family is still a machine you can use.",
        // Not "I know what I need": the thing one level up is a pattern field, and the
        // user who wants it wants to name types, not to be told they know things.
        escapeLabel: "Let me name the instance types →",
        // The cards must NOT say "about $X for 2 hours" here. That sentence describes a
        // run, and this page starts no run — it starts a poll, which is free. What the
        // price is for is deciding whether to want the thing at all, so it's rendered
        // as a rate with what it would cost over a day, since capacity you're waiting
        // for is capacity you plan to hold.
        costLine: (rec) => watchCostLine(rec),
        onChoose: (choice) => {
          // Write the resolved family into the form and start. The form stays the one
          // source of truth (see setRunning), so the hash persistence, the Resume
          // notice and readWatch() all keep working with no guided-specific path.
          patternEl.value = watchPattern(choice.rec);
          maxPriceEl.value = "";
          azsEl.value = "";
          spotEl.checked = false;
          syncPriceHint();
          void startWatching();
        },
        onEscape: () => ctx.session.setLevel("standard"),
      });
    }

    showResumeIfInterrupted();

    // Federated creds are what the EC2 client signs with — a poll that outlives
    // them would just log AuthFailure every interval, so stop and say why.
    const offExpiry = ctx.session.onExpiry((state) => {
      if (state === "expired") {
        // Interrupted, not stopped: the watch the user asked for is still wanted,
        // so keep `watching=1` and let the mount after re-sign-in offer Resume.
        if (aborter) interrupted = true;
        aborter?.abort();
        showError("Session expired — sign in again to keep watching.");
      }
    });

    return {
      dispose() {
        // Set before the abort so startWatching's finally can tell a dispose-driven
        // abort (leave `watching=1` for the next mount) from a user Stop.
        interrupted = true;
        disposePicker?.();
        offExpiry();
        aborter?.abort();
        form.removeEventListener("submit", onSubmit);
        form.removeEventListener("input", onInput);
        form.removeEventListener("change", onInput);
        stopBtn.removeEventListener("click", stopWatching);
        onceBtn.removeEventListener("click", onOnce);
        ec2.destroy();
        root.remove();
      },
    };
  },
};

/**
 * The cost line on a guided watch card.
 *
 * The launch flow's "about $110 for 2 hours" is wrong here in a way that matters:
 * this page starts a poll, not a run, and the poll is free. What the figure is *for*
 * is deciding whether you want the thing at all — so it leads with the rate, and
 * gives the per-day figure because capacity you queued for is capacity you intend to
 * hold, and a day is the unit these machines get held for.
 *
 * An unknown price says so, and on this list that isn't an edge case: the p5e (H200)
 * family carries no on-demand row at all, and the unpriced families are precisely
 * the scarce ones this page exists for. Rendering nothing would read as free on the
 * most expensive hardware AWS rents.
 */
function watchCostLine(rec: GuidedRecommendation): string {
  if (rec.pricePerHour == null) {
    return `<span class="guided-card-cost unknown">no listed price for this family —
      these are usually the most expensive machines available, so check AWS pricing
      before you launch one</span>`;
  }
  const est = rec.priceIsEstimate ? ", estimated" : "";
  const perDay = rec.pricePerHour * 24;
  return `<span class="guided-card-cost">$${rec.pricePerHour.toFixed(2)}/hr once you
    launch it${est} — about $${Math.round(perDay).toLocaleString("en-US")} a day.
    Watching costs nothing.</span>`;
}

// ── The CapacityFinder seam, implemented over the EC2 API ─────────────────────

/** Cap on instance types carried into a Spot-pricing query (API + latency guard). */
const SPOT_QUERY_CAP = 60;

/** Spot lookback: enough history that every AZ has reported at least once. */
const SPOT_LOOKBACK_MS = 60 * 60 * 1000;

/**
 * lagotto's CapacityFinder over one region, built from the two EC2 calls Go
 * truffle uses: DescribeInstanceTypeOfferings at AZ granularity for "what is
 * offered where", and DescribeSpotPriceHistory for a Spot watch's prices.
 *
 * On-demand prices come from truffle-ts's static table (`onDemandPrice`), NOT the
 * Pricing API — the portal's federated role has no `pricing:*`, and the price
 * only gates the watch's maxPrice comparison. It's a us-east-1 "as of" estimate,
 * so a maxPrice on an on-demand watch is approximate; a Spot watch prices live.
 */
function portalCapacityFinder(ec2: EC2Client, region: string): CapacityFinder {
  return {
    async search(matcher: RegExp): Promise<FinderInstanceType[]> {
      // AZ-level offerings, so a match can name the zone to launch in. EC2's
      // instance-type filter takes shell wildcards, so a glob pattern is pushed
      // server-side (a region has ~800 types × ~6 AZs otherwise); the regex is
      // still applied locally, which is authoritative.
      const wildcard = toEc2Wildcard(matcher.source);
      const azsByType = new Map<string, string[]>();
      let token: string | undefined;
      do {
        const page = await ec2.send(
          new DescribeInstanceTypeOfferingsCommand({
            LocationType: "availability-zone",
            ...(wildcard ? { Filters: [{ Name: "instance-type", Values: [wildcard] }] } : {}),
            MaxResults: 1000,
            NextToken: token,
          }),
        );
        for (const o of page.InstanceTypeOfferings ?? []) {
          if (!o.InstanceType || !o.Location) continue;
          if (!matcher.test(o.InstanceType)) continue;
          const list = azsByType.get(o.InstanceType);
          if (list) list.push(o.Location);
          else azsByType.set(o.InstanceType, [o.Location]);
        }
        token = page.NextToken;
      } while (token);

      return Array.from(azsByType, ([instanceType, azs]) => ({
        instanceType,
        region,
        onDemandPrice: onDemandPrice(instanceType),
        // Sorted so the AZ a match reports is stable across checks rather than
        // following the API's page order.
        availableAZs: azs.sort(),
      }));
    },

    async getSpotPricing(instances: FinderInstanceType[]): Promise<FinderSpotPrice[]> {
      const types = Array.from(new Set(instances.map((i) => i.instanceType))).slice(0, SPOT_QUERY_CAP);
      if (types.length === 0) return [];
      const page = await ec2.send(
        new DescribeSpotPriceHistoryCommand({
          // The SDK types InstanceTypes as its generated enum; these names come
          // from a live DescribeInstanceTypeOfferings response, so they're valid
          // EC2 type names even when newer than the SDK's enum.
          InstanceTypes: types as _InstanceType[],
          ProductDescriptions: ["Linux/UNIX"],
          StartTime: new Date(Date.now() - SPOT_LOOKBACK_MS),
        }),
      );
      // History is a time series per (type, AZ); keep only the LATEST point for
      // each, which is the current price. Mirrors Go truffle's default path.
      const latest = new Map<string, { at: number; price: FinderSpotPrice }>();
      for (const p of page.SpotPriceHistory ?? []) {
        if (!p.InstanceType || !p.AvailabilityZone || !p.SpotPrice) continue;
        const spotPrice = Number.parseFloat(p.SpotPrice);
        if (!Number.isFinite(spotPrice)) continue;
        const at = p.Timestamp?.getTime() ?? 0;
        const key = `${p.InstanceType}@${p.AvailabilityZone}`;
        const prev = latest.get(key);
        if (prev && prev.at >= at) continue;
        latest.set(key, {
          at,
          price: { instanceType: p.InstanceType, region, spotPrice, availabilityZone: p.AvailabilityZone },
        });
      }
      return Array.from(latest.values(), (v) => v.price);
    },
  };
}

/**
 * The EC2 `instance-type` filter value for a compiled pattern, or null when the
 * pattern can't be expressed as a shell wildcard (a real regex) and every type
 * must be fetched and filtered locally.
 *
 * lagotto compiles a glob to an anchored regex (`p5.*` → `^p5\..*$`), so this
 * inverts exactly that shape and bails on anything else.
 */
function toEc2Wildcard(source: string): string | null {
  const m = /^\^(.*)\$$/.exec(source);
  if (!m) return null;
  const body = m[1]!;
  // Only the escapes lagotto's glob→regex conversion produces: `\.` and `.*`.
  if (/[[\]()+?{}|^$]/.test(body.replace(/\\\./g, "").replace(/\.\*/g, ""))) return null;
  if (/(?<!\\)\.(?!\*)/.test(body)) return null; // a bare `.` wildcard — not a glob
  return body.replace(/\.\*/g, "*").replace(/\\\./g, ".");
}

/** AWS SDK errors are noisy; surface the actionable part. */
function describeAwsError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === "UnauthorizedOperation" || e?.name === "AccessDenied" || e?.name === "AccessDeniedException") {
    return "Your role can't read instance-type offerings in this account (needs ec2:DescribeInstanceTypeOfferings).";
  }
  if (e?.name === "AuthFailure" || e?.name === "ExpiredTokenException") {
    return "Credentials are no longer valid — sign in again.";
  }
  return e?.message ?? String(err);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
