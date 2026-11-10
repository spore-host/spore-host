// The teams surface: create teams and manage membership via the shared
// dashboard-api (/teams…) over the session's federated creds. This is the first
// portal surface with WRITE/mutating ops (POST create, POST/DELETE members,
// DELETE team) — every destructive action is confirm-gated, and the API itself
// enforces owner-only on writes (403 otherwise), so the UI just surfaces that.
//
// Identity note: with account-scoped auth (spawn#445), the caller's team key is
// their verified AWS account id; teammates are added by their IAM user/role ARN.
//
// Disclosure: guided is READ-ONLY, not absent. Every write here needs an IAM ARN a
// guided user cannot produce (see MEMBER_ARN_RE), and three of the actions are
// irreversible. But membership is information about your own account, and hiding the
// surface from the sidebar would mean a user told "check Teams" can neither find it
// nor tell it exists. So the lists stay and the forms go, with an escape to
// standard for the user who does need to manage one.
import type { AwsCreds } from "@spore-host/spawn-ts/auth";
import type { Disposable, SurfaceContext, ToolSurface } from "./types.js";
import { atLeast } from "../disclosure.js";
import { readHashParam, writeHashParams } from "../hashstate.js";

interface Team {
  team_id: string;
  team_name: string;
  owner_arn: string;
  description?: string;
  created_at: string;
  member_count: number;
  role?: string; // present on the list endpoint (owner | member)
}

interface Member {
  team_id: string;
  member_arn: string;
  role: string;
  joined_at: string;
  invited_by: string;
}

// A valid IAM user/role ARN — mirrors memberARNRe in the API so we reject before
// the round-trip.
const MEMBER_ARN_RE = /^arn:aws:iam::\d{12}:(user|role)\/.{1,256}$/;

function credentialsHeader(creds: AwsCreds): string {
  return btoa(
    JSON.stringify({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    }),
  );
}

