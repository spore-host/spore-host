// The route table (brief §3, with the owner's noun "instance").
//
// Route ids are task words, never tool names. Nav order is fixed and never
// changes with sign-in; signed-out users see only the entries that need no
// account. A route whose slice has not shipped renders a stub naming its
// tracking issue; `navWhenStub: false` keeps it out of the nav until then
// (Watches appears only when slice 6 ships, brief §3).

export type Auth = "any" | "signed-in" | "signed-out";

export interface RouteDef {
  id: string;
  /** Path pattern. `:id` captures one segment. */
  path: string;
  /** Page title: the h1 and the first half of document.title. */
  title: string;
  auth: Auth;
  /** The slice issue that builds this page, while it is a stub. Undefined once built. */
  stubFor?: number;
  /** Nav label, if it has a nav entry. */
  nav?: string;
  /** Show the nav entry while the page is still a stub. */
  navWhenStub?: boolean;
  /** Matrix control id of the nav entry. */
  navControl?: string;
  /** The CLI command this page equals, for the footer. */
  cli?: string;
}

/** Slice tracking issues on spore-host/spore-host (#683 is Phase 0). */
export const SLICES = {
  signIn: 684,
  launch: 685,
  instances: 686,
  connect: 687,
  types: 688,
  watches: 689,
} as const;

export const ROUTES: RouteDef[] = [
  { id: "welcome", path: "/", title: "Welcome", auth: "signed-out", stubFor: SLICES.signIn },
  { id: "setup", path: "/setup", title: "Before you start", auth: "any", stubFor: SLICES.signIn, cli: "spawn onboard" },
  {
    id: "instances",
    path: "/instances",
    title: "Instances",
    auth: "signed-in",
    stubFor: SLICES.instances,
    nav: "Instances",
    navWhenStub: true,
    navControl: "nav.instances",
    cli: "spawn list",
  },
  { id: "instance", path: "/instances/:id", title: "Instance", auth: "signed-in", stubFor: SLICES.instances, cli: "spawn status <instance-id>" },
  { id: "launch", path: "/launch", title: "Launch an instance", auth: "signed-in", stubFor: SLICES.launch, cli: "spawn launch" },
  {
    id: "watches",
    path: "/watches",
    title: "Watches",
    auth: "signed-in",
    stubFor: SLICES.watches,
    nav: "Watches",
    navWhenStub: false,
    navControl: "nav.watches",
    cli: "lagotto list",
  },
  { id: "watch-new", path: "/watches/new", title: "New watch", auth: "signed-in", stubFor: SLICES.watches, cli: "lagotto watch" },
  { id: "watch", path: "/watches/:id", title: "Watch", auth: "signed-in", stubFor: SLICES.watches, cli: "lagotto status <watch-id>" },
  {
    id: "types",
    path: "/types",
    title: "Instance types and prices",
    auth: "any",
    stubFor: SLICES.types,
    nav: "Instance types",
    navWhenStub: true,
    navControl: "nav.types",
    cli: "truffle find",
  },
  {
    id: "spending",
    path: "/spending",
    title: "Spending",
    auth: "signed-in",
    stubFor: SLICES.instances,
    nav: "Spending",
    navWhenStub: true,
    navControl: "nav.spending",
    cli: "spawn cost",
  },
  { id: "help", path: "/help", title: "Help", auth: "any", stubFor: SLICES.signIn, nav: "Help", navWhenStub: true, navControl: "chrome.nav-help" },
  { id: "settings", path: "/settings", title: "Settings", auth: "signed-in" },
];

/** The 404 page. Not in ROUTES: it matches nothing and is what nothing matching renders. */
export const NOT_FOUND: RouteDef = { id: "not-found", path: "*", title: "We can't find that page", auth: "any" };

export interface Match {
  route: RouteDef;
  params: Record<string, string>;
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) {
      try {
        params[p[i].slice(1)] = decodeURIComponent(s[i]);
      } catch {
        return null;
      }
    } else if (p[i] !== s[i]) return null;
  }
  return params;
}

/**
 * Resolve a hash path to a route. A literal segment beats a parameter, so
 * /watches/new is never read as a watch with id "new". Unknown paths are 404.
 */
export function resolve(path: string, routes: RouteDef[] = ROUTES): Match {
  const normalised = path.replace(/\/+$/, "") || "/";
  const candidates = routes
    .map((route) => ({ route, params: matchPath(route.path, normalised) }))
    .filter((m): m is Match => m.params !== null)
    .sort((a, b) => Object.keys(a.params).length - Object.keys(b.params).length);
  return candidates[0] ?? { route: NOT_FOUND, params: {} };
}

/** The route to land on for an empty hash or a route the current sign-in state can't show. */
export function homeFor(signedIn: boolean): string {
  return signedIn ? "/instances" : "/";
}

export function documentTitle(pageTitle: string): string {
  return `${pageTitle} — spore.host`;
}
