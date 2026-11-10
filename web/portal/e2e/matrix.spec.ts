// Gate: the CLI⇄GUI matrix against the RENDERED app. Collects every
// interactive element on every route, sign-in state and level (menus open, at
// both widths), then: an element with no data-control fails, a control with
// no CLI row and no chrome reason fails, and a shipped basic row whose
// controls no route renders fails (parity/matrix.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { renderedProblems, type Matrix } from "../parity/matrix.js";
import { controls } from "./checks.js";
import { appStates, expect, open, test, type State } from "./fixtures.js";

const matrix = JSON.parse(readFileSync(resolve(import.meta.dirname, "../parity/cli-gui-matrix.json"), "utf8")) as Matrix;

test("every rendered control maps to a CLI row or is chrome, and every shipped basic row is rendered", async ({ context, page }) => {
  test.setTimeout(240_000);
  const observed = new Map<string, string[]>();
  const unlabelled = new Set<string>();
  const record = async (p: Page, where: string) => {
    for (const c of await controls(p)) {
      if (c.control === null) unlabelled.add(`${c.what} on ${where}`);
      else observed.set(c.control, [...(observed.get(c.control) ?? []), where]);
    }
  };
  const visit = async (p: Page, s: State, width: number) => {
    await p.setViewportSize({ width, height: 800 });
    await open(p, s);
    await record(p, `${s.name} @${width}`);
    if (s.auth === "signed-in") {
      if (width === 320) await p.locator("[data-control='chrome.menu']").click();
      await p.locator("[data-control='chrome.account-menu']").click();
      await record(p, `${s.name} @${width} menus open`);
    }
  };
  const work = [1280, 320].flatMap((w) => appStates().map((s) => [s, w] as const));
  // Four pages walk the states in parallel; the fixture blocks AWS on the whole context.
  const pages = [page, ...(await Promise.all([1, 2, 3].map(() => context.newPage())))];
  await Promise.all(
    pages.map(async (p) => {
      for (let item = work.shift(); item; item = work.shift()) await visit(p, item[0], item[1]);
    }),
  );
  expect(observed.size, "the walk found no controls at all").toBeGreaterThan(5);
  expect(renderedProblems(matrix, observed, [...unlabelled])).toEqual([]);
});
