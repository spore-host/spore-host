// Gate: scripted keyboard checks (brief §7, #651). Skip link, focus to the h1
// on a route change, titles and aria-current, no keyboard trap, visible and
// unobscured focus, 44 px targets, Escape closes menus and dialogs and focus
// returns, the Settings switch applies on the next navigation, and the two
// live regions persist.
import { keyboardProblems, targetProblems } from "./checks.js";
import { appStates, appUrl, expect, GALLERY, open, test } from "./fixtures.js";

const focused = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { tag: el?.tagName ?? "", text: el?.textContent?.trim() ?? "", control: el?.dataset.control ?? "", id: el?.id ?? "" };
  });

test("the skip link is the first Tab stop and moves focus to main", async ({ page }) => {
  await open(page, { url: appUrl("/types") });
  await page.keyboard.press("Tab");
  expect(await focused(page)).toMatchObject({ control: "chrome.skip-link", text: "Skip to content" });
  await page.keyboard.press("Enter");
  expect(await focused(page)).toMatchObject({ tag: "MAIN", id: "main" });
  expect(new URL(page.url()).hash).toBe("#/types");
});

test("a route change moves focus to the h1, sets the title and aria-current", async ({ page }) => {
  await open(page, { url: appUrl("/instances", { auth: "signed-in" }) });
  for (const [control, title] of [
    ["nav.types", "Instance types and prices"],
    ["nav.spending", "Spending"],
    ["chrome.nav-help", "Help"],
    ["nav.instances", "Instances"],
  ] as const) {
    const link = page.locator(`[data-control='${control}']`);
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveTitle(`${title} — spore.host`);
    expect(await focused(page)).toMatchObject({ tag: "H1", text: title });
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(page.locator("main h1")).toHaveCount(1);
  }
});

test("the first load does not steal focus from the skip link", async ({ page }) => {
  await open(page, { url: appUrl("/types") });
  expect((await focused(page)).tag).toBe("BODY");
});

for (const s of appStates().filter((x) => x.level === "basic")) {
  test(`no trap, visible and unobscured focus, 44 px targets: ${s.name}`, async ({ page }) => {
    await open(page, s);
    expect(await keyboardProblems(page)).toEqual([]);
    expect(await targetProblems(page)).toEqual([]);
  });
}

for (const width of [320, 1280]) {
  test(`gallery at ${width} px: no trap, visible focus, 44 px targets`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, { url: GALLERY });
    expect(await keyboardProblems(page)).toEqual([]);
    expect(await targetProblems(page)).toEqual([]);
  });
}

test("at 320 px the nav folds into a Menu button that Escape closes", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await open(page, { url: appUrl("/instances", { auth: "signed-in" }) });
  const menu = page.locator("[data-control='chrome.menu']");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-control='nav.types']")).toBeHidden();
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  expect((await focused(page)).control).toBe("nav.instances");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  expect((await focused(page)).control).toBe("chrome.menu");
  // Choosing a page closes the menu and lands on the h1.
  await menu.click();
  await page.locator("[data-control='nav.types']").click();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  expect((await focused(page)).tag).toBe("H1");
});

test("the desktop top bar has no Menu button and no level control", async ({ page }) => {
  await open(page, { url: appUrl("/instances", { auth: "signed-in" }) });
  await expect(page.locator("[data-control='chrome.menu']")).toBeHidden();
  await expect(page.locator("header [data-control='chrome.settings-advanced']")).toHaveCount(0);
  await expect(page.locator("header [role=radiogroup]")).toHaveCount(0);
});

test("the account menu opens, Escape closes it and focus returns", async ({ page }) => {
  await open(page, { url: appUrl("/instances", { auth: "signed-in" }) });
  const btn = page.locator("[data-control='chrome.account-menu']");
  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".account-label")).toHaveText("AWS account ending 9012");
  await expect(page.locator(".account-location")).toHaveText("Location: US East (N. Virginia)");
  await page.keyboard.press("Tab");
  expect((await focused(page)).control).toBe("chrome.settings");
  await page.keyboard.press("Escape");
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  expect((await focused(page)).control).toBe("chrome.account-menu");
});

