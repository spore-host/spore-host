// The onboarding surface: "Connect your AWS account" (BYOA). The no-auth-required
// path for a user to grant the portal access to their own account, modeled on
// Coiled's flow: generate a per-account ExternalId, then hand off to the AWS
// CloudFormation console via a prefilled quick-create URL for
// deployment/cloudformation/portal-onboarding-role.yaml. The template's
// phone-home custom resource auto-registers the new role with the portal on stack
// create, so there's nothing to copy-paste back.
//
// Disclosure: this surface is already written in guided register — four numbered
// steps, one CTA, and the technical detail (what the role can do, the CLI
// equivalent, the ExternalId) behind a `<details>`. So the only level-dependent
// thing is whether that `<details>` starts open.
import type { Disposable, PortalConfig, SurfaceContext, ToolSurface } from "./types.js";
import { atLeast } from "../disclosure.js";

export const onboardingSurface: ToolSurface = {
  id: "connect",
  label: "Connect account",
  accent: "--bot",
  requiresAuth: false,

  async mount(host: HTMLElement, ctx: SurfaceContext): Promise<Disposable> {
    const root = document.createElement("div");
    root.className = "onboard-surface";
    const cfg = ctx.config.onboarding;

    // Missing config → show what an operator must set, don't render a broken CTA.
    const missing: string[] = [];
    if (!cfg.templateUrl) missing.push("template URL");
    if (!cfg.phoneHomeRoleArn) missing.push("phone-home role ARN");
    if (missing.length) {
      root.innerHTML = `
        <div class="onboard-panel">
          <h2>Connect your AWS account</h2>
          <p class="onboard-unconfigured">Onboarding isn't configured for this
            deployment yet (missing: ${escapeHtml(missing.join(", "))}). Set the
            <code>VITE_ONBOARD_TEMPLATE_URL</code> / <code>VITE_PHONE_HOME_ROLE_ARN</code>
            build vars from <code>infra/tofu/portal-phone-home</code>'s outputs.</p>
        </div>`;
      host.appendChild(root);
      return { dispose: () => root.remove() };
    }

    const externalId = generateExternalId();

    root.innerHTML = `
      <div class="onboard-panel">
        <h2>Connect your AWS account</h2>
        <p>Grant spore.host permission to launch and manage EC2 in <b>your own</b>
          AWS account. This opens the AWS console with a CloudFormation stack
          pre-filled — review it, then <b>Create stack</b>. Nothing to copy back:
          the stack registers itself with the portal automatically.</p>

        <ol class="onboard-steps">
          <li>Sign in to the AWS account you want to use (in another tab).</li>
          <li>Click <b>Launch the CloudFormation stack</b> below.</li>
          <li>Leave the pre-filled parameters as-is and create the stack.</li>
          <li>When it completes (~1 min), your account appears in the portal.</li>
        </ol>

        <div class="onboard-region">
          <label>Region
            <select class="onboard-region-select">
              ${REGIONS.map((r) => `<option value="${r}"${r === ctx.config.region ? " selected" : ""}>${r}</option>`).join("")}
            </select>
          </label>
        </div>

        <a class="onboard-launch" target="_blank" rel="noopener">Launch the CloudFormation stack ↗</a>

        <!-- Open at expert: an expert reading "grant spore.host permission to launch
             EC2 in your own account" wants the IAM scope before the CTA, not after
             clicking to find it. Below expert it stays collapsed — the whole design
             of this surface is that you can complete it without reading this. -->
        <details class="onboard-details"${atLeast(ctx.level, "expert") ? " open" : ""}>
          <summary>What this creates / prefer the CLI?</summary>
          <p>The stack creates an IAM role (<code>spore-portal-onboard</code>) that
            trusts the portal under a one-time ExternalId, scoped to EC2 launch +
            SSM + passing the spored instance profile. Destructive actions are
            limited to <code>spawn:managed</code> instances.</p>
          <p>Prefer the terminal? Run <code>spawn onboard</code> with credentials
            for the account — it does the same thing without the console.</p>
          <p class="onboard-extid">This session's ExternalId:
            <code>${escapeHtml(externalId)}</code></p>
        </details>
      </div>`;
    host.appendChild(root);

    const launch = root.querySelector<HTMLAnchorElement>(".onboard-launch")!;
    const regionSelect = root.querySelector<HTMLSelectElement>(".onboard-region-select")!;

    const updateUrl = () => {
      launch.href = quickCreateUrl(cfg, regionSelect.value, externalId);
    };
    updateUrl();
    regionSelect.addEventListener("change", updateUrl);

    return {
      dispose() {
        regionSelect.removeEventListener("change", updateUrl);
        root.remove();
      },
    };
  },
};

// The regions a stack can be created in (the role is global, but the console
// quick-create is region-scoped and the phone-home records the launch region).
const REGIONS = ["us-east-1", "us-west-2", "us-east-2", "eu-west-1", "eu-central-1", "ap-southeast-2"];

/**
 * Build a CloudFormation console quick-create URL that pre-fills the onboarding
 * stack. The console reads templateURL + stackName + param_<Name> from the query
 * string of the #/stacks/quickcreate hash route.
 */
function quickCreateUrl(cfg: PortalConfig["onboarding"], region: string, externalId: string): string {
  const params = new URLSearchParams({
    templateURL: cfg.templateUrl,
    stackName: "spore-portal-onboard",
    param_PhoneHomeLambdaRoleArn: cfg.phoneHomeRoleArn,
    param_ExternalId: externalId,
  });
  if (cfg.phoneHomeUrl) params.set("param_PhoneHomeUrl", cfg.phoneHomeUrl);
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(
    region,
  )}#/stacks/quickcreate?${params.toString()}`;
}

/** A high-entropy hex ExternalId (WebCrypto), matching `spawn onboard`'s format. */
function generateExternalId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
