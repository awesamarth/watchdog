import { expect, test } from "@playwright/test";

test("yard, mascot interaction, operator controls, and retry flow render", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const health = await (await page.request.get("/healthz")).json();
  expect(health).toEqual({ service: "watchdog-dashboard" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No running sessions" })).toBeVisible();
  await expect(page.getByText("No running sessions · Watchdog runtime offline")).toBeVisible();
  await page.getByRole("button", { name: "Copy watchdog codex" }).click();
  await expect(page.getByRole("button", { name: "Copied watchdog codex" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("COPIED");
  await expect(page.getByRole("button", { name: "Copy watchdog codex" })).toBeVisible({ timeout: 2_000 });
  const emptyCanvas = page.getByLabel("Interactive pixel-art rail yard");
  await expect(emptyCanvas).toBeVisible();
  const emptyBox = await emptyCanvas.boundingBox();
  expect(emptyBox).not.toBeNull();
  await page.waitForTimeout(120);
  await page.mouse.move(emptyBox!.x + emptyBox!.width * .14, emptyBox!.y + emptyBox!.height * .25);
  await expect.poll(() => emptyCanvas.evaluate((node) => node.style.cursor)).toBe("pointer");
  await page.screenshot({ path: "test-results/yard-empty.png", fullPage: true });
  await page.mouse.click(emptyBox!.x + emptyBox!.width * .14, emptyBox!.y + emptyBox!.height * .25);
  const liveState = await (await page.request.get("/api/state")).json() as { snapshot: { agents: unknown[] } };
  expect(liveState.snapshot.agents).toHaveLength(0);

  const smokeLoaded = page.waitForResponse((response) => response.url().endsWith("/assets/smoke-sprites.png"));
  await page.goto("/demo");
  expect((await smokeLoaded).ok()).toBe(true);
  await expect(page.getByText("WATCHDOG", { exact: true })).toBeVisible();
  const logo = page.locator(".brand-mark");
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText("SIMULATED DEMO · deterministic rehearsal · controls enabled")).toBeVisible();
  await expect(page.getByText("WATCHING DEMO", { exact: true })).toBeVisible();
  const runPicker = page.getByLabel("Watchdog run");
  await expect(runPicker.locator("option")).toHaveCount(2);
  const runIds = await runPicker.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  const initialRunId = await runPicker.inputValue();
  const alternateRunId = runIds.find((runId) => runId !== initialRunId)!;
  await runPicker.selectOption(alternateRunId);
  await expect(runPicker).toHaveValue(alternateRunId);
  const canvas = page.getByLabel("Interactive pixel-art rail yard");
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width / box!.height).toBeCloseTo(1100 / 680, 2);
  const dog = { x: box!.x + box!.width * .14, y: box!.y + box!.height * .25 };
  // The canvas builds hit regions on its first animation frame.
  await page.waitForTimeout(120);
  await page.mouse.move(dog.x, dog.y);
  await expect.poll(() => canvas.evaluate((node) => node.style.cursor)).toBe("pointer");
  await page.mouse.click(dog.x, dog.y);
  await page.waitForTimeout(180);
  await expect(canvas).toBeVisible();
  for (let index = 0; index < 12; index += 1) {
    await page.mouse.click(dog.x, dog.y);
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(950);
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: "test-results/yard-day-pet.png", fullPage: true });
  await page.mouse.move(box!.x + box!.width * .75, box!.y + box!.height * .1);
  await expect.poll(() => canvas.evaluate((node) => node.style.cursor)).toBe("default");

  // A declared subgraph station opens a nested Yard without losing the parent.
  await page.mouse.click(box!.x + box!.width * (527 / 1100), box!.y + box!.height * (325 / 680));
  await expect(page.getByRole("button", { name: "Repair yard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Checkout repair" })).toBeVisible();
  await page.getByRole("button", { name: "Checkout repair" }).click();

  // A Yard carriage must open that exact subagent's operational details first.
  await page.mouse.click(box!.x + box!.width * (520 / 1100), box!.y + box!.height * (205 / 680));
  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("heading", { name: "Locke" })).toBeVisible();
  await expect(inspector.getByText("SUBAGENT CAR")).toBeVisible();
  await expect(inspector.getByText("ASSIGNMENT", { exact: true })).toBeVisible();
  await expect(inspector.getByText("CURRENT ACTION", { exact: true })).toBeVisible();
  await expect(inspector.getByText("MESSAGE HISTORY", { exact: true })).toBeVisible();
  await expect(inspector.getByText("LIVE RESPONSE", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Locke started the assignment and is gathering evidence.", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Locke is trace callbacks; latest findings are being checked before reporting.", { exact: true })).toBeVisible();
  await expect(inspector.locator(".message-entry")).toHaveCount(3);
  expect(await inspector.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "test-results/yard-child-inspector.png", fullPage: true });

  const splitter = page.getByRole("separator", { name: "Resize inspector" });
  await expect(splitter).toBeVisible();
  const inspectorBeforeResize = await inspector.boundingBox();
  const splitterBox = await splitter.boundingBox();
  expect(inspectorBeforeResize).not.toBeNull();
  expect(splitterBox).not.toBeNull();
  await page.mouse.move(splitterBox!.x + splitterBox!.width / 2, splitterBox!.y + splitterBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitterBox!.x - 80, splitterBox!.y + splitterBox!.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await inspector.boundingBox())?.width ?? 0).toBeGreaterThan(inspectorBeforeResize!.width + 60);
  const persistedInspectorWidth = Number(await page.evaluate(() => window.localStorage.getItem("watchdog.inspector-width")));
  expect(persistedInspectorWidth).toBeGreaterThan(inspectorBeforeResize!.width + 60);
  const widthBeforeKeyboardResize = (await inspector.boundingBox())!.width;
  await splitter.press("ArrowRight");
  await expect.poll(async () => (await inspector.boundingBox())?.width ?? 0).toBeLessThan(widthBeforeKeyboardResize);
  await splitter.dblclick();
  await expect.poll(async () => (await inspector.boundingBox())?.width ?? 0).toBeCloseTo(340, 0);

  await page.setViewportSize({ width: 620, height: 900 });
  await expect(splitter).toBeHidden();
  const narrowBox = await canvas.boundingBox();
  expect(narrowBox).not.toBeNull();
  expect(narrowBox!.width / narrowBox!.height).toBeCloseTo(1100 / 680, 2);
  await page.mouse.move(narrowBox!.x + narrowBox!.width * .14, narrowBox!.y + narrowBox!.height * .25);
  await expect.poll(() => canvas.evaluate((node) => node.style.cursor)).toBe("pointer");
  await page.screenshot({ path: "test-results/yard-narrow.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "OPERATOR" }).click();
  await expect(page.getByRole("heading", { name: "Execution + subagents" })).toBeVisible();
  await expect(page.getByText("DEMO · NORMALIZED RUNTIME")).toBeVisible();
  await expect(page.getByText("SEMANTIC EXECUTIONS")).toBeVisible();
  await expect(page.getByText("SOAK TEST")).toBeVisible();
  await expect(page.getByText("Mirror").first()).toBeVisible();
  await expect(page.getByText("20 clean checkout runs and the regression suite passes")).toBeVisible();

  await page.getByText("Mirror").first().click();
  await expect(page.getByRole("button", { name: "■ STOP CAR" })).toBeEnabled();
  await page.getByRole("button", { name: "■ STOP CAR" }).click();
  await expect(page.getByText("Agent stopped · parent automatically notified")).toBeVisible();
  await expect(page.getByText("duplicate assignment across 2 subagents")).toHaveCount(0);

  await page.locator(".agent-card").first().click();
  await page.getByPlaceholder("What should the next turn do?").fill("Continue with one investigator and only verified evidence");
  await page.getByPlaceholder("Model override (optional)").fill("gpt-5.6-luna");
  await page.getByLabel("Reasoning effort override").selectOption("low");
  await page.getByRole("button", { name: "↻ RETRY TURN" }).click();
  await expect(page.getByText("Retry started · gpt-5.6-luna · low effort")).toBeVisible();
  await expect(page.getByText("Continue with one investigator and only verified evidence").first()).toBeVisible();
  await page.screenshot({ path: "test-results/operator.png", fullPage: true });

  await page.getByRole("button", { name: "YARD", exact: true }).click();
  await page.getByRole("button", { name: "Toggle day and night" }).click();
  await expect(canvas).toBeVisible();
  await page.screenshot({ path: "test-results/yard-night.png", fullPage: true });
});
