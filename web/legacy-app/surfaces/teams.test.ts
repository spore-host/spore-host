// Per-level rendering of the teams surface.
//
// Guided here is READ-ONLY, not absent, and both halves of that are asserted. The
// forms all demand an IAM ARN a guided user cannot produce and three of the actions
// are irreversible — but membership is information about your own account, and a user
// told "check Teams" who can neither find it nor tell it exists is worse off than one
// shown a list with no buttons.
//
// `fetch` is stubbed: the real endpoints need a federated session, and every write
// path is owner-gated server-side (403), which is not what these assert. `canWrite`
// is about not showing a beginner a form they can't fill in — never about security.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../session.js";
import type { PortalConfig, SurfaceContext } from "./types.js";
import type { DisclosureLevel } from "../disclosure.js";
import { teamsSurface } from "./teams.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

const config = { region: "us-east-1", apiBase: "https://api.example" } as PortalConfig;

const ACCOUNT = "123456789012";

const TEAM = {
  team_id: "t-0001",
  team_name: "Nagel Lab",
  // A bare account id, not an ARN: that's what dashboard-api writes for a
  // portal-created team (portalAccountFromARN), which is why the owner check compares
  // against session.accountId. See spore-host#514 for the CLI-created case.
  owner_arn: ACCOUNT,
  description: "shared instance visibility",
  created_at: "2026-06-01T00:00:00Z",
  member_count: 2,
  role: "owner",
};

const MEMBERS = [
  {
    team_id: "t-0001",
    member_arn: `arn:aws:iam::${ACCOUNT}:user/owner`,
    role: "owner",
    joined_at: "2026-06-01T00:00:00Z",
    invited_by: "self",
  },
  {
    team_id: "t-0001",
    member_arn: `arn:aws:iam::${ACCOUNT}:user/alice`,
    role: "member",
    joined_at: "2026-06-02T00:00:00Z",
    invited_by: `arn:aws:iam::${ACCOUNT}:user/owner`,
  },
];

/**
 * Stub the API.
 *
 * `detail` overrides what GET /teams/{id} returns. The default sends `role: "owner"`,
 * which is what the deployed Lambda does: the handler resolves the caller's role from
 * the memberships table and answers 403 rather than 200 without one, so a 200 always
 * carries it. Tests wanting a different role — or a malformed response with none — say
 * so explicitly, e.g. `stubFetch({ role: undefined })`.
 */
function stubFetch(detail: Record<string, unknown> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(config.apiBase, "");
      const body =
        path === "/teams"
          ? { teams: [TEAM] }
          : { team: TEAM, members: MEMBERS, role: "owner", ...detail };
      return { ok: true, status: 200, json: async () => body } as never;
    }),
  );
}

function ctxAt(level: DisclosureLevel): SurfaceContext {
  const session = new SessionController("us-east-1", null);
  session.setLevel(level);
  vi.spyOn(session, "accountId", "get").mockReturnValue(ACCOUNT);
  vi.spyOn(session, "getCreds").mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "token",
  } as never);
  return { session, config, level, navigate: vi.fn() };
}

/**
 * Mount at the list and click into the one team's detail view.
 *
 * Clears `?team=` first: the surface records the open team there and restores it at
 * mount, so a second call in the same test would find no list card to click. That
 * persistence has its own tests below.
 */
async function openDetail(host: HTMLElement, ctx: SurfaceContext) {
  location.hash = "#/teams";
  const d = await teamsSurface.mount(host, ctx);
  await settle();
  host.querySelector<HTMLButtonElement>(".teams-card")!.click();
  await settle();
  return d;
}

