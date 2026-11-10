// The spawn surface: launch / list / terminate EC2 in the signed-in account,
// entirely browser-native. Mounts the prebuilt Dashboard from
// @spore-host/spawn-ts/ui (launch form, live cards, meters, orphans, sweeps,
// embedded truffle picker), driven by a SpawnClient over EC2Provider.
import { SpawnClient } from "@spore-host/spawn-ts";
import { EC2Provider } from "@spore-host/spawn-ts";
import { Dashboard, confirmDialog } from "@spore-host/spawn-ts/ui";
// The Dashboard's own component styles (tokens scoped to .dashboard/.modal-backdrop,
// so they don't fight the portal's brand theme). Loaded with the instances chunk.
import "@spore-host/spawn-ts/ui/style.css";
import type { Disposable, SurfaceContext, ToolSurface } from "./types.js";
import { atLeast } from "../disclosure.js";
import { mountGuidedLaunch } from "../guided/launch.js";
import { readHashParam } from "../hashstate.js";

export const instancesSurface: ToolSurface = {
  id: "instances",
  label: "Instances",
  accent: "--spawn",
  requiresAuth: true,

  async mount(host: HTMLElement, ctx: SurfaceContext): Promise<Disposable> {
    const creds = ctx.session.getCreds();
    if (!creds) throw new Error("instances surface mounted without a session");

    const client = new SpawnClient({
      provider: new EC2Provider({
        region: ctx.session.region,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        // Required for launched instances to self-terminate and call the infra
        // DNS Lambda (spored reads spawn:* tags via this profile).
        iamInstanceProfile: "spored-instance-profile",
      }),
    });
    client.startMonitor();

    // Guided mode replaces the Dashboard's launch form with the picker + a single
    // confirmation, but keeps the instance list: a beginner still needs to see
    // what's running and be able to stop it — hiding that would be the one
    // simplification that costs real money.
    //
    // The Dashboard's own form is not conditionally rendered here (it lives inside
    // the prebuilt component in spawn-ts). At `guided` we hide it via a class on
    // the container and mount ours above; from `standard` up the Dashboard is
    // untouched. Doing it in CSS rather than reaching into the component's DOM
    // keeps this surface out of spawn-ts's internals.
    const guided = !atLeast(ctx.level, "standard");

    const dashboard = new Dashboard(client, confirmDialog);
    let disposeGuided: (() => void) | null = null;

    if (guided) {
      host.classList.add("guided-instances");
      const panel = document.createElement("div");
      host.appendChild(panel);
      // `#/instances?shape=big-gpu` — the truffle surface's picker hands the choice
      // over rather than making the user repeat it here.
      const shapeId = readHashParam("shape");
      disposeGuided = mountGuidedLaunch(panel, {
        client,
        region: ctx.session.region,
        onEscape: () => ctx.session.setLevel("standard"),
        ...(shapeId ? { initialShapeId: shapeId } : {}),
      });
    }
    host.appendChild(dashboard.el);

    // Tear the client's polling down if the session's creds expire.
    const offExpiry = ctx.session.onExpiry((state) => {
      if (state === "expired") client.stopMonitor();
    });

    return {
      dispose() {
        offExpiry();
        client.stopMonitor();
        disposeGuided?.();
        host.classList.remove("guided-instances");
        dashboard.el.remove();
      },
    };
  },
};
