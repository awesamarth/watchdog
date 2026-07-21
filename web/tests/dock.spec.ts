import { expect, test } from "@playwright/test";
import type { AgentState, DashboardState, RunSnapshot } from "../src/types.js";

test("the Yard docks completed overflow without losing its inspector history", async ({ page }) => {
  const root: AgentState = {
    threadId: "dock-root",
    nickname: "Root",
    kind: "root",
    role: "orchestrator",
    status: "idle",
    startedAt: new Date(2026, 6, 20, 9).toISOString(),
  };
  const archived: AgentState[] = Array.from({ length: 10 }, (_, index) => ({
    threadId: `dock-complete-${index}`,
    parentThreadId: root.threadId,
    nickname: `Archive ${index}`,
    role: "reviewer",
    kind: "native-child",
    status: "idle",
    totalTokens: 1_200 + index,
    inputTokens: 1_000 + index,
    outputTokens: 200,
    task: `Completed overflow assignment ${index}`,
    latestMessage: `Archived result ${index}`,
    startedAt: new Date(2026, 6, 20, 10, index).toISOString(),
  }));
  const snapshot: RunSnapshot = {
    startedAt: root.startedAt!,
    mode: "live",
    adapter: { harness: "codex", transport: "app-server", mode: "live", label: "Codex App Server" },
    agents: [root, ...archived],
    loops: [],
    executions: [],
  };
  const state: DashboardState = {
    connected: true,
    snapshot,
    runs: [],
    message: "Dock overflow rehearsal",
  };

  await page.routeWebSocket(/\/ws\?/, (socket) => {
    socket.send(JSON.stringify(state));
  });
  await page.goto("/");

  const canvas = page.getByLabel("Interactive pixel-art rail yard");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const dock = {
    x: box!.x + box!.width * (130 / 1100),
    y: box!.y + box!.height * (550 / 680),
  };
  await page.waitForTimeout(150);
  await page.mouse.move(dock.x, dock.y);
  await expect.poll(() => canvas.evaluate((node) => node.style.cursor)).toBe("pointer");
  await page.mouse.click(dock.x, dock.y);

  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("heading", { name: "Dock" })).toBeVisible();
  await expect(inspector.getByText("1 STORED")).toBeVisible();
  await expect(inspector.getByRole("button", { name: /Archive 0/ })).toBeVisible();
  await page.screenshot({ path: "test-results/yard-dock.png", fullPage: true });

  await inspector.getByRole("button", { name: /Archive 0/ }).click();
  await expect(inspector.getByRole("heading", { name: "Archive 0" })).toBeVisible();
  await expect(inspector.getByText("Completed overflow assignment 0")).toBeVisible();
});
