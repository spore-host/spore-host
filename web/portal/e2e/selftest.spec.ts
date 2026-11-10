// Every rendered-page gate must be able to FAIL. selftest.html (gate build
// only) carries one planted defect per gate; each check below must report
// it. If a check is weakened until it passes everything, this spec goes red.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderedProblems, type Matrix } from "../parity/matrix.js";
import { axeProblems, controls, copyProblems, keyboardProblems, reflowProblems, targetProblems } from "./checks.js";
import { expect, open, SELFTEST, test } from "./fixtures.js";

const matrix = JSON.parse(readFileSync(resolve(import.meta.dirname, "../parity/cli-gui-matrix.json"), "utf8")) as Matrix;

test.describe("gate self-test: every check catches its planted defect", () => {
  test("axe catches the unlabelled field and the low-contrast text", async ({ page }) => {
    await open(page, { url: SELFTEST });
    const p = await axeProblems(page);
    expect(p.some((x) => x.startsWith("label "))).toBe(true);
    expect(p.some((x) => x.startsWith("color-contrast "))).toBe(true);
  });

  test("reflow catches the 480 px box at 320 px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, { url: SELFTEST });
    expect((await reflowProblems(page))[0]).toMatch(/^page is \d+px wide in a 320px viewport$/);
  });

  test("the copy lint catches the banned words", async ({ page }) => {
    await open(page, { url: SELFTEST });
    const p = (await copyProblems(page, "selftest")).join("\n");
    for (const w of ['"machine"', '"shut down"', '"TTL"', '"spawn"', '"reap"', '"orphan"']) expect(p).toContain(w);
  });

  test("the matrix catches the unlabelled control and the control with no CLI row", async ({ page }) => {
    await open(page, { url: SELFTEST });
    const observed = new Map<string, string[]>();
    const unlabelled: string[] = [];
    for (const c of await controls(page)) {
      if (c.control === null) unlabelled.push(c.what);
      else observed.set(c.control, ["selftest"]);
    }
    const p = renderedProblems(matrix, observed, unlabelled);
    expect(p).toContain('interactive element with no data-control: button "Reboot"');
    expect(p).toContain('GUI control "instance.reboot" (on selftest) has no CLI row and is not chrome');
  });

  test("the keyboard walk catches the missing focus ring and the trap", async ({ page }) => {
    await open(page, { url: SELFTEST });
    const p = await keyboardProblems(page);
    expect(p.some((x) => x.startsWith("no visible focus indicator on a selftest.no-ring"))).toBe(true);
    expect(p.some((x) => x.startsWith("keyboard trap:"))).toBe(true);
  });

  test("the target-size check catches the 20 px button", async ({ page }) => {
    await open(page, { url: SELFTEST });
    expect(await targetProblems(page)).toContain('button selftest.tiny "x" is 20x20');
  });
});
