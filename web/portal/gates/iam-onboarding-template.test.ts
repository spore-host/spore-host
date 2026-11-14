// Gate: the BYOA onboarding template's SSM session grants match the portal
// role's (#726). deployment/cloudformation/portal-onboarding-role.yaml carried
// the account-less SSM-SessionManagerRunShell ARN, which denies every
// StartSession, for weeks after infra/tofu/portal-oidc fixed the same bug on
// the live role. Both roles open sessions the same way, so they must grant the
// same session documents, and the template must gate the instance target on
// spawn:managed as the portal role does.
//
// Statement-level only, and only these statements: the template's EC2 grants
// differ from the portal role's by design (tag-at-launch, no Globus identity),
// and the portal role's per-caller scoping has no counterpart in a role the
// phone-home Lambda assumes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PolicyFile } from "../iam/simulate.js";

const here = import.meta.dirname;
const TEMPLATE = resolve(here, "../../../deployment/cloudformation/portal-onboarding-role.yaml");
const portal = JSON.parse(readFileSync(resolve(here, "../iam/policies/portal-launch-role.json"), "utf8")) as PolicyFile;

interface TemplateStatement {
  sid: string;
  actions: string[];
  resources: string[];
  conditionKeys: string[];
}

/** `!Sub '...${AWS::AccountId}...'` and `'...'` to the portal file's `${ACCOUNT_ID}` form. */
const normalize = (v: string) =>
  v
    .replace(/^!Sub\s+/, "")
    .replace(/^['"]|['"]$/g, "")
    .replaceAll("${AWS::AccountId}", "${ACCOUNT_ID}");

/**
 * The `- Sid:` statements of a template, without a YAML parser (CloudFormation
 * tags such as !Sub and !If are not plain YAML). Each statement runs from its
 * `- Sid:` line to the next line at the same or a shallower indent.
 */
function templateStatements(text: string): TemplateStatement[] {
  const lines = text.split("\n");
  const out: TemplateStatement[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)- Sid:\s*(\S+)/.exec(lines[i]);
    if (!head) continue;
    const indent = head[1].length;
    const st: TemplateStatement = { sid: head[2], actions: [], resources: [], conditionKeys: [] };
    let field = "";
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].replace(/\s+#.*$/, "");
      if (/^\s*#/.test(line) || line.trim() === "") continue;
      const ind = line.length - line.trimStart().length;
      if (ind <= indent) break;
      const kv = /^\s*(Action|Resource|Condition|Effect):\s*(.*)$/.exec(line);
      if (kv) {
        field = kv[1];
        if (kv[2] && field === "Action") st.actions.push(normalize(kv[2]));
        if (kv[2] && field === "Resource") st.resources.push(normalize(kv[2]));
        continue;
      }
      const item = /^\s*-\s+(.*)$/.exec(line);
      if (item && field === "Action") st.actions.push(normalize(item[1]));
      else if (item && field === "Resource") st.resources.push(normalize(item[1]));
      else if (field === "Condition") {
        const key = /^\s*'([a-z0-9-]+:[^']+)':/.exec(line);
        if (key) st.conditionKeys.push(key[1]);
      }
    }
    out.push(st);
  }
  return out;
}

const startSession = (actions: string[]) => actions.includes("ssm:StartSession");
const isDocument = (r: string) => r.startsWith("arn:aws:ssm:") && r.includes(":document/");
const isInstance = (r: string) => r.startsWith("arn:aws:ec2:") && r.includes(":instance/");
const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

function portalSessionStatements() {
  return Object.values(portal.policies)
    .flatMap((p) => p.Statement)
    .filter((s) => s.Effect === "Allow" && startSession(list(s.Action)));
}

function templateDocuments(text: string): string[] {
  return templateStatements(text)
    .filter((s) => startSession(s.actions))
    .flatMap((s) => s.resources.filter(isDocument))
    .sort();
}

const portalDocuments = () =>
  portalSessionStatements()
    .flatMap((s) => list(s.Resource).filter(isDocument))
    .sort();

describe("onboarding template: SSM session grants match the portal role", () => {
  const text = readFileSync(TEMPLATE, "utf8");

  it("grants StartSession on the same session documents", () => {
    expect(portalDocuments().length).toBeGreaterThan(0);
    expect(templateDocuments(text)).toEqual(portalDocuments());
  });

  it("scopes SSM-SessionManagerRunShell to the account (the account-less form names only AWS-owned documents)", () => {
    for (const d of templateDocuments(text).filter((r) => r.endsWith("/SSM-SessionManagerRunShell"))) {
      expect(d).toBe("arn:aws:ssm:*:${ACCOUNT_ID}:document/SSM-SessionManagerRunShell");
    }
  });

  it("gates every StartSession instance target on ssm:resourceTag/spawn:managed", () => {
    const targets = templateStatements(text).filter((s) => startSession(s.actions) && s.resources.some(isInstance));
    expect(targets.length).toBeGreaterThan(0);
    for (const s of targets) expect(s.conditionKeys, s.sid).toContain("ssm:resourceTag/spawn:managed");
    for (const s of portalSessionStatements().filter((p) => list(p.Resource).some(isInstance))) {
      expect(Object.values(s.Condition ?? {}).flatMap((kv) => Object.keys(kv))).toContain("ssm:resourceTag/spawn:managed");
    }
  });

  it("fails on the account-less document ARN this gate exists for", () => {
    const broken = text.replace(
      "!Sub 'arn:aws:ssm:*:${AWS::AccountId}:document/SSM-SessionManagerRunShell'",
      "'arn:aws:ssm:*::document/SSM-SessionManagerRunShell'",
    );
    expect(broken).not.toBe(text);
    expect(templateDocuments(broken)).not.toEqual(portalDocuments());
  });

  it("fails when the template drops a document the portal role grants", () => {
    const broken = text.replace("                  - 'arn:aws:ssm:*:*:document/AWS-StartInteractiveCommand'\n", "");
    expect(broken).not.toBe(text);
    expect(templateDocuments(broken)).not.toEqual(portalDocuments());
  });
});