export const teamsSurface: ToolSurface = {
  id: "teams",
  label: "Teams",
  accent: "--lagotto",
  requiresAuth: true,

  async mount(host: HTMLElement, ctx: SurfaceContext): Promise<Disposable> {
    const creds = ctx.session.getCreds();
    if (!creds) throw new Error("teams surface mounted without a session");

    const root = document.createElement("div");
    root.className = "teams-surface";
    host.appendChild(root);

    const controller = new AbortController();
    let disposed = false;
    // `canWrite` gates the forms, not the data. The API enforces owner-only on every
    // write regardless (403), so this is about not showing a beginner a form they
    // can't fill in — never about security.
    const canWrite = atLeast(ctx.level, "standard");
    const expert = atLeast(ctx.level, "expert");

    // Thin fetch wrapper: attaches auth, JSON content-type on writes, and the
    // abort signal; returns parsed body + status.
    async function api(
      path: string,
      init?: { method?: string; body?: unknown },
    ): Promise<{ ok: boolean; status: number; data: any }> {
      const headers: Record<string, string> = { "X-AWS-Credentials": credentialsHeader(creds!) };
      let body: string | undefined;
      if (init?.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(init.body);
      }
      const resp = await fetch(`${ctx.config.apiBase}${path}`, {
        method: init?.method ?? "GET",
        headers,
        body,
        signal: controller.signal,
      });
      let data: any = null;
      try {
        data = await resp.json();
      } catch {
        /* empty/non-JSON body */
      }
      return { ok: resp.ok, status: resp.status, data };
    }

    function errText(status: number, data: any): string {
      if (data?.error) return String(data.error);
      if (status === 401) return "authentication failed";
      if (status === 403) return "you don't have permission for that";
      return `HTTP ${status}`;
    }

    // ── List view ──────────────────────────────────────────────────────────
    async function showList(): Promise<void> {
      if (disposed) return;
      root.replaceChildren();
      writeHashParams({ team: null });
      root.append(
        el("div", "teams-head", [
          el("h2", "", ["Teams"]),
          el("p", "teams-hint", [
            canWrite
              ? "Teams share visibility of spawn-managed instances. You own the teams you create; owners manage membership."
              : "Teams share visibility of spawn-managed instances. These are the teams you're in.",
          ]),
        ]),
      );

      const status = el("div", "teams-status", ["loading…"]);
      root.append(status);

      const res = await api("/teams");
      if (disposed) return;
      if (!res.ok) {
        status.className = "teams-status error";
        status.textContent = `Couldn't load teams (${errText(res.status, res.data)}).`;
        return;
      }
      status.remove();

      const teams: Team[] = res.data?.teams ?? [];

      // Create-team form (collapsible).
      if (canWrite) root.append(buildCreateForm(showList, api, errText));

      if (teams.length === 0) {
        root.append(
          el("div", "teams-status", [
            canWrite
              ? "You're not in any teams yet — create one above."
              : "You're not in any teams yet.",
          ]),
        );
        if (!canWrite) root.append(buildEscape(ctx));
        return;
      }

      const list = el("div", "teams-list", []);
      for (const t of teams) {
        const card = el("button", "teams-card", []);
        (card as HTMLButtonElement).type = "button";
        card.append(
          el("div", "teams-card-head", [
            spanText("teams-name", t.team_name),
            spanText("teams-role", t.role ?? "member"),
          ]),
          el("div", "teams-card-meta", [
            `${t.member_count} member${t.member_count === 1 ? "" : "s"}`,
          ]),
        );
        if (t.description) card.append(spanText("teams-desc", t.description));
        if (expert) card.append(spanText("teams-id", t.team_id));
        card.addEventListener("click", () => void showDetail(t.team_id));
        list.append(card);
      }
      root.append(list);
      if (!canWrite) root.append(buildEscape(ctx));
    }

    // ── Detail view ────────────────────────────────────────────────────────
    async function showDetail(teamID: string): Promise<void> {
      if (disposed) return;
      // Recorded so a mode change — which re-mounts this surface — returns to the
      // team the user was reading rather than dumping them back at the list.
      writeHashParams({ team: teamID });
      root.replaceChildren();
      const back = el("button", "teams-back", ["← All teams"]);
      (back as HTMLButtonElement).type = "button";
      back.addEventListener("click", () => void showList());
      root.append(back);

      const status = el("div", "teams-status", ["loading…"]);
      root.append(status);

      const res = await api(`/teams/${encodeURIComponent(teamID)}`);
      if (disposed) return;
      if (!res.ok) {
        status.className = "teams-status error";
        status.textContent = `Couldn't load team (${errText(res.status, res.data)}).`;
        return;
      }
      status.remove();

      const team: Team = res.data.team;
      const members: Member[] = res.data.members ?? [];
      // Read the API's own authorization answer rather than re-deriving it.
      // GET /teams/{id} returns `role`, resolved from the memberships table — which is
      // where authorization actually lives. It is present on every 200: the handler
      // answers 403 unless resolveTeamContext finds a membership row, and every writer
      // of that row sets the field. So a missing `role` is a broken response, and
      // treating it as "not the owner" is the right way to fail — a read-only page is
      // recoverable, a page offering Delete on someone else's team is not.
      //
      // Nothing here consults `owner_arn`. That field is written once at creation and
      // its format depends on which auth path wrote it — a bare 12-digit account id for
      // portal-created teams (dashboard-api's portalAccountFromARN), a real IAM ARN for
      // CLI-created ones (cliIamArn) — so comparing it against accountId matched the
      // former and never the latter, and a team made with the `spawn` CLI showed its own
      // owner a read-only page (spore-host#514). That comparison lived on here as a
      // compatibility fallback while the API predated `role`; the Lambda is deployed
      // (spawn 66cb620), so it is gone (spore-host#534).
      // Typed as possibly-absent because this is parsed JSON and the type is a claim
      // about the wire, not a guarantee — but no branch below treats absence as a
      // supported shape.
      const role: string | undefined = res.data.role;
      const iAmOwner = role === "owner";

      root.append(
        el("div", "teams-head", [
          el("h2", "", [team.team_name]),
          ...(team.description ? [el("p", "teams-hint", [team.description])] : []),
        ]),
      );

      // Expert: the identifiers and timestamps a support conversation or an API call
      // needs. Deliberately below the name, not beside it — a team_id is not what
      // anyone came here to read.
      if (expert) {
        const dl = el("dl", "teams-meta", []);
        const rows: Array<[string, string]> = [
          ["team id", team.team_id],
          // Labelled "created by" rather than "owner": the stored field is written once
          // at creation and never read for authorization, and its format depends on
          // which auth path wrote it. Calling it "owner" invited exactly the inference
          // that caused #514. `your role` below is the authoritative answer.
          ["created by", team.owner_arn],
          ["created", fmtDate(team.created_at)],
          // Always shown, because the API always sends it. `unknown` rather than a
          // dropped row if it somehow doesn't: this is the field that decides which
          // controls the page offers, so an expert reader debugging a page that looks
          // wrong should be told the answer is missing, not shown a gap they have to
          // notice. Never a guess — printing an inference here would be the same
          // mistake that caused #514.
          ["your role", role ?? "unknown"],
        ];
        for (const [k, v] of rows) dl.append(el("dt", "", [k]), el("dd", "", [v]));
        root.append(dl);
      }

      // Members table.
      const table = el("table", "teams-members", []);
      const thead = el("thead", "", []);
      const htr = el("tr", "", []);
      // `invited_by` is on every Member the API returns and was never rendered. In a
      // shared-visibility team, "who added this person" is the audit question, and
      // expert is the level that would act on the answer.
      // The trailing blank column holds Remove, so it's only there when Remove can be.
      // At guided it rendered as a fourth column of empty cells with the row rules
      // running past "Joined" — which reads as a column that failed to load.
      const canRemove = canWrite && iAmOwner;
      const heads = [
        "Member",
        "Role",
        "Joined",
        ...(expert ? ["Invited by"] : []),
        ...(canRemove ? [""] : []),
      ];
      for (const h of heads) htr.append(el("th", "", [h]));
      thead.append(htr);
      table.append(thead);
      const tbody = el("tbody", "", []);
      for (const m of members) {
        const tr = el("tr", "", []);
        // Below expert, show the ARN's trailing user/role name with the full ARN in
        // the title: `arn:aws:iam::123456789012:user/alice` is 45 characters of which
        // one word identifies the person, and it wraps the table on a laptop.
        const who = expert ? tdText(m.member_arn) : tdTitled(shortArn(m.member_arn), m.member_arn);
        tr.append(who, tdText(m.role), tdText(fmtDate(m.joined_at)));
        if (expert) tr.append(tdText(m.invited_by || "—"));
        if (canRemove) {
          const actionTd = el("td", "teams-memb-action", []);
          // The owner's own row is not removable — the cell stays, to keep the column
          // aligned, but empty.
          if (m.role !== "owner") {
            const rm = el("button", "teams-remove", ["Remove"]);
            (rm as HTMLButtonElement).type = "button";
            rm.addEventListener("click", () => void removeMember(teamID, m.member_arn));
            actionTd.append(rm);
          }
          tr.append(actionTd);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      root.append(table);

      // Owner controls: add member + delete team.
      if (canWrite && iAmOwner) {
        root.append(buildAddMemberForm(teamID, () => void showDetail(teamID), api, errText));
        const danger = el("div", "teams-danger", []);
        const del = el("button", "teams-delete", ["Delete team"]);
        (del as HTMLButtonElement).type = "button";
        del.addEventListener("click", () => void deleteTeam(teamID, team.team_name));
        danger.append(del);
        root.append(danger);
      }
      if (!canWrite) root.append(buildEscape(ctx));
    }

    async function removeMember(teamID: string, memberARN: string): Promise<void> {
      if (!window.confirm(`Remove ${memberARN} from the team?`)) return;
      const res = await api(`/teams/${encodeURIComponent(teamID)}/members/${encodeURIComponent(memberARN)}`, {
        method: "DELETE",
      });
      if (disposed) return;
      if (!res.ok) {
        window.alert(`Couldn't remove member: ${errText(res.status, res.data)}`);
        return;
      }
      void showDetail(teamID);
    }

    async function deleteTeam(teamID: string, name: string): Promise<void> {
      if (!window.confirm(`Delete team "${name}"? This removes all memberships and can't be undone.`)) return;
      const res = await api(`/teams/${encodeURIComponent(teamID)}`, { method: "DELETE" });
      if (disposed) return;
      if (!res.ok) {
        window.alert(`Couldn't delete team: ${errText(res.status, res.data)}`);
        return;
      }
      void showList();
    }

    // Restore the open team from the hash, so a mode change lands back where the
    // user was rather than at the list.
    const openTeam = readHashParam("team");
    if (openTeam) void showDetail(openTeam);
    else void showList();

    return {
      dispose() {
        disposed = true;
        controller.abort();
        root.remove();
      },
    };
  },
};

/**
 * The way out of read-only, matching the picker's `.guided-escape` pattern.
 *
 * Guided mode must not be a dead end: the user who arrives here because a colleague
 * said "add me to your team" needs a route to the form, and "go find Mode in the
 * header" is not one — that's exactly the knowledge guided mode exists to not
 * require. Raising the level is the same gesture truffle's picker uses.
 */
function buildEscape(ctx: SurfaceContext): HTMLElement {
  const btn = el("button", "guided-escape", ["Manage teams →"]);
  (btn as HTMLButtonElement).type = "button";
  btn.addEventListener("click", () => ctx.session.setLevel("standard"));
  return btn;
}

/** `arn:aws:iam::123456789012:user/alice` → `user/alice`. Unrecognised input is
 *  returned whole rather than truncated to something that looks like an identity
 *  but isn't. */
function shortArn(arn: string): string {
  const i = arn.lastIndexOf(":");
  return i === -1 ? arn : arn.slice(i + 1) || arn;
}

// ── form builders ──────────────────────────────────────────────────────────
type ApiFn = (p: string, i?: { method?: string; body?: unknown }) => Promise<{ ok: boolean; status: number; data: any }>;
type ErrFn = (status: number, data: any) => string;

function buildCreateForm(onCreated: () => void, api: ApiFn, errText: ErrFn): HTMLElement {
  const details = document.createElement("details");
  details.className = "teams-create";
  const summary = document.createElement("summary");
  summary.textContent = "New team";
  details.append(summary);

  const form = document.createElement("form");
  form.className = "teams-form";
  const name = inputEl("text", "Team name", true);
  name.maxLength = 100;
  const desc = inputEl("text", "Description (optional)", false);
  desc.maxLength = 1000;
  const submit = el("button", "teams-submit", ["Create"]) as HTMLButtonElement;
  submit.type = "submit";
  const msg = el("span", "teams-formmsg", []);
  form.append(name, desc, submit, msg);
  details.append(form);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const teamName = name.value.trim();
    if (!teamName) {
      msg.textContent = "team name is required";
      msg.className = "teams-formmsg error";
      return;
    }
    submit.disabled = true;
    msg.textContent = "";
    void api("/teams", { method: "POST", body: { team_name: teamName, description: desc.value.trim() } }).then(
      (res) => {
        submit.disabled = false;
        if (!res.ok) {
          msg.textContent = errText(res.status, res.data);
          msg.className = "teams-formmsg error";
          return;
        }
        onCreated();
      },
    );
  });
  return details;
}

