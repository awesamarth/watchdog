import { expect, test } from "@playwright/test";

test("reveal page renders a screenshot-ready Watchdog lockup", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 675 });
  await page.goto("/reveal");
  await expect(page.getByRole("heading", { name: "WATCHDOG" })).toBeVisible();
  await expect(page.getByText("YOUR AGENTS ARE RUNNING.")).toBeVisible();
  await expect(page.getByText("SEE WHAT THEY’RE REALLY DOING.")).toBeVisible();
  await expect(page.getByLabel("Watchdog monitors subagents, loops, and execution graphs")).toBeVisible();
  const logo = page.getByAltText("Watchdog German shepherd mascot");
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/reveal.png", fullPage: true });

  await page.setViewportSize({ width: 2000, height: 1133 });
  const frameBox = await page.locator(".reveal-frame").boundingBox();
  const titleBox = await page.getByRole("heading", { name: "WATCHDOG" }).boundingBox();
  const footerBox = await page.locator(".reveal-footer").boundingBox();
  expect(frameBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(titleBox!.x + titleBox!.width).toBeLessThan(frameBox!.x + frameBox!.width);
  expect(footerBox!.x + footerBox!.width).toBeLessThanOrEqual(frameBox!.x + frameBox!.width);
  await page.screenshot({ path: "test-results/reveal-wide.png", fullPage: true });

  await page.setViewportSize({ width: 600, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(600);
});