describe("teamsSurface disclosure", () => {
  let host: HTMLElement;

  beforeEach(() => {
    stubFetch();
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    // The surface records the open team in the hash, so a leftover `?team=` would put
    // the next mount straight into a detail view.
    location.hash = "#/teams";
  });

  it("still lists your teams at guided", async () => {
    // Read-only, not absent. Hiding this would mean the user can neither find the
    // feature nor learn it exists.
    const d = await teamsSurface.mount(host, ctxAt("guided"));
    await settle();
    expect(host.querySelectorAll(".teams-card")).toHaveLength(1);
    expect(host.textContent).toContain("Nagel Lab");
    d.dispose();
  });

  it("shows no create form at guided", async () => {
    const d = await teamsSurface.mount(host, ctxAt("guided"));
    await settle();
    expect(host.querySelector(".teams-create")).toBeNull();
    d.dispose();
  });

  it("shows the create form from standard up", async () => {
    for (const level of ["standard", "expert"] as const) {
      host.innerHTML = "";
      const d = await teamsSurface.mount(host, ctxAt(level));
      await settle();
      expect(host.querySelector(".teams-create"), level).not.toBeNull();
      d.dispose();
    }
  });

  it("still shows the membership list at guided, with no write controls", async () => {
    // Every write here needs an IAM ARN a guided user cannot produce, and Remove and
    // Delete are irreversible.
    const d = await openDetail(host, ctxAt("guided"));
    expect(host.querySelectorAll(".teams-members tbody tr")).toHaveLength(2);
    expect(host.querySelector(".teams-remove")).toBeNull();
    expect(host.querySelector(".teams-addmember")).toBeNull();
    expect(host.querySelector(".teams-danger")).toBeNull();
    // And no vestigial action column. Leaving the header and the empty cells in place
    // renders as a fourth column that failed to load, which is a worse read than three
    // columns that are all there is.
    expect(host.querySelectorAll(".teams-members thead th")).toHaveLength(3);
    expect(host.querySelector(".teams-memb-action")).toBeNull();
    d.dispose();
  });

  it("shows the owner's write controls from standard up", async () => {
    // The mirror of the above: if standard rendered identically to guided, read-only
    // guided would be indistinguishable from a broken surface.
    const d = await openDetail(host, ctxAt("standard"));
    expect(host.querySelector(".teams-addmember")).not.toBeNull();
    expect(host.querySelector(".teams-danger")).not.toBeNull();
    // The owner row is not removable; the member row is.
    expect(host.querySelectorAll(".teams-remove")).toHaveLength(1);
    d.dispose();
  });

  it("shows a non-owner no write controls even at expert", async () => {
    // Raising the mode cannot grant authority. The API owner-gates every write with a
    // 403 regardless, so this is about not offering a button that can only fail — and
    // the action column goes with it, since Remove was the only thing in it.
    //
    // Non-ownership is stated the way the API states it, with `role`. This test used to
    // mock a mismatching `accountId` instead, which only worked because the surface
    // compared that against `owner_arn` — the #514 bug. A mismatching account id now
    // proves nothing about authority, so asserting through it would leave this passing
    // for a reason unrelated to what it claims to check.
    stubFetch({ role: "member" });
    const d = await openDetail(host, ctxAt("expert"));
    expect(host.querySelector(".teams-addmember")).toBeNull();
    expect(host.querySelector(".teams-danger")).toBeNull();
    expect(host.querySelector(".teams-memb-action")).toBeNull();
    // Expert's read-only additions are still there — they're information, not authority.
    expect(host.querySelector(".teams-meta")).not.toBeNull();
    d.dispose();
  });

  describe("who the owner controls are shown to (#514)", () => {
    // The bug: the surface decided ownership by comparing `owner_arn` against
    // `session.accountId`. That field is a bare account id for portal-created teams and
    // a real IAM ARN for CLI-created ones, so an owner who created their team with the
    // CLI saw a read-only page. The API now answers the question itself with `role`.

    it("believes the API's role over the stored owner_arn", async () => {
      // The #514 case: a CLI-created team, so `owner_arn` is an IAM ARN that cannot
      // equal an account id. The old comparison fails here; `role: "owner"` must win.
      stubFetch({ role: "owner" });
      const ctx = ctxAt("standard");
      vi.spyOn(ctx.session, "accountId", "get").mockReturnValue(ACCOUNT);
      const cliTeam = { ...TEAM, owner_arn: `arn:aws:iam::${ACCOUNT}:user/owner` };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = url.replace(config.apiBase, "");
          const body =
            path === "/teams"
              ? { teams: [cliTeam] }
              : { team: cliTeam, members: MEMBERS, role: "owner" };
          return { ok: true, status: 200, json: async () => body } as never;
        }),
      );
      const d = await openDetail(host, ctx);
      expect(host.querySelector(".teams-addmember")).not.toBeNull();
      expect(host.querySelector(".teams-danger")).not.toBeNull();
      d.dispose();
    });

    it("believes a role of member even when owner_arn matches", async () => {
      // The other direction: a portal-created team, so `owner_arn` DOES equal the
      // account id, and the old comparison would have granted owner controls. The API
      // says "member", and that is the answer.
      stubFetch({ role: "member" });
      const d = await openDetail(host, ctxAt("standard"));
      expect(host.querySelector(".teams-addmember")).toBeNull();
      expect(host.querySelector(".teams-danger")).toBeNull();
      d.dispose();
    });

    it("shows no owner controls when the API sends no role at all", async () => {
      // A 200 without `role` is a broken response, not a supported shape — the handler
      // can only answer 200 after resolving a membership row. This asserts which way it
      // fails: closed. `owner_arn` here equals the account id, so the fallback this
      // replaces (spore-host#534) would have granted the full set of owner controls,
      // including irreversible Delete, on the strength of a display field.
      stubFetch({ role: undefined });
      const d = await openDetail(host, ctxAt("standard"));
      expect(host.querySelector(".teams-addmember")).toBeNull();
      expect(host.querySelector(".teams-danger")).toBeNull();
      expect(host.querySelector(".teams-remove")).toBeNull();
      // Still readable, though: a member list is information about your own account, and
      // a missing field is no reason to withhold it.
      expect(host.querySelectorAll(".teams-members tbody tr")).toHaveLength(2);
      d.dispose();
    });

    it("shows your role at expert, never a guess", async () => {
      stubFetch({ role: "member" });
      let d = await openDetail(host, ctxAt("expert"));
      let keys = [...host.querySelectorAll(".teams-meta dt")].map((t) => t.textContent);
      expect(keys).toContain("your role");
      expect(host.querySelector(".teams-meta")!.textContent).toContain("member");
      // `owner_arn` is relabelled: it is written once and never read for authorization,
      // and calling it "owner" invited the inference that caused this bug.
      expect(keys).toContain("created by");
      expect(keys).not.toContain("owner");
      d.dispose();

      // With no role, the row says so rather than inferring one from `owner_arn` — which
      // matches the account id in this fixture, so "owner" is exactly the wrong answer
      // an inference would produce.
      host.innerHTML = "";
      stubFetch({ role: undefined });
      d = await openDetail(host, ctxAt("expert"));
      const meta = host.querySelector(".teams-meta")!;
      keys = [...meta.querySelectorAll("dt")].map((t) => t.textContent);
      expect(keys).toContain("your role");
      const values = [...meta.querySelectorAll("dd")].map((v) => v.textContent);
      expect(values, "a guess must not be printed as the answer").toContain("unknown");
      expect(values).not.toContain("owner");
      d.dispose();
    });
  });

  it("offers a route out of read-only at guided", async () => {
    // Guided must not be a dead end: the user who arrives because a colleague said
    // "add me to your team" needs a route to the form, and "go find Mode in the
    // header" is not one — that's the knowledge guided exists to not require.
    const ctx = ctxAt("guided");
    const d = await teamsSurface.mount(host, ctx);
    await settle();
    host.querySelector<HTMLButtonElement>(".guided-escape")!.click();
    expect(ctx.session.level).toBe("standard");
    d.dispose();
  });

  it("has no escape button once writes are available", async () => {
    const d = await teamsSurface.mount(host, ctxAt("standard"));
    await settle();
    expect(host.querySelector(".guided-escape")).toBeNull();
    d.dispose();
  });

  it("shortens member ARNs below expert but keeps the full one recoverable", async () => {
    // `arn:aws:iam::123456789012:user/alice` is 45 characters of which one word
    // identifies the person, and it wraps the table on a laptop. Truncating without
    // the title would make the identity unrecoverable without changing mode.
    const d = await openDetail(host, ctxAt("standard"));
    const cell = host.querySelector<HTMLElement>(".teams-members tbody td")!;
    expect(cell.textContent).toBe("user/owner");
    expect(cell.title).toBe(`arn:aws:iam::${ACCOUNT}:user/owner`);
    d.dispose();
  });

  it("shows full ARNs at expert", async () => {
    const d = await openDetail(host, ctxAt("expert"));
    const cell = host.querySelector<HTMLElement>(".teams-members tbody td")!;
    expect(cell.textContent).toBe(`arn:aws:iam::${ACCOUNT}:user/owner`);
    d.dispose();
  });

  it("adds who invited whom only at expert", async () => {
    // `invited_by` is on every Member the API returns and was never rendered. In a
    // shared-visibility team, "who added this person" is the audit question.
    for (const [level, expected] of [
      ["standard", false],
      ["expert", true],
    ] as const) {
      host.innerHTML = "";
      const d = await openDetail(host, ctxAt(level));
      const heads = [...host.querySelectorAll(".teams-members th")].map((t) => t.textContent);
      expect(heads.includes("Invited by"), level).toBe(expected);
      d.dispose();
    }
  });

  it("adds the team's identifiers and timestamps only at expert", async () => {
    for (const [level, expected] of [
      ["standard", false],
      ["expert", true],
    ] as const) {
      host.innerHTML = "";
      const d = await openDetail(host, ctxAt(level));
      expect(host.querySelector(".teams-meta") !== null, level).toBe(expected);
      d.dispose();
    }
    // And the id is on the list card too, where it's what an API call needs.
    host.innerHTML = "";
    location.hash = "#/teams";
    const d = await teamsSurface.mount(host, ctxAt("expert"));
    await settle();
    expect(host.querySelector(".teams-id")!.textContent).toBe("t-0001");
    d.dispose();
  });

  describe("the open team survives a re-mount", () => {
    it("returns to the detail view the user was reading", async () => {
      // A level change re-mounts this surface. Dumping the user back at the list is
      // the loss they'd notice, because raising the mode is most often triggered
      // while looking at one specific team.
      const first = await openDetail(host, ctxAt("standard"));
      expect(host.querySelector(".teams-members")).not.toBeNull();
      first.dispose();

      host.innerHTML = "";
      const second = await teamsSurface.mount(host, ctxAt("expert"));
      await settle();
      expect(host.querySelector(".teams-members")).not.toBeNull();
      expect(host.querySelector(".teams-card")).toBeNull(); // not the list
      second.dispose();
    });

    it("clears the recorded team when the user goes back to the list", async () => {
      const d = await openDetail(host, ctxAt("standard"));
      host.querySelector<HTMLButtonElement>(".teams-back")!.click();
      await settle();
      expect(location.hash).toBe("#/teams");
      d.dispose();
    });
  });

  it("cleans up at every level", async () => {
    for (const level of ["guided", "standard", "expert"] as const) {
      host.innerHTML = "";
      location.hash = "#/teams";
      const d = await teamsSurface.mount(host, ctxAt(level));
      await settle();
      d.dispose();
      expect(host.querySelector(".teams-surface"), level).toBeNull();
    }
  });
});
