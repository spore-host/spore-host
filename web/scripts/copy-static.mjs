// The whole production build: copy the no-build pages + shared static dirs into
// dist/ verbatim (apart from removing feature-flagged blocks, see
// static-flags.mjs). These pages have no module graph, so they bypass a bundler
// entirely (Vite's strict HTML parser would also reject the literal `&` in their
// URLs).
//
// app/index.html is the static placeholder served at spore.host/app while the
// portal is rebuilt (spore-host#645). Vite no longer builds anything, so this
// script owns emptying dist/ first: a stale dist/assets/app-*.js from an old
// build must never ride along into a deploy.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { applyStaticFlags } from "./static-flags.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(web, "dist");

const pages = ["index.html", "privacy.html", "terms.html", "library.html", "app/index.html"];
const dirs = ["css", "assets"];

// Build-time flags: .env, .env.production and the process environment, VITE_*
// only (see scripts/static-flags.mjs).
const env = loadEnv("production", web, "VITE_");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const p of pages) {
  const html = await readFile(resolve(web, p), "utf8");
  await mkdir(dirname(resolve(dist, p)), { recursive: true });
  await writeFile(resolve(dist, p), applyStaticFlags(html, env, p));
}
for (const d of dirs) {
  await cp(resolve(web, d), resolve(dist, d), { recursive: true });
}

// The BYOA onboarding CloudFormation template, served publicly. The old portal's
// "Connect account" quick-create URL pointed CloudFormation at it, and stacks
// created that way may still reference it, so it stays published while the
// portal is rebuilt. Lives in the repo's deployment/ dir (one level above web/),
// copied to dist/cloudformation/.
const cfnSrc = resolve(web, "..", "deployment", "cloudformation", "portal-onboarding-role.yaml");
const cfnDest = resolve(dist, "cloudformation", "portal-onboarding-role.yaml");
await mkdir(dirname(cfnDest), { recursive: true });
await cp(cfnSrc, cfnDest);

console.log(`copied ${pages.length} pages + ${dirs.join(", ")} + onboarding template → dist/`);
