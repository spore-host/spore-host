// Gate: axe-core (WCAG 2.0/2.1/2.2 A + AA) reports zero violations on every
// route, sign-in state, level and interaction state, at desktop and 320 px,
// and on every gallery state (brief §7, #651).
import { axeProblems } from "./checks.js";
import { appStates, expect, GALLERY, GALLERY_STATES, open, SHELL_INTERACTIONS, test } from "./fixtures.js";

for (const width of [1280, 320]) {
  test.describe(`axe at ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });

    for (const s of appStates()) {
      test(s.name, async ({ page }) => {
        await open(page, s);
        expect(await axeProblems(page)).toEqual([]);
      });
    }

    for (const g of GALLERY_STATES) {
      test(g.name, async ({ page }) => {
        await open(page, { url: GALLERY });
        await g.act?.(page);
        expect(await axeProblems(page)).toEqual([]);
      });
    }
  });
}

for (const i of SHELL_INTERACTIONS) {
  test(`axe: ${i.name} at ${i.width} px`, async ({ page }) => {
    await page.setViewportSize({ width: i.width, height: 800 });
    await open(page, { url: "/index.html?state=signed-in#/instances" });
    await i.act(page);
    expect(await axeProblems(page)).toEqual([]);
  });
}
