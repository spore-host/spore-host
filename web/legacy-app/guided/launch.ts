// The guided launch panel: the picker, then one confirmation showing what it is,
// what it costs, and when it shuts itself off. Then a single button.
//
// It launches through the SAME SpawnClient the Dashboard is driven by, so the
// resulting instance appears in the Dashboard's own list via its existing event
// subscription. No second list, no polling of our own — the composition is the
// point, and duplicating the list is how the two views drift apart.

import type { SpawnClient } from "@spore-host/spawn-ts";
import { mountGuidedPicker, type GuidedChoice, type GuidedPickerOptions } from "./picker.js";
import { GUIDED_SHAPES, resolveShape } from "./shapes.js";
import { CATALOG_PRICE_REGION, costLimitFor } from "./cost.js";

export interface GuidedLaunchOptions {
  client: SpawnClient;
  /** The region, shown in the confirmation — a cost figure without a region is half a fact. */
  region: string;
  /** "I know what I need" — hand control back to the caller (raise the level). */
  onEscape(): void;
  /**
   * Catalog lookup and shape list, forwarded to the picker. Injected for the same
   * reason picker.ts takes them: the unknown-price branch is unreachable through the
   * real catalog, and it's the branch that gates the launch button on the machines
   * that cost the most per hour — so it must be testable.
   */
  finder?: GuidedPickerOptions["finder"];
  shapes?: GuidedPickerOptions["shapes"];
  /**
   * Skip the picker and open the confirmation for this shape id.
   *
   * The truffle surface's guided picker is auth-free and cannot launch, so it hands
   * over to this surface — and without carrying the choice, the user who picked
   * "A big GPU for training" arrived at an identical picker asking the same question
   * again. Unknown ids fall back to the picker rather than erroring: this comes from
   * the URL, so a stale bookmark is expected input, not a fault.
   */
  initialShapeId?: string;
}

