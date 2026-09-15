# Changelog

Notable changes to the **spore.host shared infrastructure** repo — the hosted
REST API, dashboard, Python SDK, deployment automation, AMI builds, the
`spore-bot` Slack/Teams Lambda, and the documentation site.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Unlike the CLI tools (truffle/spawn/lagotto), this repo is **not tag-released** —
its Lambdas and site deploy continuously — so changes are grouped under
`Unreleased` until a milestone warrants a dated section. See the per-tool repos'
own changelogs for CLI releases.

## [Unreleased]

### Removed
- **The self-hosted `orion` CI runner fleet and everything that operated it**
  (`infra/ci-runners/`, `.github/workflows/{ci-runner-drift,fleet-canary,fleet-monitor}.yml`).
  All 15 jobs across the 9 repos that pinned to `[self-hosted, orion]` now run
  on `ubuntu-latest` — orion (colima/Docker on orion.local) is decommissioned
  org-wide in favor of GitHub-hosted runners, trading the fleet's disk-fill /
  reboot-crash-loop / Broken-VM failure modes (#381, #518) for GitHub-hosted's
  own occasional outages and slower minutes — the tradeoff the fleet originally
  existed to avoid, now accepted deliberately. Also dropped `/infra/ci-runners`
  from `.github/dependabot.yml`'s docker directories (nothing left to scan).
- **The retired Packer / owned-base-AMI build system under `infra/amis/`** (#546,
  spore-host#286/#389). The app catalog moved to SSM-resolved AWS GPU DLAMIs +
  Amazon DCV installed at boot + per-app container images (spawn v0.106.0/v0.107.0,
  libs v0.44.0/v0.45.0); owning the base AMI was the *cause* of the dangling/
  unshared-AMI drift in #389, not the fix. Deleted the dead build assets the docs
  pointed at: `build.sh`, `catalog-update.sh`, `share-base-ami.sh`,
  `dcv-gpu-al2023.pkr.hcl`, `paraview.pkr.hcl`, `Dockerfile.paraview`,
  `install-nvidia-docker.sh`, the `manifest-*.json` files, and the `base/` and
  `apps/` Packer-recipe directories. The container recipes (`infra/amis/containers/`),
  `kiosk-wm/`, and the `cleanup-orphan-amis.sh` remediation tool remain.

### Documentation
- **Rewrote `infra/amis/README.md` and `infra/amis/containers/README.md`** to
  describe only the current app-streaming model — SSM-resolved AWS GPU DLAMI +
  DCV-at-boot, optional `base_amis:` pin, and the container recipe→`build-push.sh`
  →public-ECR→bind (`--image`/overlay) flow — and removed the Packer / base-AMI /
  `share-base-ami.sh` / Marketplace instructions (#546). Corrected the catalog
  path to `libs/catalog/catalog.yaml` (was the nonexistent `pkg/catalog/`) and
  reconciled the public-ECR alias to the actual `public.ecr.aws/f8g1e7l5` (the
  vanity `spore-host` alias awaits async AWS approval), including the
  `build-push.sh` default registry and the container Dockerfile headers.
- **Classified application streaming (DCV + web-UI apps) as Beta** in
  `docs/reference/maturity.md` — shipped in spawn v0.107.0 (#546).

### Fixed
- **Clicking Disconnect no longer reports the session as having closed on its own**
  (#530). Two writers raced and the user-initiated one lost: the Disconnect handler
  wrote `disconnected` synchronously, then `attachTerminal`'s `onClosed` callback wrote
  `session closed: <reason>` over it — asynchronously, because a real
  `WebSocket.close()` dispatches `onclose` as a task rather than inline. The teardown
  the user asked for announced itself first and the socket's notification landed second.
  Deliberate closes now suppress the socket's message; an unexpected drop still reports
  one, since that wording is exactly for a session that ended without being asked to.
  Credential expiry benefits too — `sign in again` used to be replaced by
  `session closed`, which names the symptom and drops the instruction.
  - The flag is cleared in `connect()`, **not** in `resetUi()` as the issue suggested:
    `resetUi()` runs synchronously right after `teardown()` on every path, i.e. before
    the async `onClosed` it exists to suppress, so clearing it there would suppress
    nothing. A new session and a new socket is the real boundary. There's a test for
    the leak that would otherwise silence a real drop on a second connection.
  - `terminal.test.ts`'s `attachTerminal` mock never fired `onClosed` at all, which is
    why this was invisible to the suite and had to be found by driving the harness in a
    browser. It now defers the callback the way the real socket does — synchronously
    would run it *inside* `teardown()` and recurse.
- **The software catalog no longer requires an account to read** (#515). The catalog is
  the same five environment formations for everybody — the API's handler takes no
  arguments and reads nothing per-account — but `GET /api/strata/catalog` was routed
  *inside* dashboard-api's authenticated switch, so browsing a static list returned
  `401` and the portal gated the whole surface behind sign-in as a consequence. The
  route now sits above the auth check (and above the AWS config load, which it doesn't
  need), alongside the Slack OAuth exemptions.
  - **`POST /api/strata/resolve` stays authenticated.** It reaches
    `s3://strata-registry` with the Lambda's own credentials, so only the read-only
    listing was exempted. A test asserts that, so the two don't drift together later.
  - The existing catalog test called the handler function directly and so passed
    whether the route was gated or not — part of why this survived. Replaced with
    router-level tests that make the anonymous request the way a browser does.
  - A `401` from this endpoint no longer reports "authentication failed" in the portal:
    the endpoint doesn't authenticate, so a 401 means the deployed API is older than
    the page, and blaming auth would send a signed-out reader to a sign-in that can't
    help.
- **`GET /teams/{id}` now returns the caller's role** (#514). It already resolved the
  role to authorize the request and then discarded it, leaving clients to re-derive
  ownership by comparing `owner_arn` against whatever identity they thought they had.
  The portal did exactly that, and wrongly: `OwnerARN` is a **display field**, written
  once at creation and never read for authorization, and its format depends on which
  auth path created the team — a bare account id for portal-federated callers, a real
  IAM ARN for CLI ones. `GET /teams` already returned `role`; the detail endpoint not
  doing so was the gap. `OwnerARN` is now documented as display-only rather than
  renamed, because its `dynamodbav` tag is the stored attribute name.
  - The portal now reads that field instead of comparing `owner_arn` against
    `session.accountId`, so an owner who created their team with the CLI gets the owner
    controls the API says they have. It shipped keeping the old comparison as a fallback
    for when `role` was absent, because the deployed Lambda predated the field; that
    Lambda is now deployed and **the fallback is gone** (#534) — `role === "owner"` is
    the whole check, and nothing in the surface consults `owner_arn` for authorization
    any more. A 200 always carries a role, since the handler answers 403 unless it
    resolves a membership row, so a missing one is a broken response rather than an
    older API. It **fails closed**: no owner controls, and the member list still renders,
    because a read-only page is recoverable and a Delete button on someone else's team
    is not. There's a test for that direction — the fixture gives `owner_arn` the
    matching account id, so the deleted fallback would have granted the full set.
  - At expert, `owner_arn` is relabelled **created by**, and a **your role** row shows
    the API's answer — `unknown` if it somehow sent none, never an inference. Calling a
    write-once display field "owner" invited precisely the inference that caused this.
  - One existing test had to change with the fallback: "shows a non-owner no write
    controls even at expert" expressed non-ownership by mocking a mismatching
    `accountId`, which only worked *because* of the ARN comparison. It now states the
    role the way the API does. Left alone it would have kept passing for a reason
    unrelated to what it claims to check.
  - This fixes the *symptom*. The **underlying defect is larger and unfixed**:
    the portal and the CLI resolve one human to two different `callerARN`s, and that
    value is the membership row's partition key — so a CLI-created team is invisible in
    the portal and a portal-created team is invisible to the CLI, with no workaround,
    since `memberARNRe` rejects the bare account id that would bridge them. Tracked in
    #531; it needs a decision on stored data before any code.
- **`instances.test.ts` no longer calls live AWS** (#532). The suite mounted the
  surface with a real `EC2Provider`, and mounting starts a monitor that issues
  `DescribeInstances` immediately — so every full test run made unauthenticated calls
  to the live endpoint, reported as `Errors 1 error` beside `198 passed`. It only
  appeared in the *full* run (the file alone finishes before the response lands), which
  is why an earlier `globalThis.fetch` stub looked like it worked: the AWS SDK uses its
  own HTTP handler under Node, so the stub never intercepted anything. Now mocked at
  the module boundary with spawn-ts's own `MockProvider`.
- **`ssm:StartSession` is now scoped to spawn-managed instances** (#512). Both portal
  IAM policies — the OIDC launch role in `infra/tofu/portal-oidc` and the BYOA
  onboarding role in `deployment/cloudformation/portal-onboarding-role.yaml` — scoped
  `ec2:TerminateInstances`/`StopInstances`/`StartInstances` to `spawn:managed=true`
  and left `ssm:StartSession` on `instance/*` with no condition at all. A shell is at
  least as powerful as a terminate, so this was the widest grant in the role: a portal
  session could open a **root-capable shell on any SSM-registered instance in the
  account** — an unrelated production box the portal never launched — while being
  correctly denied permission to stop that same instance. The two statements sat next
  to each other, and the destructive one's comment claimed a portal session "can't
  touch unrelated instances".

  The only thing narrowing it was `/^i-[0-9a-f]{8,}$/` on a text field in the browser,
  which validates **syntax**, not authorization — it accepts every instance id in the
  account, and it runs on the client, where an attacker would be.
  - The condition key is `ssm:resourceTag/`, not `aws:ResourceTag/`: SSM evaluates the
    target node's tags under its own service-specific key for `StartSession`.
  - The session **documents** are a separate, deliberately unconditioned statement. A
    document carries no `spawn:managed` tag, so folding it into the conditioned
    statement would deny every session.
  - **BYOA accounts must redeploy the CloudFormation template to pick this up**, and
    the tofu side is a definition change — no workflow applies it.
- **"Your watch was stopped" no longer appears on a page you just opened** (#513).
  The notice is hidden with the HTML `hidden` attribute, and the attribute was being
  set correctly — but the stylesheet gives that element a `display: flex`, which
  out-specifies the browser's own `[hidden] { display: none }` rule. So it showed on
  **every** visit to **Watch capacity**, including the first, telling people a watch
  had stopped when they had never started one. That is exactly the cry-wolf failure
  the show-once logic was written to prevent, reintroduced a layer below it. The unit
  tests asserted the `hidden` property, which was right; only a real browser could see
  the rule losing. It also moved above the picker — at Guided the card list is about a
  thousand pixels tall, so a notice below it sat under the fold.
- **Changing Mode no longer silently loses a running capacity watch** (#513, part 1).
  A Mode change re-mounts the current page, which aborted the watch *and* cleared the
  instance types, price cap, zones and cadence describing it — with nothing on screen
  saying either had happened. The settings now survive (in the URL, as the query on
  **Find instances** and the window on **Cost history** already did), and the page says
  the watch stopped and offers **Resume watching**.
  - The poll is deliberately **not** resumed automatically. A query is replayable data;
    a watch is a live loop polling your own AWS account every interval, and the URL
    outlives the tab — so a page you didn't ask to load must not start spending on your
    behalf. The parameters come back; the decision stays yours.
  - The notice only appears when a watch was genuinely interrupted (a Mode change, a
    reload, an expired session) — not after you stop one yourself — and it appears once.
    A warning that cries wolf is one you learn to ignore, which costs exactly the case
    it exists for.
  - The other half of #513 — the guided card list below — completes it.

### Added
- **Terminal offers a list of your machines instead of an empty id box** (#512). The
  page asked for an instance id typed into a text field — an accurate description of
  what SSM needs and a poor one of what anyone has. Getting an `i-0123456789abcdef0`
  meant leaving for Instances, copying it, and coming back, so a surface that never
  read `ctx.level` was effectively Expert-only without saying so. It now lists running
  spawn-launched instances by name, type and spot status, from the same
  `tag:spawn:managed=true` filter the Instances page uses — applied by AWS, not by the
  page, so there is no client-side filtering to get wrong.
  - Only **running** instances are offered. A stopped one fails inside SSM with a
    message about the agent, which reads as a broken portal rather than a parked
    machine.
  - **Connect to an id instead →** keeps the old field, because a shell into something
    the portal didn't launch is a legitimate thing to want. Hidden at **Guided**, where
    an instance id isn't something the user has and offering to take one is a dead end
    dressed as an option — with one exception: if the list **fails to load**, the
    escape appears at Guided too, because a control you may not understand beats a page
    with no way forward.
  - "You have no instances" and "we couldn't ask" are reported as **different facts**.
    Claiming the first when only the second is known sends someone hunting for machines
    they have; a stopped-only account is told how many it has, since the fix there is
    to start one rather than launch another.
  - It reuses the Instances page's `EC2Provider` rather than adding a second
    DescribeInstances client — the bundle cost is what deferred this from the original
    disclosure pass, and it didn't materialise: the EC2 client hoisted into a shared
    15 kB chunk, `terminal` grew 2.2 kB and `instances` **shrank** ~15 kB.
  - The narrowing that matters is the IAM one above, not this picker. Listing makes the
    spawn-managed set the *default* set; AWS is what makes it the *only* set.
- **Watch capacity can be used without knowing instance-type names** (#513, part 2).
  At **Guided**, the page's fields — a glob or regular expression over instance-type
  names, a comma-separated zone list, a price cap in $/hr — are replaced by a short
  list of things worth waiting for: the big training GPUs, the newest ones, an older
  cheaper one, a small one for inference, an AWS training chip. Each resolves through
  the bundled offline catalog to a real type at a real price, so it still needs no AI,
  no network and no credentials. This is the page where the split matters most rather
  than least: whoever *needs* it is by definition someone whose launch just failed for
  capacity, and at that moment `p5.*` is precisely the string they don't have.
  - **It is not the launch list.** You don't wait for a `t4g.xlarge` — offering one
    would offer a poll that succeeds on its first check every time, teaching the user
    the page does nothing. The order is inverted too: the H100 leads, because whoever
    is here already knows they want the scarce thing, and the easier alternatives
    follow so a $55/hr quote beside an empty log has somewhere to go.
  - **The cost line is a rate, not a total.** "About $110 for 2 hours" describes a
    run, and this page starts a poll, which is free. It shows the hourly rate, what a
    day of it costs, and that watching costs nothing. A family with no listed price
    says so rather than showing nothing — the unpriced families are the scarce ones
    this page exists for, and blank would read as free on the most expensive hardware
    AWS rents.
  - **Picking a card watches the whole family**, `p5.*` rather than `p5.48xlarge`. A
    `p5.4xlarge` freeing up while the 48xlarge is still full is a match you want, and
    pinning the exact type would silently discard it.
  - The fields are **hidden, not removed**: the cards write into them and the watch
    reads out of them, so the URL persistence and **Resume watching** above work
    unchanged at every level, with one source of truth for what's being watched.
  - On a match, Guided names the type and zone and then points at **Mode**, not at
    Instances — Guided's Instances page offers five launch shapes and only the H100
    one is on this list, so "launch it from Instances" would send someone who waited
    for a B200 to a picker that can't. Adding a $114/hr machine to a beginner's
    one-click launcher is a deliberate omission there, not an oversight here.
- **A dead CI runner fleet now alerts instead of going unnoticed** (#520). On
  2026-08-01 the self-hosted fleet was down ~5.5h and nothing fired: a queued job
  never fails, it waits, so every open PR's checks silently degraded from "passing"
  to "unknown" — indistinguishable from "still running". Two new workflows:
  `fleet-monitor.yml` runs on `ubuntu-latest` every 30 min (a monitor pinned to the
  fleet it watches cannot fire when that fleet is down — that is precisely why the
  outage was silent) and dispatches `fleet-canary.yml`, a no-op job pinned to the
  fleet, then waits to see whether a runner actually *picks it up*. Pickup is the
  real question: a registered-but-wedged runner still reports `online`, and #518's
  crash-looping containers flapped between polls. It separately flags any run queued
  for more than 20 min across the seven repos with fleet-pinned jobs, which catches
  causes the canary doesn't anticipate.

  Alerts land as a GitHub issue labelled `fleet-outage`, carrying the recovery
  runbook and the two known causes from #518. Noise is bounded: a sustained outage
  comments on one issue rather than filing every 30 minutes, and recovery closes it
  automatically. The alert distinguishes "fleet is dead" from "fleet is alive but
  runs are piling up", since those need different first moves. No new secret is
  required — this deliberately avoids the `admin:org` runner-status endpoint, which
  would answer the weaker question (registered) rather than the real one.
- **`main` is now a protected branch** (#524 follow-up). It had **no** protection at
  all — no required checks, no restriction on direct pushes — on a branch that
  auto-deploys to spore.host and docs.spore.host. Now: no force pushes, no deletion,
  linear history required, and six checks required before merge (`Branch hygiene`,
  `Docs build + link check`, `Go Vulnerability Check`, `Secret Scan (gitleaks)`,
  `Trivy Security Scan`, `Semgrep SAST`). No review requirement — the repo is
  effectively single-committer.
  - `Lambda module tests` is deliberately **not** required: it's a matrix job, so its
    check name carries the coverage floor (`lambda/rest-api, 10`). Editing a floor
    renames the check, and a required check that never reports blocks every PR.
  - `web-ci.yml` / `ci-runner-drift.yml` are deliberately **not** required: both are
    `paths:`-filtered, and a check that doesn't fire is indistinguishable from one
    still pending.
  - `enforce_admins` is off, so an admin retains an escape hatch for an urgent fix.
  - The required-check list and both omissions are documented in `CONTRIBUTING.md`,
    since a protection rule whose rationale lives only in the API is one nobody can
    safely change later.
- **Branch hygiene is now checked, not just documented.** PR #521 was branched from
  a working tree that still held PR #519's portal commit, so #521's head carried
  both changes. #521 merged first and took the portal fix with it; #519 then merged
  as an **empty commit** (`131f02b`). Because `deploy-site.yaml` and `web-ci.yml`
  are path-filtered on `web/**`, an empty commit matched neither — so the PR whose
  entire purpose was correcting two user-facing strings ran no web tests and
  triggered no site deploy. Nothing was red; the work simply wasn't where its PR
  said it was, and establishing that the fix was live took a bundle-level audit of
  what S3 was actually serving.
  - `scripts/branch-preflight.sh` — run before opening a PR. Checks: not on `main`,
    clean tree, based on `origin/main` history, every commit unique to this branch,
    and (advisory) a single topic. `--fix` prints recovery commands.
  - A `Branch hygiene` job in `ci.yml` — fails a PR with an empty diff, or one
    carrying a commit that also belongs to another **open** PR. Comparing against
    open PR heads rather than `main` is the load-bearing detail: when #521 was open,
    the absorbed portal commit had not yet merged, so "is it on main?" answered no
    for both of its commits.
  - `CONTRIBUTING.md` gains a **Branching and merging** section; `CLAUDE.md`'s Git
    section gains the rule and the post-merge verification steps.
  - Repo setting: `delete_branch_on_merge` is now **on**. It was off, which is how
    66 stale local branches accumulated before being swept.

### Fixed
- **CI runner fleet: a host reboot no longer leaves the fleet dead** (#518). On
  2026-08-01 the whole self-hosted fleet stayed offline for ~5.5h and every
  `Test` / `E2E Tier 0` job across spawn, truffle, lagotto and miniwdl-spawn sat
  queued. Three independent defects in `infra/ci-runners/`, each fixed:
  - `boot-recreate.sh` **could not recover a `Broken` colima VM.** A vz VM whose
    prior shutdown failed comes back with its driver running but no host agent, and
    `colima start` — the script's only recovery — exits 1 on inspection without
    attempting a boot. The script waited its full 3 min, tried the one thing that
    cannot work, and gave up. It now escalates to `colima stop --force` (which
    moves `Broken` → `Stopped`) and retries, releasing a stale lima disk lock on
    the way.
  - **The offline-runner prune was dead code.** It was gated on
    `command -v gh`, and `gh` is not installed on orion — so it had silently
    no-opped on every boot while looking like a working safety net in review.
    Rewritten on `curl` + `jq` (both present) using the `ACCESS_TOKEN` already in
    `.env`, so it needs no new credential; it now also refuses to delete a
    registration that is `busy`, and reports failures instead of swallowing them.
  - **`--replace` did not prevent the crash-loop it was added for.** All 6
    containers still crash-looped on `Cannot configure the runner because it is
    already configured` with `--replace` live in the image, because that flag
    resolves the *server-side* name conflict while the check that fires is
    *local* — `config.sh` refuses whenever `/home/runner/.runner` exists, and an
    unclean stop skips the cleanup trap that would remove it. `entrypoint.sh` now
    clears the stale local registration before configuring, so a plain restart is
    survivable rather than depending on the recreate path.
  Docs corrected accordingly: the README previously stated `--replace` fixed the
  reboot crash-loop, which was not true. Fleet-offline alerting is tracked
  separately in #520 — the outage was silent because queued jobs never fail.

### Added
- **The CI runner fleet now syncs itself from this repo** (#522). `infra/ci-runners/`
  was versioned and reviewed but reached orion.local by hand, so it documented the
  fleet rather than defining it — reviewing a change there proved nothing about what
  was live. That is how #518's third defect hid: a fix present in the repo *and*
  baked into the running image, still not working, with no way to tell the image was
  current short of hashing it by hand. Two new pieces:
  - `infra/ci-runners/sync-from-git.sh`, run hourly and at boot by launchd
    (`host.spore-ci-sync.plist`): fetches `main`, copies only files whose content
    changed, rebuilds the image when the build context changed **or** when the baked
    `entrypoint.sh` no longer matches the repo, and recreates the fleet **only when
    no runner is busy** — recreating mid-job kills that CI run. When busy it defers
    to the next run instead. A no-drift run changes nothing and exits 0.
  - A `CI runner drift` workflow that runs *on the fleet* deliberately: the only way
    to know what a runner runs is to ask a runner, so the job hashes its own baked
    `/home/runner/entrypoint.sh` against the repo and fails with a diff plus the
    remediation command. It also verifies the hourly sync is still alive via a
    `.sync-manifest` heartbeat, bind-mounted read-only so a job cannot forge its own
    proof of freshness.

  Effect: merging a runner change to `main` deploys it; `scp`-ing fixes onto the host
  is no longer the workflow, and drift that does appear fails a check instead of
  sitting undetected. Limits are explicit — a container can't read the host
  filesystem, so the gate verifies the reconciler rather than hashing
  `docker-compose.yml`/`boot-recreate.sh` directly, and a fully offline fleet leaves
  this gate queued rather than red (that's #520).

### Changed
- Bumped the `substrate` test dependency v0.65.0 → v0.85.0 in the
  `accountlifecycle` and `spore-bot` Lambda modules, 20 minor versions of AWS
  emulation fidelity. Test-only; no runtime or deployed behaviour change. Both
  modules still imported substrate at its **root** package path, which moved to
  `/emulator` at v0.70.0, so the pin could not advance without that one-line
  import fix — the two registry round-trip suites had been frozen on v0.65.0
  since. `StartTestServer` is otherwise unchanged.

### Added
- **The homepage hero orb is now animated.** The jellyfish mascot floats, its eyes
  pulse, and its tentacle fringe sways strand-by-strand on an 8-second seamless
  loop, above the static wordmark. Built as a Rive scene
  (`web/assets/brand/spore-orb.riv`) with its editable source — full rig, art, and
  a deterministic build script — committed under `design/orb/`.

  It is layered as progressive enhancement, so the hero that shipped before is
  still what you get whenever the animation can't or shouldn't run: no JS, no
  WebGL2, a fetch failure, an OS "reduce motion" preference, or a metered/2G-3G
  connection all keep the static mark, and the runtime isn't downloaded at all in
  the last two cases. The canvas and the static mark occupy the same reserved box,
  so the swap causes no layout shift, and the animation pauses while scrolled
  off-screen. The Rive runtime is vendored under `web/assets/vendor/rive/` rather
  than loaded from a CDN, so the homepage gains no third-party render-time
  dependency.

### Changed
- **Canonical mascot art is now the clean, transparent de-pinked mark** (replacing
  the sticker-derived knockout and the earlier pink-checkerboard icon export).
  Updated the brand mascot assets under `web/assets/brand/` and `docs/brand/`.

- **The site nav bar now shows the real `spore ● host` wordmark image** (across
  the landing page and the developer/library page), replacing the CSS-text +
  gradient-circle lockup. Sized 45px to sit in the nav.
- **Hero "Runs in your AWS account…" trust line is now left-aligned** with the
  rest of the hero copy (was centered by an `auto` block margin).

### Fixed
- **Site CSS changes no longer take up to 24h to reach returning visitors.** The
  deploy cached all static assets (including the hand-copied, unhashed
  `css/style.css` / `dashboard.css`) for `max-age=86400`, so a CSS change paired
  new HTML with a browser's day-old CSS — which is how a hero style update once
  rendered the mascot at full natural size until a hard refresh. CSS now deploys
  with a short `max-age=60, must-revalidate` (like the HTML); Vite's
  content-hashed JS keeps the long cache. (Images under `assets/` remain
  long-cached — they're name-stable and change rarely.)

### Changed
- **Marketing site (`web/`) now uses the real spore.host brand art.** The landing
  hero leads with the full **`spore ● host` wordmark** (width-sized); the nav shows
  the real wordmark image (replacing the CSS-text + SVG-circle stand-in). Added Open Graph /
  Twitter social-card meta pointing at `spore-host-og.png`, so links unfurl with
  the brand card. Brand assets live under `web/assets/brand/` (logo, jellyfish
  mascot, hero, OG). The mascot and wordmark are the clean, transparent-background
  brand renders (`spore-host-mark` / `spore-host-wordmark`), so they sit correctly
  on the dark hero with no white box.

### Added
- **`portal-account-prober` — the scheduled caller the lifecycle state machine was
  written for** (`lambda/portal-account-prober/`, `infra/tofu/portal-account-prober/`,
  spore-host#491). Each run scans the account registry, assumes each account's
  `spore-portal-onboard` role, counts `spawn:managed` instances across 11 regions,
  and persists only the transitions `ApplyProbes` decided. This is what finally makes
  a stale `{base36}.spore.host` A-record expirable.
  - **A separate Lambda on purpose.** The ttl-reaper already assumes into customer
    accounts, but a *different* role (`spawn-ttl-reaper-ec2`, hand-listed in
    `REAPER_ROLE_ARNS`) — it holds no credentials for the roles the registry knows
    about, so pointing it at the registry would mean recording accounts it cannot
    reach as unreachable. And `portal-phone-home`, which does hold the trust
    relationship, is internet-facing under a Function URL: granting it
    assume-into-any-customer would put that one handler bug from the public edge.
    The prober has no URL and one EventBridge rule as its only invoker.
  - **`lifecycle.go`/`registry.go` extracted to a new `lambda/accountlifecycle`
    module** rather than copied. `ApplyProbes`' refusals are mutation-verified and a
    second copy would drift out from under those tests.
  - **Guards against two false-deprovision doors the prober's existence opens.**
    STS returns `AccessDenied` both for a *deleted* role (the uninstall signal) and
    for a role whose trust policy doesn't name us — and every role onboarded before
    this Lambda existed names only the phone-home role, so they will all deny it. The
    correlated-failure guard cannot catch that (it needs *every* probe to fail; this
    is a subset), so `ApplyProbes` now treats a denial as evidence **only for an
    account with a `lastSeenAt` baseline**: one that provably admitted us before.
    Separately, a probe that reached only *some* regions reports `EmptinessUnproven`
    and skips the dormancy evaluation — zero-of-a-partial-set is not zero — without
    re-stamping `lastInstanceAt`, so one failing region defers dormancy rather than
    blocking it forever.
  - **Read-only credentials despite a launch-capable role.** `spore-portal-onboard`
    can `RunInstances`, and a trust policy governs who may assume rather than what
    they may then do — so every assume attaches an STS **session policy** allowing
    only `ec2:DescribeInstances`. Effective permissions are the intersection, so a
    compromised prober cannot launch or terminate anything. That is what makes the
    new optional `ProberLambdaRoleArn` trust grant honest to ask for instead of
    shipping a second read-only role into customer accounts.
  - **Alarms on the refusal, not just on errors.** A run that concludes nothing
    because *our* credentials broke looks identical to a run with nothing to do, so
    the handler logs `REFUSING to conclude anything` and Tofu puts a metric filter +
    alarm on it. Ships with `dry_run = true`.
  - 35 prober tests (84%) + 8/8 mutations caught, including the end-to-end
    `TestRun_PreExistingAccountsSurviveTheProberRollout` (baseline-less accounts
    denying for 3×K runs *alongside* a healthy one, so the correlated-failure guard
    is demonstrably not what spares them) and its mandatory converse
    `TestRun_UninstallAfterBaselineIsDetected`.
- **Account lifecycle state machine for BYOA deprovisioning** (`lambda/accountlifecycle/lifecycle.go`,
  spawn#457 checkbox 2). Onboarding was one-way — the registry exposed only
  `PutAccount`/`GetAccount`, so nothing could ever conclude "this account is gone"
  and every artifact left behind was permanent. One of those artifacts is a real
  hazard: a Route53 A-record whose public IP has returned to the EC2 pool
  eventually resolves to an unrelated instance.
  - New `Account` lifecycle fields, all `omitempty`: `status`, `lastSeenAt`,
    `lastErrorAt`, `consecutiveFailures`, `lastInstanceAt`, `statusReason`,
    `statusChangedAt`. A row written before this change unmarshals to the zero
    value and reads as `active` via `AccountStatus()` — **no backfill needed**.
  - Four states — `active`, `unreachable`, `dormant`, `offboarded` — each existing
    to answer one question: is it safe to delete this account's DNS records?
    `DNSExpiryEligible` says yes for only `dormant` (emptiness *proven* through a
    working `DescribeInstances`) and `offboarded` (a human stated intent).
  - `ApplyProbes` is the pure state machine (no AWS, no clock — `now` is a
    parameter), driven by the liveness signal the reaper already pays for: it
    assumes every account's role every 10 minutes. Policy is K/N configurable,
    defaulting to K=6 consecutive failed runs (one hour) and N=30 days.
  - **Refuses to act on correlated failure**: if *every* probe fails, nothing
    changes. The reaper's role ARN embeds a CloudFormation-generated physical ID,
    so recreating that stack breaks every customer's trust policy at once — a
    machine acting on assume-role failure alone would forget the entire customer
    base because we redeployed. Same instinct as the DNS sweep's refusal to delete
    against a partial live set.
  - **`unreachable` deletes nothing**, deliberately. It is the state we would most
    like to clean up and the one where verification has become impossible, because
    the deleted role is what we would have verified through.
  - `ListAccounts` (paginated Scan) and `UpdateLifecycle` (UpdateItem, not Put — a
    Put would clobber a concurrent re-onboard's fresh ExternalId with the stale copy
    a reaper run happened to read) plus `Offboard` for the explicit human path. No
    `DeleteItem`: the registry is the audit trail.
  - 45 tests, mutation-verified — every guard above fails a test when reverted. The
    caller landed separately as `portal-account-prober` (above), which is where the
    `Scan`/`UpdateItem` grants live, so no permission ever existed without a caller.
    See spawn#457.
- **Docs: "Verify a download" section** in the installation guide — how to check a
  manually-downloaded release with keyless cosign (`cosign verify-blob --bundle`
  against the release workflow's OIDC identity) plus the checksum, for the CLIs now
  cosign-signed under spore-host#344. Notes that spored is verified automatically.
- **Docs: new "Worked transcripts" page** (`/guides/transcripts`) — complete,
  annotated terminal sessions using the tools' real output: a passing `spawn
  doctor`, a preflight blocked by a missing IAM permission (with the exact fix
  lines), a protected launch, `spawn status` showing the lifecycle-protection
  block, and terminate + cleanup verification. Linked from Start Here and the first
  instance guide.
- **Marketing site (spore.host) now deploys via CI.** New `deploy-site.yaml` syncs
  `web/` → the site bucket + invalidates CloudFront on every push to `main` under
  `web/**` (short HTML cache, long asset cache, post-deploy smoke). Previously the
  site shipped only via the manual `web/deploy.sh`, so homepage edits could sit in
  `main` unpublished and the live site drifted from source — the root cause of the
  stale-homepage findings in the external reviews. (`web/deploy.sh` stays for
  manual/emergency deploys.)
- **Docs + site: MCP client coverage and safety flow.** The MCP setup guide
  (`/guides/mcp-setup`) and reference (`/tools/mcp-server`) now cover **Claude
  Code** (`claude mcp add`), Windsurf, and a generic stdio-client section for
  Kiro/Codex/Zed/etc. — previously only Claude Desktop + Cursor. All surfaces
  (docs + `web/` homepage and library page) now document `spawn_terminate`'s
  two-phase `confirm=true` flow and ambiguous-name refusal, the deliberate
  no-launch boundary, and the `SPORE_PROFILE`/`~/.config/spore/config.toml`
  config options; corrected the marketing site's "no extra auth" wording.

### Security
- **spore-bot Lambda: bump `google.golang.org/grpc` 1.80.0 → 1.82.1** (indirect,
  via substrate) — resolves GHSA-hrxh-6v49-42gf (gRPC-Go xDS RBAC / HTTP/2, HIGH).

### Fixed
- **Site: homepage manual-install tab now has a working command.** It previously
  showed only a comment + a bare `tar` line using `$(uname -s)_$(uname -m)` (wrong
  case/arch for GoReleaser assets, and the wrong repo). It now uses the same tested
  installer as the Quick Start (lowercase OS, `x86_64→amd64`/`aarch64→arm64`) and
  links to other installation methods.
- **Docs: the manual-install snippet was broken on every platform.** The Quick
  Start "Manual" install commands matched release assets using `uname -s`/`uname -m`
  (`Darwin`/`x86_64`), but GoReleaser names assets with lowercase GOOS/GOARCH
  (`darwin`/`amd64`) — so the download URL resolved to nothing everywhere. The
  snippet now lowercases the OS and maps `x86_64→amd64` / `aarch64→arm64`.

### Added
- **Docs: new suite-wide Maturity & Support Policy page** (`/reference/maturity`).
  States in one place how mature each component is (six core tools Stable; HTTP
  API/SDK beta; workflow adapters experimental; streaming experimental), what
  compatibility to rely on (all tools pre-1.0 → **breaking changes bump MINOR**, so
  pin to a minor series), the platform support matrix (CLI OS/arch; what spawn can
  launch; GPU/EFA), and how deprecations/support work. Linked from the Reference
  index and sidebar; links to (does not duplicate) the workflow-adapter matrix.
- **CI: manual-installer platform matrix** (`install-matrix.yml`). Runs the
  documented manual `curl`-a-tarball install on macOS Intel/ARM and Linux
  amd64/arm64, then asserts `spawn`/`truffle` land on PATH and run — so asset-naming
  or install-doc drift turns into a red build instead of a broken first experience.
  On-demand + weekly, and re-runnable via a `repository_dispatch` from CLI releases.
- **Docs deploy is now a verifiable release artifact.** The rendered site footer
  carries a **build stamp** — the commit short-SHA (linked) and build date — so you
  can tell from the live site exactly which commit is deployed. The deploy workflow
  now runs a **post-deploy smoke** that polls the live `docs.spore.host` and fails
  the job if the just-built commit or canonical CLI strings (`spawn doctor`,
  `spawn connect`, `terminate`) aren't served, turning a silent stale-serve into a
  red build. HTML is now cached short (`max-age=60, must-revalidate`) while
  fingerprinted JS/CSS assets are cached immutably for a year — so returning
  visitors no longer see up-to-an-hour-stale pages.

### Fixed
- **Docs: MCP scope, SSH-key wording, and reaper guarantee-by-mode** (from a second
  external review). Reworded the How It Works MCP section — it no longer says the
  server "exposes all of the above"; it now states MCP does read/manage operations
  (find, status, stop, terminate, extend) and **cannot launch** by design. Corrected
  the SSH-key note in `how-it-works.md` and `architecture.md`: spawn imports your
  existing default public key and only generates/manages one under `~/.spawn/keys/`
  if you have none (never touches private keys) — matching the FAQ, aws-auth, and
  quickstart pages. Added the **lifecycle guarantee-by-deployment-mode** table
  (CLI-only / self-hosted backstop / hosted integrations, with the reaper's dry-run
  default) to the Safety page, previously only in `SECURITY.md`.
- **Docs: corrected `--cost-limit` description** (safety, glossary, spored, EC2
  tags). It's a **compute-only** ceiling (excludes EBS/storage), accumulates
  across stop/resume rather than resetting, **terminates** the instance, and fires
  independently of the TTL (first ceiling to fire wins). Matches the spored fix in
  spawn PR #400 (enforcement was resetting the cost clock on each restart).

### Added
- **Docs: execution-fabric restructure (plugins & workflow adapters).** Following a
  second review of the extension subsystem, regrouped the docs so spawn reads as an
  execution substrate with four extension layers — **Extend an instance** (instance
  plugins), **Run many jobs** (sweeps, arrays), **Coordinate multiple steps**
  (instance queues, pipelines, MPI), and **Workflow adapters** — instead of a flat
  "Advanced" list. New page **[Which execution tool?](https://docs.spore.host/guides/choosing-execution)**
  with two decision matrices (layer→question, need→tool) plus per-task-EC2 fit
  guidance. Renamed "Plugins"→"Instance plugins" and "Workflow Engines"→"Workflow
  adapters" (CLI flags unchanged).
- **Docs: parameter-sweeps now document existing concurrency/recovery controls** —
  `--max-concurrent`, `--budget`, `spawn sweep resume` (checkpoint), and
  `spawn sweep collect`, which the guide previously omitted.
- **Docs: instance-queue operational detail** — per-job `retry`/`env`/`result_paths`
  fields, per-job log paths, resume-skips-completed behavior, and Spot-interruption
  guidance, all verified against the spored queue runner.

### Changed
- **Docs: corrected workflow-adapter maturity.** The overview no longer calls the
  five engine integrations "first-class"; it now leads with a **status &
  compatibility matrix** (nf-spawn = experimental prototype; miniwdl = early,
  validation in progress; CWL/Snakemake/Airflow = v0.1.0 initial releases) and
  distinguishes "native adapter" from "production-ready." Experimental badges added
  to the Nextflow guide.
- **Docs: job-array `--min-viable` semantics clarified** — `{total}`/`JOB_ARRAY_SIZE`
  is the *requested* count and partial launches leave *sparse* indexes; shard
  schemes must not assume a dense range.

### Fixed
- **Docs: pipeline manual example was misleading** — clarified that `--on-complete`
  does not launch the next stage and that running `spawn launch` commands by hand
  is not a pipeline (the Lambda orchestrator chains stages from the DAG definition).
  Scoped `spawn pipeline` to coarse DAGs (not a scientific workflow engine) and
  marked stream mode (tcp/grpc/zmq) Experimental with its operational caveats.
- **Docs: instance-queue (batch-queue) sequencing contradiction** — stated plainly
  that jobs run strictly one at a time in topological order and `depends_on` is
  ordering only, not concurrency.
- **Docs: added a plugin Trust & permissions section** — installing a plugin runs
  its author's code locally and as root on the instance; documents what `github:`
  refs resolve to, the minimal-env/`env_passthrough` limit, `spawn plugin validate`,
  and links the tracked inspect/permissions gaps.

### Added
- **Docs: researcher-facing information-architecture overhaul.** Restructured the
  docs site around user intent instead of product structure, following an external
  review. New top-level nav: Introduction → Start Here → Common Workflows → Tools →
  Automation → Chat & AI Control → Administration → Reference (one global sidebar).
  New pages: **Security, credentials & data flow** (`/architecture`, "what runs
  where" trust/data-flow model), **Costs & safety guarantees** (`/safety`,
  auto-terminate failure boundaries + pre-launch cost estimation), **Waiting for
  scarce capacity** (a Lagotto first-use tutorial), **Glossary**,
  **Troubleshooting & common mistakes**, and **Event schemas**. The Guides landing
  is now three narrative user stories. Each tool page opens with a consistent
  *What it is / When to use / First commands* trio; Truffle gains a find-vs-search
  decision box, Spawn a three-tier progressive-disclosure map and a spawn-vs-spored
  "what runs where" diagram. Added audience/maturity badges (Beginner / Advanced /
  HPC / Automation / Stable / Beta …) with WCAG-AA colours in light and dark mode.
- **Docs: heterogeneous parameter sweeps** (spawn#372) — the sweeps guide now
  shows varying `instance_type`/`ami`/`spot` per entry (price-performance
  benchmark example), with the per-entry AMI auto-detection, the one-OS-per-sweep
  rule, and the detached-sweep `ami:` caveat.
- **Zenodo DOI**: spore.host is now archived on Zenodo with a citable DOI
  (concept DOI [10.5281/zenodo.21439339](https://doi.org/10.5281/zenodo.21439339),
  always latest). Wired into `CITATION.cff`, `codemeta.json`, and a README badge +
  Citation section.
- **`codemeta.json`** — CodeMeta (JSON-LD / schema.org) software metadata, for
  software registries and citation tooling; complements `CITATION.cff`.
- **`CITATION.cff`** — machine-readable citation metadata (GitHub renders a
  "Cite this repository" button). Foundation for the Zenodo DOI integration.
- **Docs AI-readiness: `llms.txt` manifest** (#424) — a curated
  [llmstxt.org](https://llmstxt.org) entry map, generated at build time from the
  sidebar (a `buildEnd` hook) so it can't drift from the nav.
- **Docs discoverability: `sitemap.xml`, per-page descriptions, OpenGraph** (#425)
  — set the VitePress `sitemap.hostname` (`docs.spore.host`); added a
  `description:` to ~40 content pages (→ real `<meta name="description">` and
  better AI/search snippets); added default OG/Twitter card `head` tags.

### Fixed
- **Site: resolved the "five vs six tools" inconsistency.** The marketing site
  now says "Six tools" and includes a **Spored** card (it was omitted); the docs
  already said six. `web/README.md`'s stale tool list updated to match.
- **Site: consistent HTTP API status.** The API is now labelled **beta / used by
  the SDK** everywhere — removed "coming soon"/"on the roadmap" framing on
  `web/library.html` (added an inline **Beta** badge to the endpoint block so it
  doesn't read as a live public contract) and reconciled the `guides/python-sdk`
  and `guides/self-hosting` wording.
- **Copy: clarified spore.host is not itself the host** — the hero, docs home,
  and How It Works now state up front that it runs on your own AWS account with
  your own credentials, with no new provider to sign up for.
- **Docs accessibility: WCAG AA contrast** (#423) — tool badges are small
  (0.7rem) bold text, so they need 4.5:1: several failed in light and/or dark
  mode. Badge text now uses per-mode colors that all clear 4.5:1, and dark-mode
  link text uses a lightened brand blue (the `#4059E5` override dropped to 3.09:1
  on the dark background); the hero brand button keeps its solid blue + white.

- **Docs: job arrays now document `--min-viable`** (spot partial-success floor)
  and parameter sweeps document `spawn alerts` (completion/failure/cost-threshold
  notifications via email/Slack/SNS/webhook) — both features the reference listed
  but no guide explained.

### Fixed
- **Docs: corrected the SSH/connectivity FAQ** — `spawn connect` logs you in as
  your own username (the instance matches your local user) and reuses your
  `~/.ssh/id_ed25519`/`id_rsa` key when present; added SSM/private-subnet and
  common-failure troubleshooting. Replaces the stale `ec2-user`/`spawn-default`
  and `--key-name` guidance.
- **Docs: corrected the Pipelines guide** — `spawn pipeline launch` takes a JSON
  definition file (not the fictional YAML + `--slack-workspace`/`--efs-id`
  flags), stages form a DAG via `depends_on`, and data is handed off with
  `data_input`/`data_output`. Also fixed `status`/`cancel`/`collect` (take a
  pipeline id) vs `graph` (takes the file).
- **Docs: rewrote the lagotto SageMaker section** — `--service sagemaker` now
  **submits your training job** (`--sagemaker-config`) when the EC2-family proxy
  fires; it is no longer notify-only. `--action notify` (alert only) and `spawn`
  (submit) are both valid; `hold` is rejected.
- **Docs: fixed the sidebar** — wired the orphaned Discord setup guide into nav
  and de-duplicated the two "Self-Hosting" entries into one group.

### Added
- **Docs: new "Managing Instances & Data" guide** covering the operational spawn
  commands that had no prose — `stage` (cross-region S3 staging), `snapshot` +
  `launch --attach-volume` (large reference data as an EBS volume),
  `upgrade-spored`, and `resources`/`orphans` (inventory + cost hygiene).
- **Docs: complete `plugin.yaml` field reference** in the Plugins guide (top-level,
  config params, conditions, local/remote phases, step fields, outputs) derived
  from the loader schema.
- **Docs: truffle overview now documents the shared `--profile`/`--account`
  config** and links the AWS auth guide.
- **Docs: the CLI command/flag reference is now generated + drift-gated.** Each
  CLI (spawn/truffle/lagotto) emits its exhaustive reference from the binary
  (`libs/docgen`); the umbrella vendors those fragments into `docs/gen/<cli>/`,
  and `docs/tools/reference/<cli>.md` collapsed to a thin prose shell that
  `@include`s them (spawn's reference dropped from ~1056 hand-maintained lines to
  a short shell). A new `sync-cli-docs.yaml` workflow re-vendors each CLI's
  reference from its latest release tag (fired by the CLI release, on demand, or
  weekly) and opens a PR, so the site's reference tracks the shipped binaries
  automatically. A `docs-build` CI job now gates the docs (VitePress build +
  `@include`/link check) — the site previously had no PR gate. (2026-07 docs audit.)

### Changed
- **Docs: code/command text now renders in Atkinson Hyperlegible Mono**, matching
  the body's Atkinson Hyperlegible for a consistent, high-legibility monospace.

### Security
- **spore-bot: removed the static `BOT_EXTERNAL_ID` cross-account fallback (fail
  closed).** Assuming a registration's cross-account role now requires that
  registration's own per-account `external_id` (generated at register time since
  the per-registration ExternalId change); a registration without one can no
  longer assume its role via the shared `spawn-bot` value, which has been
  removed. Safe now that both bot deployments run the per-account read path and
  no live registration depends on the shared value. Any account's
  `SpawnBotCrossAccount` trust policy must require its per-account ExternalId
  (spawn CFN `ExternalId` parameter) before that account's instances can be
  controlled (#413, #374).
- **rest-api: API keys are now stored and looked up by SHA-256 hash.** The raw
  `sk_...` key was the DynamoDB partition key, so a table dump yielded usable
  credentials. `validateAPIKey` now hashes the presented key and looks it up by
  hash; legacy plaintext-keyed rows still authenticate (dual-read) and are
  rewritten to their hashed form on first use, so the migration is transparent
  and needs no client changes. New keys must be inserted hashed (see
  `infra/DEPLOY.md`) (#374).
- **rest-api: request log now includes a truncated, non-secret KeyID.** Each
  request logs `keyid=` (first 8 hex chars of the key's SHA-256) for
  attribution; the previous `Principal.KeyID` exposed the raw key's first 8
  chars, which leaked the secret's prefix (#374).
- **spore-bot: cross-account role assumption now uses a per-registration STS
  ExternalId.** Registrations get a high-entropy `external_id` (generated at
  register time, or supplied by the admin so it can be pre-baked into the
  customer role's trust policy), and the assume uses it. (The shared
  `BOT_EXTERNAL_ID` fallback that initially backed this has since been removed —
  see above; EC2 `Resource:"*"` scoping is opt-in via the spawn CFN template.)
  (#374).
- **spore-bot: removed the dead log-only instance-identity verification.** The
  PKCS#7/embedded-cert check in the notify path (`verifyNotifyAuth` + embedded EC2
  certs, `signature.go`) never rejected anything — it only logged — and its
  embedded certs were unreliable across regions/rotations (same reason the
  dns-updater cert path was retired, #294). Keeping it misrepresented the crypto
  posture. The enforced control is (and was) the registry-membership gate: a
  notification is only delivered for an instance registered in the target
  workspace. Removed the file, the log-only call, the now-unused `NotifyRequest`
  identity fields, and the `fullsailor/pkcs7` dependency (#374).

### Fixed
- **spore-bot: `GetWorkspacesForPlatform` no longer hides a failed DynamoDB scan.**
  It previously returned "no workspaces" identically for an empty result and a
  scan error, masking outages; the error is now logged (#374).

### Changed
- **rest-api SMS handler owns its pending-reply types locally.** spawn is
  removing its dead `pkg/sms` (spawn#293); rest-api was the only cross-repo
  consumer and used only the inbound types (`PendingKey`/`PendingNotification`/
  `PendingTable`). Those now live in `lambda/rest-api/sms.go` (mirroring
  `lambda/spore-bot/sms_notify.go`, which already keeps its own copy); the
  `pkg/sms` import is dropped. No behavior change; rest-api still depends on
  spawn's `pkg/aws`/`pkg/config`.

### Security
- **Pinned the CI Go toolchain to 1.26.5** to clear GO-2026-5856, a `crypto/tls`
  standard-library advisory present in go1.26.4 (affects the Go Lambdas / modules
  built by CI). govulncheck is green again.

### Added
- **`infra/ci-runners/` — the self-hosted CI runner fleet is now versioned** (it
  previously lived only on orion.local, so fixes weren't reviewable) (#381). The
  Dockerfile, self-healing `entrypoint.sh`, compose, boot launchd unit, and a
  `boot-recreate.sh` recovery/boot script, with a README documenting the failure
  modes and operations.

### Fixed
- **CI runner fleet no longer fills its disk and orphans jobs** (#381). The
  ephemeral runners ran under `restart: always`, which restarts each finished
  container **in place** — so its writable layer (`_work` + a ~3.5GB Go build
  cache) grew unbounded across cycles (~7GB × 6) until the colima volume hit 80%+
  and a job mid-run ran out of space, dying with no recorded steps (a ~10-min
  GitHub timeout — this is what spuriously failed spawn#258). The entrypoint now
  self-heals each cycle (clears `_work`, caps the go-build cache, `--replace`
  re-registers), and a launchd boot unit recreates the fleet (not restart-in-place)
  after a host reboot, fixing the prior reboot crash-loop too. Recovery on the
  host reclaimed ~38GB (80%→13%).

### Fixed
- Corrected broken GitHub and pkg.go.dev links on the website and docs that
  assumed a monorepo layout: the tools are split repos, so `truffle`, `spawn`,
  `lagotto`, and the MCP server now link to their own `github.com/spore-host/*`
  repos (and Go imports use `github.com/spore-host/<tool>/...`, not a nested
  `spore-host/spore-host/...` path).
- Python SDK docs/site no longer say "coming soon" / "not on PyPI yet" — the
  `spore-host` package is published (`pip install spore-host`); point SDK links
  at the standalone `spore-host/python-sdk` repo.
- Fixed the `scttfrdmn/tap` Homebrew command on the dashboard (→ `spore-host/tap`)
  and added the missing `docs/public/favicon.svg`.

### Added
- **`infra/tofu/dns-updater`** — OpenTofu module bringing the hand-deployed
  `spawn-dns-updater` Lambda (Route53 record updater) under IaC, mirroring the
  `spore-bot` import-onto-live pattern (imports to a near-zero diff: only additive
  `managedby` tags). This is step 0 of the spawn#173 cutover that moves the DNS
  updater off the spoofable instance-identity-document auth onto the Function URL's
  `AuthType: AWS_IAM`. The module carries a gated `enable_iam_invoke` toggle (the
  `Principal: "*"` AWS_IAM invoke grant — scalable, no per-account enumeration) and
  documents the full cutover ordering; the destructive `AuthType` flip stays gated
  on a SigV4-signing fleet being fielded. See the module README.
- spore-bot formats the new `pre_stop_failed` / `pre_stop_timeout` lifecycle
  events (spawn#186): a failed or timed-out `--pre-stop` hook now shows as a
  loud orange/red Slack/Teams/Discord message (and SMS) carrying the hook's
  error/output tail, instead of being indistinguishable from a clean shutdown.
  Surfaces the spawn#184 data-loss shape (a pre-stop that "succeeded" saving
  nothing).

### Removed
- Dead `Registry.RedeemConnectCode` in spore-bot (audit L-health, #374). Connect
  codes are redeemed on the spawn side (`spawn bot register --connect-code`,
  which atomically deletes the shared-table item); the Lambda only issues them.
  The duplicate, never-called Lambda-side redeem method is removed to avoid
  misrepresenting the flow.

### Fixed
- **`extend` can no longer prematurely reap an instance** (audit M-corr, #374).
  The bot `/spore extend`, the REST API `extend` action, and the SMS `extend`
  reply now floor the new TTL deadline at `now + requested-duration`. Previously,
  if the instance had a missing/unparseable `spawn:ttl` (deadline anchored to a
  long-past launch time) or an already-expired `spawn:ttl-deadline`, the
  recomputed deadline could land in the past — terminating the instance at the
  moment the user asked to keep it alive. An extend now always grants at least
  the requested duration from the current moment.

### Security
- **Medium/Low audit hardening** (#374): the OAuth state HMAC now fails closed
  when `BOT_OAUTH_SECRET` is unset or still `change-me` (the old default let a
  forged state complete the flow); Twilio webhook signature verification is
  **required in production** (`SPORE_ENV=production`) and the
  `SKIP_TWILIO_SIGNATURE` escape hatch is ignored there; connect codes are now
  generated with `crypto/rand` (8 hex chars, ~4.3B) instead of a time-seeded
  value; and `MarkTerminated`'s DynamoDB retention now matches its documented
  7 days (was 24h).
- **Hosted REST API now enforces per-project tenant isolation** (audit C1, #369).
  Previously every handler received a validated API-key principal but never used
  it, so any valid key could list/launch/stop/terminate/extend **every** instance
  in the account. Launches are now stamped with `spawn:project=<key's project>`,
  and list/get/stop/start/hibernate/terminate/extend are scoped to the
  principal's project (fail-closed: a key with no project can't launch or reach
  any instance; non-owned instances return 404, not 403, so existence isn't
  leaked). **Operator note:** instances launched before this change carry no
  `spawn:project` tag and become invisible to the API — backfill the tag
  (`aws ec2 create-tags --tags Key=spawn:project,Value=<project>`) to re-expose
  them.
- **SMS "extend" reply now writes `spawn:ttl-deadline`** (not just `spawn:ttl`,
  which spored ignores — a silent no-op, same class as #371) and is capped at the
  7-day maximum.
- **Teams Bot Framework requests now fully validate the bearer JWT** (audit H4,
  #372). Previously a `Bearer …` request was trusted as long as the server-side
  `TEAMS_APP_ID` env was set — no token validation at all — so any caller of the
  public Function URL could forge a Teams activity. The token is now verified for
  RS256 signature against Microsoft's published JWKS, issuer
  (`https://api.botframework.com`), audience (`== TEAMS_APP_ID`), and expiry;
  `alg:none`/HMAC-confusion are rejected. Verification fails closed.
- **Slack/Teams signature verification now rejects an empty signing secret**
  (audit H5, #373). HMAC with an empty key is forgeable, and OAuth-installed
  Slack workspaces persist no per-workspace secret. Slack now falls back to the
  app-level `SLACK_SIGNING_SECRET` env (the secret is app-level, not
  per-workspace), and both verifiers fail closed when no secret is available.
- **Hosted REST API now enforces lifecycle bounds** (audit H3, #371). Unlike the
  CLI, the API called the spawn client directly and bypassed the 1h-idle
  zombie-prevention default, so an empty-TTL launch produced an instance with no
  deadline and no reaper tag. Launches with neither TTL nor idle timeout now get
  a default idle timeout, all TTL/idle/extend durations are capped at a 7-day
  maximum, and the `extend` action now writes `spawn:ttl-deadline` (not just
  `spawn:ttl`) so the extension actually takes effect (it was a silent no-op,
  same class as spore-host-mcp#11). The `/spore extend` and `/spore idle` bot
  commands gained the same deadline fix and 7-day cap.
- **spore-bot `/notify` now gates per-user DM and SMS fan-out on instance
  registration** (audit C2, spore-host/spawn#369-370 class). Previously the
  endpoint only checked that `workspace_id`/`instance_id` were non-empty, so
  anyone who learned an instance_id + workspace_id could trigger DMs to
  registered users and platform-billed SMS for an instance that wasn't theirs.
  DM/SMS now require the instance to be registered in the workspace
  (`InstanceRegisteredInWorkspace`); the channel-webhook path is left open (the
  workspace owner opted in, no per-user targeting or SMS cost). PKCS#7 identity
  verification is wired in as log-only for now (the embedded-cert path is
  unreliable cross-region; #294) and will flip to hard-reject once certs are fixed.

### Security
- Security CI hardened to a consistent gate across the suite: govulncheck now
  scans **all** Go modules (added `spore-bot` — previously only `rest-api`),
  added **gitleaks** secret scanning (MIT binary; org-license-free; allowlist for
  doc examples + test fixtures), and Trivy's filesystem scan now includes the
  **secret** scanner. The same Security workflow (govulncheck/gitleaks/Trivy/
  Semgrep) was added to the previously-unscanned tool repos (spawn, truffle,
  lagotto, nf-spawn, spore-host-mcp).

### Added
- **Infrastructure as code (OpenTofu), starting with spore-bot.** New
  `infra/tofu/spore-bot/` module — the first IaC in the umbrella — reconciles the
  previously hand-deployed spore-bot Lambda + Function URL under OpenTofu via
  `tofu import` (imported to a zero-functional-diff plan; only additive
  `managedby=opentofu` tags). Code and secret env vars stay out-of-band
  (`ignore_changes`), so deploys and secrets are untouched. Reference pattern for
  migrating the rest of the hand-rolled `setup-*.sh` infra.

### Fixed
- **spore-bot** Discord slash-command results now appear reliably: the async
  executor could PATCH the interaction's response before Discord registered the
  deferred ack (a 404 race — `/spore help` showed "thinking…" then nothing). The
  follow-up now retries a 404 with short backoff (#2).
- **spore-bot ran under prism-bot's IAM role** (`prism-bot-PrismBotFunctionRole`),
  a cross-project coupling that, among other things, denied writes to the
  `spore-bot-audit` table. Created a dedicated least-privilege **`spore-bot-role`**
  and repointed the function; spore.host's bot no longer borrows prism's identity.
- **spore-bot** delivers Discord lifecycle notifications (Phase 1 of
  spore-host/spawn#2): when an instance's notify platform is `discord`, the
  `/notify` handler posts a color-coded Discord embed (severity-colored, with
  instance/region/URL fields) to the workspace's channel webhook. Adds a
  `PublicKey` field to the workspace registry for Discord's Ed25519 interaction
  verification (used by Phase 2 slash commands). New `docs/guides/discord-setup.md`.
- **spore-bot** Discord slash commands (Phase 2 of spore-host/spawn#2): a
  `/discord` interactions endpoint verifies Discord's Ed25519 request signature
  (per-application public key), answers the PING/PONG handshake, and dispatches
  `/spore list|status|start|stop|hibernate|url|extend|connect` through the same
  async action machinery as Slack/Teams — replying with a deferred ack and
  editing in the result (meeting Discord's 3-second deadline). Multi-tenant: any
  guild installs the published app and registers via `spawn notify workspace-add
  --platform discord`. New `scripts/register-discord-commands.sh` registers the
  global slash command; setup guide extended with the Phase 2 install flow.
- **spore-bot** honors the friendly account-name DNS segment: it displays
  `{name}.{account-name}.spore.host` when the instance has a `spawn:account-name`
  tag (falling back to base36) and matches a user-typed target against either
  form (spore-host/spawn#121, #357 / #358).
- README documents Windows support (ISO → AMI → launch → RDP/SSH) and a Quick
  Start example (#355).
- `CLAUDE.md` records the project-wide **SemVer 2.0.0 + Keep a Changelog** policy
  that applies to every spore.host repo (#355).
- CI runs per-Lambda-module tests and bootstrapped `rest-api` Lambda coverage
  (#337).

### Changed
- Relocated the `spore-bot` Lambda from the spawn repo into this infra monorepo.
- Bumped `codecov/codecov-action` v5 → v7 (#350).

### Removed
- Untracked the 18 MB committed `lambda/spore-bot/spore-bot` build artifact (now
  gitignored; regenerated by the build).

---

Earlier history is in the
[commit log](https://github.com/spore-host/spore-host/commits/main) and the
[pull requests](https://github.com/spore-host/spore-host/pulls?q=is%3Apr+is%3Amerged).
