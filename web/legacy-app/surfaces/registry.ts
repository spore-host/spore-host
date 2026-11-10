// The ordered list of tool surfaces the portal shows. This is the ONLY file that
// changes when a tool joins the portal: add its dep + one surfaces/<tool>.ts, then
// append a lazy() entry here. The shell renders whatever is in this array.
//
// Slice 1 shipped instances (spawn). Slice 2 adds truffle (offline catalog browse,
// no-auth) and terminal (SSM shell). Each surface is LAZILY loaded: the metadata
// (id/label/accent/requiresAuth) is eager and tiny, but the mount implementation —
// which drags in the heavy deps (xterm + the SSM/STS SDK for terminal, the bundled
// catalog for truffle, EC2 SDK for instances) — is code-split behind a dynamic
// import() and only fetched when the user first opens that surface. So the initial
// portal load stays lean and the terminal's xterm bundle never loads until needed.
import type { Disposable, SurfaceContext, ToolSurface } from "./types.js";
import { experimentalChat } from "../features.js";

// Metadata + a loader that resolves to the real ToolSurface module. `lazy` wraps
// it so the shell still sees a plain ToolSurface (mount() awaits the import).
interface LazyEntry {
  id: string;
  label: string;
  accent: string;
  requiresAuth: boolean;
  load: () => Promise<{ mount: ToolSurface["mount"] }>;
}

function lazy(e: LazyEntry): ToolSurface {
  return {
    id: e.id,
    label: e.label,
    accent: e.accent,
    requiresAuth: e.requiresAuth,
    async mount(host: HTMLElement, ctx: SurfaceContext): Promise<Disposable> {
      const mod = await e.load();
      return mod.mount(host, ctx);
    },
  };
}

// Chat-platform surfaces: shown only in a build with VITE_EXPERIMENTAL_CHAT=true
// (see ../features.ts). Walled off for 1.0 (spore-host#611); kept, not deleted.
// The "teams" surface below is spore.host team sharing, not Microsoft Teams,
// so it is not one of these and stays.
//
// The condition reads import.meta.env.VITE_EXPERIMENTAL_CHAT directly, not through
// a helper, because Vite substitutes that exact expression at build time. A
// default build then sees `undefined === "true"`, drops the branch, and never
// emits the Slack chunk at all, rather than shipping an unreachable one.
const chatSurfaces: ToolSurface[] =
  import.meta.env.VITE_EXPERIMENTAL_CHAT === "true"
    ? [
        lazy({
          id: "slack",
          label: "Slack",
          accent: "--bot",
          requiresAuth: false,
          load: () => import("./slack.js").then((m) => ({ mount: m.slackSurface.mount })),
        }),
      ]
    : [];

/**
 * The registry for a build: the chat surfaces (none, unless the build opted in)
 * sit after Teams, where Slack always was, and only when `chat` is true.
 */
export function buildSurfaces(chat: boolean): ToolSurface[] {
  return [
    lazy({
      id: "instances",
      label: "Instances",
      accent: "--spawn",
      requiresAuth: true,
      load: () => import("./instances.js").then((m) => ({ mount: m.instancesSurface.mount })),
    }),
    lazy({
      id: "truffle",
      label: "Find instances",
      accent: "--truffle",
      requiresAuth: false,
      load: () => import("./truffle.js").then((m) => ({ mount: m.truffleSurface.mount })),
    }),
    lazy({
      id: "terminal",
      label: "Terminal",
      accent: "--spored",
      requiresAuth: true,
      load: () => import("./terminal.js").then((m) => ({ mount: m.terminalSurface.mount })),
    }),
    lazy({
      id: "costs",
      label: "Cost history",
      accent: "--spawn",
      requiresAuth: true,
      load: () => import("./costs.js").then((m) => ({ mount: m.costsSurface.mount })),
    }),
    lazy({
      id: "catalog",
      label: "Software catalog",
      accent: "--strata",
      // Static and shared, so readable without an account — see the comment on
      // catalogSurface. The API serves GET /api/strata/catalog unauthenticated.
      requiresAuth: false,
      load: () => import("./catalog.js").then((m) => ({ mount: m.catalogSurface.mount })),
    }),
    lazy({
      id: "teams",
      label: "Teams",
      accent: "--lagotto",
      requiresAuth: true,
      load: () => import("./teams.js").then((m) => ({ mount: m.teamsSurface.mount })),
    }),
    ...(chat ? chatSurfaces : []),
    lazy({
      id: "lagotto",
      label: "Watch capacity",
      accent: "--lagotto",
      requiresAuth: true,
      load: () => import("./lagotto.js").then((m) => ({ mount: m.lagottoSurface.mount })),
    }),
    lazy({
      id: "connect",
      label: "Connect account",
      accent: "--bot",
      requiresAuth: false,
      load: () => import("./onboarding.js").then((m) => ({ mount: m.onboardingSurface.mount })),
    }),
  ];
}

export const surfaces: ToolSurface[] = buildSurfaces(experimentalChat());

export function findSurface(id: string): ToolSurface | undefined {
  return surfaces.find((s) => s.id === id);
}