/** Render the guided launch flow into `host`. Returns a dispose fn. */
export function mountGuidedLaunch(host: HTMLElement, opts: GuidedLaunchOptions): () => void {
  const root = document.createElement("div");
  root.className = "guided-launch";
  host.appendChild(root);

  let disposeStep: (() => void) | null = null;
  let live = true;

  const showPicker = (): void => {
    disposeStep?.();
    root.innerHTML = "";
    disposeStep = mountGuidedPicker(root, {
      onChoose: (choice) => showConfirm(choice),
      onEscape: opts.onEscape,
      ...(opts.finder ? { finder: opts.finder } : {}),
      ...(opts.shapes ? { shapes: opts.shapes } : {}),
    });
  };

  const showConfirm = (choice: GuidedChoice): void => {
    disposeStep?.();
    disposeStep = null;
    const { shape, rec } = choice;
    const i = rec.pick.instance;

    const limit = costLimitFor(rec.pricePerHour, shape.defaultTtlHours);
    const priceUnknown = rec.pricePerHour == null;

    // The cost line is deliberately the total, and deliberately says "up to":
    // the TTL is a ceiling, not a prediction — an instance that finishes early
    // and is stopped costs less, and promising the exact figure would be wrong in
    // the user's favour right up until it wasn't.
    //
    // "compute only" is not a hedge for its own sake. The figure is
    // onDemandPrice × hours, which excludes the EBS volume, data transfer and
    // anything the instance itself pulls — so "Up to $X" is a bound the number
    // does not actually bound, and saying so is cheaper than being wrong.
    const cost = priceUnknown
      ? `<p class="guided-cost unknown">We don't have a price for
           <code>${escapeHtml(i.instanceType)}</code> in the offline catalog, so we
           can't tell you what this costs — and machines without a listed price are
           usually the most expensive ones. Check the
           <a href="https://aws.amazon.com/ec2/pricing/on-demand/" target="_blank"
              rel="noopener">AWS pricing page</a> for
           <code>${escapeHtml(i.instanceType)}</code> before you launch.</p>`
      : `<p class="guided-cost">Up to <b>$${rec.estimatedTotal!.toFixed(2)}</b>
           — $${rec.pricePerHour!.toFixed(4)} per hour${
             rec.priceIsEstimate ? " (estimated)" : ""
           }, for at most ${shape.defaultTtlHours} hours. Compute only; storage and
           data transfer are extra.${regionCaveat(opts.region)}</p>`;

    // Two limits, and they fail differently, so both are named. The TTL is enforced
    // by the daemon on the instance; the spend cap is derived from the tags. Saying
    // only "it shuts down after N hours" is what the previous copy did, and it
    // promised an outcome the portal itself ships an orphan banner to catch.
    const stops = limit
      ? `after ${shape.defaultTtlHours} hours, or at $${limit} of spend — whichever
         comes first`
      : `after ${shape.defaultTtlHours} hours`;

    root.innerHTML = `
      <div class="guided-confirm">
        <h2>${escapeHtml(shape.label)}</h2>
        <dl class="guided-facts">
          <dt>Machine</dt><dd><code>${escapeHtml(i.instanceType)}</code> —
            ${i.vcpus} vCPU, ${(i.memoryMib / 1024).toFixed(0)} GiB${
              i.gpus ? `, ${i.gpus}× ${escapeHtml(i.gpuModel ?? "GPU")}` : ""
            }</dd>
          <dt>Region</dt><dd>${escapeHtml(opts.region)}</dd>
          <dt>Shuts down</dt><dd>automatically ${stops}</dd>
          <dt>Pricing</dt><dd>on-demand — not spot, so it won't be interrupted, and
            costs roughly three times what spot would</dd>
        </dl>
        ${cost}
        <p class="guided-reassure">The time limit runs on the machine itself, so it
          applies even if you close this tab. If that ever fails, the machine is
          flagged in the list below so you can stop it.</p>
        ${
          priceUnknown
            ? `<label class="guided-ack"><input type="checkbox" class="guided-ack-box">
                 I understand I don't know what this will cost</label>`
            : ""
        }
        <div class="guided-actions">
          <button class="guided-back" type="button">← Something else</button>
          <button class="guided-go" type="button"${priceUnknown ? " disabled" : ""}>Start it</button>
        </div>
        <button class="guided-escape" type="button">Show me all the options →</button>
        <div class="guided-msg" aria-live="polite"></div>
      </div>`;

    const back = root.querySelector<HTMLButtonElement>(".guided-back")!;
    const go = root.querySelector<HTMLButtonElement>(".guided-go")!;
    const msg = root.querySelector<HTMLElement>(".guided-msg")!;

    // The escape hatch belongs on this step too, not just the picker. This is the
    // moment the user learns what guided mode chose for them, so it's the moment
    // they discover it's too small — and without this the only way onward is back
    // to the same five cards.
    root
      .querySelector<HTMLButtonElement>(".guided-escape")!
      .addEventListener("click", () => opts.onEscape());

    // An unknown price is the one case where "Start it" is a bet rather than a
    // decision, and the shapes that land here are the accelerator ones — the
    // machines that cost more per hour than the others cost per day. So the button
    // stays disabled until the user says, in as many words, that they know.
    const ack = root.querySelector<HTMLInputElement>(".guided-ack-box");
    ack?.addEventListener("change", () => {
      go.disabled = !ack.checked;
    });

    back.addEventListener("click", () => showPicker());
    go.addEventListener("click", () => {
      go.disabled = true;
      back.disabled = true;
      msg.className = "guided-msg";
      msg.textContent = "Starting…";
      void opts.client
        .launch({
          name: instanceName(shape.id),
          instanceType: i.instanceType,
          region: opts.region,
          spot: false, // A beginner's first instance should not vanish mid-run.
          ttl: `${shape.defaultTtlHours}h`,
          // Pass the price through so the Dashboard's cost meter reflects THIS
          // instance rather than its hardcoded default. Zero when unknown is
          // correct here: it disables the meter's math instead of inventing a rate.
          pricePerHour: rec.pricePerHour ?? 0,
          // The second guard. TTL is enforced by spored *on the instance*, so an
          // instance whose daemon never starts is bounded by nothing — and the
          // Dashboard's orphan banner exists because that happens. A cost limit is
          // derived from the tags, so it survives the daemon failing, and it also
          // turns the Dashboard's bare cost figure into a meter against a ceiling.
          // Omitted (not zeroed) when the price is unknown: spawn-ts reads a
          // non-positive limit as "no limit".
          ...(limit != null ? { costLimit: limit } : {}),
        })
        .then((inst) => {
          if (!live) return;
          msg.className = "guided-msg ok";
          msg.textContent = `Started ${inst.name} (${inst.instanceId}). It's in the list below.`;
        })
        .catch((err: unknown) => {
          if (!live) return;
          // Show the real error. A guided user is the least able to diagnose a
          // vague one, so "couldn't start it" alone is the least helpful thing we
          // could say — quota and permission failures both land here and read
          // completely differently.
          msg.className = "guided-msg error";
          msg.textContent = `Couldn't start it: ${(err as Error).message}`;
          go.disabled = false;
          back.disabled = false;
        });
    });
  };

  // Jump straight to the confirmation when the caller carried a shape over. Resolved
  // here rather than in the picker so the picker stays a pure list-and-choose: this
  // is the same resolveShape() the cards use, on one shape.
  const jumpTo = (shapeId: string): void => {
    const shape = (opts.shapes ?? GUIDED_SHAPES).find((s) => s.id === shapeId);
    if (!shape) {
      showPicker();
      return;
    }
    // Show the picker meanwhile, so a slow catalog read isn't a blank panel — and so
    // a resolve failure leaves the user somewhere useful instead of nowhere.
    showPicker();
    void resolveShape(shape, opts.finder)
      .then((rec) => {
        if (!live) return;
        // resolveShape returns undefined for no-match. Don't open a confirmation for
        // a machine we couldn't find: the picker renders no-match and failure as the
        // distinct states they are (#63's invariant), so leave the user there.
        if (rec) showConfirm({ shape, rec });
      })
      .catch(() => {
        /* the picker is already mounted and shows its own error state */
      });
  };

  if (opts.initialShapeId) jumpTo(opts.initialShapeId);
  else showPicker();

  return () => {
    live = false;
    disposeStep?.();
    root.remove();
  };
}

/**
 * A name the user can recognise in the list later.
 *
 * Suffixed with a timestamp because a guided user will click the same shape twice
 * and two instances called "gpu" are indistinguishable in the list — which is
 * exactly the moment they need to tell them apart to terminate the right one.
 */
function instanceName(shapeId: string): string {
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
  return `${shapeId}-${stamp}`;
}

/**
 * The one clause that connects the price to the region shown above it.
 *
 * The confirmation renders the session's region and the catalog's price as two
 * adjacent facts, and they're only the same fact in us-east-1. Empty string there,
 * because a caveat that fires always is one nobody reads.
 */
function regionCaveat(region: string): string {
  if (region === CATALOG_PRICE_REGION) return "";
  return ` Priced for ${escapeHtml(CATALOG_PRICE_REGION)}; ${escapeHtml(
    region,
  )} may differ.`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
