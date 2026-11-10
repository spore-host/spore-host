// The Slack surface: connect a Slack workspace to spore.host so the bot can post
// notifications (spawn events, budgets…). The OAuth flow is server-driven by the
// shared dashboard-api: GET /api/slack/oauth issues a PKCE + signed-state redirect
// to Slack, and Slack calls back to /api/slack/oauth/callback which stores the
// workspace and redirects back with ?bot=connected. This surface launches that
// flow and reflects the return status.
//
// Unlike the other Slice 5 surfaces this one needs no X-AWS-Credentials: the
// OAuth endpoints are intentionally unauthenticated (they're hit by Slack's
// redirect, not an authenticated fetch), and the secrets live server-side
// (Secrets Manager — see spawn#446). So this is a thin launcher + status view.
import type { Disposable, SurfaceContext, ToolSurface } from "./types.js";

export const slackSurface: ToolSurface = {
  id: "slack",
  label: "Slack",
  accent: "--bot",
  requiresAuth: false,

  async mount(host: HTMLElement, ctx: SurfaceContext): Promise<Disposable> {
    const root = document.createElement("div");
    root.className = "slack-surface";

    // The OAuth start endpoint on the shared API. A full-page navigation (not a
    // fetch) — Slack's consent screen + callback need a top-level browsing
    // context, and the flow ends by redirecting back to the dashboard.
    const startUrl = `${ctx.config.apiBase}/api/slack/oauth`;

    // Reflect a return from the OAuth round-trip. The callback redirects to
    // DASHBOARD_URL with bot=connected / workspace_name=… or error=…; if that's
    // pointed at the portal, surface it. Read from both query + hash (the portal
    // is a hash-router, so params may ride either).
    const status = readReturnStatus();

    const banner = status
      ? status.ok
        ? `<div class="slack-banner ok">✓ Connected${status.workspace ? ` <b>${escapeHtml(status.workspace)}</b>` : ""} to Slack.</div>`
        : `<div class="slack-banner error">Slack connection failed: ${escapeHtml(status.error ?? "unknown error")}.</div>`
      : "";

    root.innerHTML = `
      <div class="slack-head">
        <h2>Slack</h2>
        <p class="slack-hint">Connect a Slack workspace so spore.host can post
          notifications — launch/termination events, budget alerts, and bot
          commands — into your channels.</p>
      </div>
      ${banner}
      <div class="slack-panel">
        <a class="slack-connect" href="${escapeAttr(startUrl)}">Add to Slack</a>
        <p class="slack-note">You'll pick a workspace and channel on Slack's own
          consent screen, then land back here. spore.host never sees your Slack
          password — only a scoped bot token, held server-side.</p>
      </div>
      <details class="slack-details">
        <summary>What gets requested</summary>
        <ul class="slack-scopes">
          <li><code>commands</code> — slash commands (e.g. <code>/spawn</code>)</li>
          <li><code>chat:write</code> — post messages as the bot</li>
          <li><code>incoming-webhook</code> — post to the channel you choose</li>
          <li><code>users:read</code>, <code>users:read.email</code> — map Slack users to accounts</li>
        </ul>
      </details>`;
    host.appendChild(root);

    return {
      dispose() {
        root.remove();
      },
    };
  },
};

interface ReturnStatus {
  ok: boolean;
  workspace?: string;
  error?: string;
}

// Parse OAuth return params from the URL (query string and/or hash query).
function readReturnStatus(): ReturnStatus | null {
  const params = new URLSearchParams(window.location.search);
  // Hash may be "#/slack?bot=connected" — pull any query part after the route.
  const hash = window.location.hash;
  const qIdx = hash.indexOf("?");
  if (qIdx >= 0) {
    const hashParams = new URLSearchParams(hash.slice(qIdx + 1));
    for (const [k, v] of hashParams) if (!params.has(k)) params.set(k, v);
  }
  if (params.get("bot") === "connected") {
    return { ok: true, workspace: params.get("workspace_name") ?? undefined };
  }
  if (params.has("error")) {
    return { ok: false, error: params.get("error") ?? undefined };
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// Attribute-context escape for the href (defends against a crafted apiBase).
function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
