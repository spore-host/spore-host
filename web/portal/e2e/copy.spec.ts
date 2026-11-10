// Gate: the banned-words copy lint over the RENDERED basic-mode copy of every
// route and the gallery (brief §6 rule 3), using the glossary's forbidden
// terms. The command-line footer, "Details for support" and the "AWS type"
// label are exempt ([data-copy-exempt]).
import { copyProblems } from "./checks.js";
import { appStates, expect, GALLERY, GALLERY_STATES, open, SHELL_INTERACTIONS, test } from "./fixtures.js";

for (const s of appStates().filter((x) => x.level === "basic")) {
  test(`copy: ${s.name}`, async ({ page }) => {
    await open(page, s);
    expect(await copyProblems(page, s.name)).toEqual([]);
  });
}

for (const g of GALLERY_STATES) {
  test(`copy: ${g.name}`, async ({ page }) => {
    await open(page, { url: GALLERY });
    await g.act?.(page);
    expect(await copyProblems(page, g.name)).toEqual([]);
  });
}

for (const i of SHELL_INTERACTIONS) {
  test(`copy: ${i.name}`, async ({ page }) => {
    await page.setViewportSize({ width: i.width, height: 800 });
    await open(page, { url: "/index.html?state=signed-in#/instances" });
    await i.act(page);
    expect(await copyProblems(page, i.name)).toEqual([]);
  });
}