function buildAddMemberForm(teamID: string, onAdded: () => void, api: ApiFn, errText: ErrFn): HTMLElement {
  const form = document.createElement("form");
  form.className = "teams-form teams-addmember";
  const arn = inputEl("text", "arn:aws:iam::123456789012:user/name", true);
  const submit = el("button", "teams-submit", ["Add member"]) as HTMLButtonElement;
  submit.type = "submit";
  const msg = el("span", "teams-formmsg", []);
  form.append(arn, submit, msg);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const memberArn = arn.value.trim();
    if (!MEMBER_ARN_RE.test(memberArn)) {
      msg.textContent = "enter a valid IAM user or role ARN";
      msg.className = "teams-formmsg error";
      return;
    }
    submit.disabled = true;
    msg.textContent = "";
    void api(`/teams/${encodeURIComponent(teamID)}/members`, { method: "POST", body: { member_arn: memberArn } }).then(
      (res) => {
        submit.disabled = false;
        if (!res.ok) {
          msg.textContent = errText(res.status, res.data);
          msg.className = "teams-formmsg error";
          return;
        }
        arn.value = "";
        onAdded();
      },
    );
  });
  return form;
}

// ── tiny DOM helpers (all text via textContent — API strings are untrusted) ──
function el(tag: string, className: string, children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

function spanText(className: string, text: string): HTMLElement {
  return el("span", className, [text]);
}

function tdText(text: string): HTMLElement {
  return el("td", "", [text]);
}

/** A cell showing `text` with `title` on hover — for a shortened identity whose full
 *  form must still be recoverable without changing mode. */
function tdTitled(text: string, title: string): HTMLElement {
  const td = el("td", "", [text]);
  td.title = title;
  return td;
}

function inputEl(type: string, placeholder: string, required: boolean): HTMLInputElement {
  const i = document.createElement("input");
  i.type = type;
  i.placeholder = placeholder;
  i.required = required;
  i.className = "teams-input";
  i.autocomplete = "off";
  return i;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
