// Copy the no-build marketing pages + shared static dirs into dist/ verbatim
// (apart from removing feature-flagged blocks, see static-flags.mjs),
// after `vite build` has emitted the portal SPA under dist/app/. These pages have
// no module graph — Vite would only risk mangling them (its strict HTML parser
// rejects the literal `&` in their URLs), so they bypass the bundler entirely.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { applyStaticFlags } from "./static-flags.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(web, "dist");

const pages = ["index.html", "privacy.html", "terms.html", "library.html"];
const dirs = ["css", "assets"];

// The same flags the portal build saw: .env, .env.production and the process
// environment, VITE_* only (see scripts/static-flags.mjs).
const env = loadEnv("production", web, "VITE_");

await mkdir(dist, { recursive: true });
for (const p of pages) {
  const html = await readFile(resolve(web, p), "utf8");
  await writeFile(resolve(dist, p), applyStaticFlags(html, env, p));
}
for (const d of dirs) {
  await cp(resolve(web, d), resolve(dist, d), { recursive: true });
}

// The BYOA onboarding CloudFormation template — served publicly so the portal's
// "Connect account" quick-create URL can point CloudFormation at it. Lives in the
// repo's deployment/ dir (one level above web/), copied to dist/cloudformation/.
const cfnSrc = resolve(web, "..", "deployment", "cloudformation", "portal-onboarding-role.yaml");
const cfnDest = resolve(dist, "cloudformation", "portal-onboarding-role.yaml");
await mkdir(dirname(cfnDest), { recursive: true });
await cp(cfnSrc, cfnDest);

console.log(`copied ${pages.length} pages + ${dirs.join(", ")} + onboarding template → dist/`);
