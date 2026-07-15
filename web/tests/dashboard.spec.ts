import { expect, test } from "@playwright/test";

test("yard, mascot interaction, and operator view render", async ({ page }) => {
  const smokeLoaded = page.waitForResponse((response) => response.url().endsWith("/assets/smoke-sprites.png"));
  await page.goto("/");
  expect((await smokeLoaded).ok()).toBe(true);
  await expect(page.getByText("WATCHDOG", { exact: true })).toBeVisible();
  const logo = page.locator(".brand-mark");
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText("Demo yard · no live controls")).toBeVisible();
  const canvas = page.getByLabel("Interactive pixel-art rail yard");
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const dog = { x: box!.x + box!.width * .14, y: box!.y + box!.height * .25 };
  await page.mouse.move(dog.x, dog.y);
  await expect.poll(() => canvas.evaluate((node) => node.style.cursor)).toBe("pointer");
  await page.mouse.click(dog.x, dog.y);
  await page.waitForTimeout(180);
  await expect(canvas).toBeVisible();
  await page.screenshot({ path: "test-results/yard-day-pet.png", fullPage: true });
  await page.mouse.move(box!.x + box!.width * .75, box!.y + box!.height * .1);
  await expect.poll(() => canvas.evaluate((node) => node.style.cursor)).toBe("default");

  await page.getByRole("button", { name: "OPERATOR" }).click();
  await expect(page.getByRole("heading", { name: "Execution graph" })).toBeVisible();
  await expect(page.getByText("RUN TOPOLOGY")).toBeVisible();
  await expect(page.getByText("Feynman").first()).toBeVisible();
  await expect(page.getByText("20 clean checkout runs and the regression suite passes")).toBeVisible();
  await page.screenshot({ path: "test-results/operator.png", fullPage: true });

  await page.getByRole("button", { name: "YARD" }).click();
  await page.getByRole("button", { name: "Toggle day and night" }).click();
  await expect(canvas).toBeVisible();
  await page.screenshot({ path: "test-results/yard-night.png", fullPage: true });
});
