// Gate: 320 px reflow (SC 1.4.10) on every route and gallery state, with and
// without the SC 1.4.12 text-spacing overrides. Desktop-first (D14), but the
// layout must not break.
import { applyTextSpacing, reflowProblems } from "./checks.js";
import { appStates, expect, GALLERY, GALLERY_STATES, open, SHELL_INTERACTIONS, test } from "./fixtures.js";

test.use({ viewport: { width: 320, height: 640 } });

for (const spacing of [false, true]) {
  test.describe(spacing ? "320 px with text-spacing overrides" : "320 px", () => {
    for (const s of appStates().filter((x) => x.level === "basic")) {
      test(s.name, async ({ page }) => {
        await open(page, s);
        if (spacing) await applyTextSpacing(page);
        expect(await reflowProblems(page)).toEqual([]);
      });
    }

    for (const g of GALLERY_STATES) {
      test(g.name, async ({ page }) => {
        await open(page, { url: GALLERY });
        await g.act?.(page);
        if (spacing) await applyTextSpacing(page);
        expect(await reflowProblems(page)).toEqual([]);
      });
    }
  });
}

for (const i of SHELL_INTERACTIONS.filter((x) => x.width === 320)) {
  test(`320 px: ${i.name}`, async ({ page }) => {
    await open(page, { url: "/index.html?state=signed-in#/instances" });
    await i.act(page);
    expect(await reflowProblems(page)).toEqual([]);
  });
}