test("a destructive dialog starts on the safe choice, traps focus, closes on Escape and returns focus", async ({ page }) => {
  await open(page, { url: GALLERY });
  const trigger = page.locator("[data-control='gallery.open-terminate']");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toHaveAccessibleName("Terminate rnaseq-align?");
  expect((await focused(page)).text).toBe("Keep it");
  // Modal: Tab cycles inside the dialog.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog")) || document.activeElement === document.body)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect((await focused(page)).control).toBe("gallery.open-terminate");
  await expect(page.locator("#dialog-result")).toHaveText("Kept.");
});

test("a non-destructive dialog starts on its action and returns focus after it", async ({ page }) => {
  await open(page, { url: GALLERY });
  await page.locator("[data-control='gallery.open-stop']").click();
  expect((await focused(page)).text).toBe("Stop rnaseq-align");
  await page.keyboard.press("Enter");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect((await focused(page)).control).toBe("gallery.open-stop");
  await expect(page.locator("#dialog-result")).toHaveText("Stop chosen.");
});

test("the Settings switch saves now and applies on the next navigation, never in place", async ({ page }) => {
  await open(page, { url: appUrl("/settings", { auth: "signed-in" }) });
  await expect(page.locator("html")).toHaveAttribute("data-level", "basic");
  const box = page.getByLabel("Show advanced options");
  await expect(box).not.toBeChecked();
  const h1 = await page.locator("main h1").elementHandle();
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
  // Not re-rendered: same heading node, focus still on the switch, level unchanged.
  expect(await page.evaluate((el) => el?.isConnected, h1)).toBe(true);
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).id)).toBe("settings-advanced");
  await expect(page.locator("html")).toHaveAttribute("data-level", "basic");
  await expect(page.locator("#level-note")).toHaveText("Saved. Advanced options appear on the next page you open.");
  await expect(page.locator("#announce-polite")).toHaveText("Saved. Advanced options appear on the next page you open.");
  await page.locator("[data-control='nav.types']").click();
  await expect(page.locator("html")).toHaveAttribute("data-level", "advanced");
  // Saved as the preference (a reload here would re-run open()'s level preset).
  expect(await page.evaluate(() => localStorage.getItem("spore.portal.level"))).toBe("advanced");
});

test("one polite and one assertive region persist across navigation", async ({ page }) => {
  await open(page, { url: appUrl("/instances", { auth: "signed-in" }) });
  const polite = page.locator("[role=status][aria-live=polite]");
  const assertive = page.locator("[role=alert]");
  await expect(polite).toHaveCount(1);
  await expect(assertive).toHaveCount(1);
  const before = await polite.elementHandle();
  await page.locator("[data-control='nav.types']").click();
  await expect(polite).toHaveCount(1);
  await expect(assertive).toHaveCount(1);
  expect(await page.evaluate((el) => el?.isConnected, before)).toBe(true);
  // No other live region anywhere.
  await expect(page.locator("[aria-live]:not(#announce-polite)")).toHaveCount(0);
});

test("the expiry warning says the minutes left and is announced assertively", async ({ page }) => {
  await open(page, { url: appUrl("/instances", { auth: "signed-in", expiry: "warning" }) });
  await expect(page.locator(".session-alert .alert-title")).toHaveText("You'll be signed out in 4 minutes");
  await expect(page.locator("#announce-assertive")).toHaveText("You'll be signed out in 4 minutes. Sign in again to keep working.");
  await expect(page.locator("[data-control='chrome.reauth']")).toBeVisible();
});

test("signed out after expiry: the banner says the instances are still costing money", async ({ page }) => {
  await open(page, { url: appUrl("/instances", { auth: "signed-in", expiry: "expired" }) });
  await expect(page.locator(".session-alert .alert-title")).toHaveText("You've been signed out");
  await expect(page.locator(".session-alert")).toContainText("still running and still costing money");
});
