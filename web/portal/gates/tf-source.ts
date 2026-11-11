// Reading infra/tofu/portal-oidc/main.tf from the gates, without an HCL parser:
// the policies there are jsonencode() blocks with one attribute per line, which
// is the shape `tofu fmt` keeps them in.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const TF_PATH = resolve(import.meta.dirname, "../../../infra/tofu/portal-oidc/main.tf");
export const readTf = (): string => readFileSync(TF_PATH, "utf8");

/** The text from `name = "<name>"` to the next top-level resource. */
export function tfPolicyBlock(source: string, name: string): string | null {
  const at = source.indexOf(`name = "${name}"`);
  if (at === -1) return null;
  const end = source.indexOf('\nresource "', at);
  return source.slice(at, end === -1 ? undefined : end);
}

/** The text of `resource "<type>" "<label>" {` up to the next top-level block. */
export function tfResource(source: string, type: string, label: string): string | null {
  const head = `resource "${type}" "${label}" {`;
  const at = source.indexOf(head);
  if (at === -1) return null;
  const rest = source.slice(at + head.length);
  const end = rest.search(/\n(resource|output|variable|locals|data) /);
  return head + (end === -1 ? rest : rest.slice(0, end));
}

/** IAM actions named in Action = ... lines of an HCL policy block. Comments stripped. */
export function tfActions(block: string): string[] {
  const clean = block.replace(/#.*$/gm, "");
  const out: string[] = [];
  for (const m of clean.matchAll(/Action\s*=\s*(\[[^\]]*\]|"[^"]*")/g)) {
    for (const a of m[1].matchAll(/"([a-z0-9-]+:[A-Za-z0-9*]+)"/g)) out.push(a[1]);
  }
  return out.sort();
}
