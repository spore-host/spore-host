# web/: the spore.host site and portal

Two things live here and ship together to `s3://spore-host-website` behind
CloudFront:

- **The marketing pages**: `index.html` (the landing page), `privacy.html`,
  `terms.html` and `library.html`. Plain HTML and CSS with no build step.
- **The portal** at <https://spore.host/app>: a Vite + TypeScript single-page app
  in `app/` that runs the spore.host tools in the browser. It is driven by the
  same libraries the CLIs are ported to:
  [`@spore-host/spawn-ts`](https://github.com/spore-host/spawn-ts),
  [`@spore-host/truffle-ts`](https://github.com/spore-host/truffle-ts) and
  [`@spore-host/lagotto-ts`](https://github.com/spore-host/lagotto-ts). There is
  no portal backend of its own. AWS calls go from the tab to AWS with the signed-in
  user's short-lived credentials, and the account-wide features (cost history,
  teams, the software catalog, Slack) call the shared dashboard API at
  `api.spore.host`.

`dashboard.html` and `js/` are the older dashboard. The build does not copy them
into `dist/` (see `scripts/copy-static.mjs`), and whether to retire them is an
open decision, so they are left as they are.

## Layout

```
web/
├── index.html, privacy.html, terms.html, library.html   marketing pages (no build)
├── css/style.css          styles for the marketing pages and the portal
├── assets/                images, brand files, the vendored Rive runtime
├── app/                   the portal
│   ├── index.html         entry point (the only Vite input)
│   ├── main.ts            boot: config, session, shell
│   ├── shell.ts           header, sidebar, sign-in gate, hash router
│   ├── config.ts          build-time defaults, overridable per visit (?region=…)
│   ├── session.ts         in-memory credentials, expiry warning, disclosure level
│   ├── disclosure.ts      the guided / standard / expert levels
│   ├── pricing.ts         the one place an instance type becomes a shown price
│   ├── finderror.ts       wording for a truffle query that can't be read
│   ├── auth/              Globus sign-in → STS AssumeRoleWithWebIdentity
│   ├── guided/            the curated "what are you doing?" picker and launch flow
│   └── surfaces/          one file per tool, listed in surfaces/registry.ts
├── scripts/copy-static.mjs   copies the marketing pages + css/assets into dist/
├── vite.config.ts         build and test config
└── package.json           the three -ts libraries + Vite, TypeScript, Vitest
```

## Surfaces

Each tool is a `ToolSurface` in `app/surfaces/`, loaded lazily the first time it
is opened. Adding a tool means adding one surface file and one entry in
`surfaces/registry.ts`.

| Surface | Sign-in | What it does |
|---|---|---|
| Instances | yes | spawn-ts's Dashboard: launch, list, terminate, cost meters, orphans. At guided, the curated picker and a one-button launch replace the launch form. |
| Find instances | no | truffle-ts's natural-language search over its bundled catalog. Works offline. At guided, the curated picker. |
| Terminal | yes | A shell on an instance over SSM Session Manager (no SSH, no port 22). |
| Cost history | yes | The account's spend over time, from the dashboard API. |
| Software catalog | no | The strata formations, from the dashboard API. |
| Teams | yes | Team membership, from the dashboard API. Read-only at guided. |
| Slack | no | Connects a Slack workspace through the dashboard API's OAuth flow. |
| Watch capacity | yes | lagotto-ts's `CapacityWatcher` polling for an instance type to become available, in this tab only. |
| Connect account | no | Bring your own AWS account through a CloudFormation quick-create link. |

**Disclosure levels.** One setting in the header, guided, standard or expert,
changes what every surface shows. Guided replaces free-text and pattern fields
with curated cards, and expert adds per-row detail.

**Sign-in.** Globus Auth (institutional login through CILogon), then STS
`AssumeRoleWithWebIdentity` into the portal role, for an hour. The credentials are
held in memory and never persisted. What is saved is the disclosure level (in
`localStorage`) and the portal config such as the region (in `sessionStorage`, so
it survives the sign-in redirect). The role's permissions are in `infra/tofu/portal-oidc/main.tf`.

**Prices.** Every price the portal shows is a static figure from truffle-ts for
the session's region. The portal role has no `pricing:*` access, so the live
Price List is never called. Each price is shown with truffle-ts's origin label,
which says it is static, why, and when it was collected (for example,
`static, collected 2026-07 (live Price List not consulted (offline lookup))`). A
type with no static price in the region is shown as unknown, never as zero.
Outside us-east-1 that is most types: truffle-ts 0.6's table prices about 25 of
its 231 catalog types per region. The guided launch then asks the user to confirm
that they don't know the cost before it starts anything.

**Watch capacity.** Uses its own `CapacityFinder` over
`ec2:DescribeInstanceTypeOfferings` and `ec2:DescribeSpotPriceHistory`, not
truffle-ts's `AwsLiveFinder`. The live finder needs `ec2:DescribeInstanceTypes`,
which the portal role doesn't have, and it lists every type in the region on each
check. The comment at the top of `surfaces/lagotto.ts` has the details.

## Develop

```bash
cd web
npm ci
npm run dev          # Vite dev server; the portal is at /app/
npm run typecheck    # tsc --noEmit
npm test             # Vitest (happy-dom)
npm run build        # dist/: the portal bundle plus the copied marketing pages
npm run preview      # serve dist/ locally
```

Search, the guided picker and the software catalog work without signing in. The
signed-in surfaces need a Globus client id and the portal role ARN, as build-time
`VITE_*` variables (see `app/config.ts`) or as `?client_id=…&role_arn=…` on the
URL.

`app/surfaces/lagotto.harness.html` and `terminal.harness.html` are dev-only
pages that mount a real surface against stubbed AWS responses. Open them under
`npm run dev`. They are not build inputs and never ship.

Several tests use truffle-ts's real bundled catalog on purpose, not a fixture
(see the header of `app/guided/shapes.test.ts`). A truffle-ts upgrade that changes
a guided pick or a price fails them.

## CI and deploy

- **`.github/workflows/web-ci.yml`** runs on any pull request that touches `web/**`:
  `npm ci`, typecheck, test, build.
- **`.github/workflows/deploy-site.yaml`** runs on every push to `main` that
  touches `web/**`. It runs the same checks, then syncs `dist/` to S3 and
  invalidates CloudFront. **Merging to main deploys the site and the portal.**

Both are filtered on `web/**`, so a pull request whose diff doesn't touch `web/`
runs neither. `npm run deploy` (build, then `deploy.sh`) is the manual
equivalent from a workstation.
