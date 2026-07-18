import { describe, expect, it } from "vitest";
import type { AgentCapabilities } from "../adapters/types.js";
import type { AgentState } from "../runtime/state.js";
import { availableControlHints, buildInspectorLines, inspectorPageStep, wrapInspectorText } from "./app.js";

describe("TUI inspector viewport content", () => {
  it("wraps long responses into independently scrollable terminal rows", () => {
    const agent: AgentState = {
      threadId: "child-thread",
      nickname: "Lovelace",
      status: "active",
      activeTurnId: "turn-1",
      messages: [{
        id: "message-1",
        at: "2026-07-19T00:00:00.000Z",
        text: "A deliberately long response that must occupy several terminal rows instead of expanding the Ink screen past the terminal height.",
      }],
      messageCount: 1,
    };

    const lines = buildInspectorLines(agent, 24);

    expect(lines.length).toBeGreaterThan(10);
    expect(lines.every((line) => line.text.length <= 24)).toBe(true);
    expect(lines.some((line) => line.text.includes("deliberately long"))).toBe(true);
  });

  it("shows every retained message newest-first instead of truncating to three", () => {
    const agent: AgentState = {
      threadId: "child-thread",
      status: "idle",
      messages: Array.from({ length: 5 }, (_, index) => ({
        id: `message-${index + 1}`,
        at: `2026-07-19T00:00:0${index}.000Z`,
        text: `Report ${index + 1}`,
      })),
      messageCount: 8,
    };

    const lines = buildInspectorLines(agent, 80);
    const rendered = lines.map((line) => line.text);

    expect(rendered).toContain("Messages (8 total · 5 retained · newest first)");
    expect(rendered.indexOf("• Report 5")).toBeLessThan(rendered.indexOf("• Report 1"));
    expect(rendered).toContain("• Report 1");
  });

  it("hard-wraps long unbroken paths and preserves explicit newlines", () => {
    const lines = wrapInspectorText("/a/very/long/unbroken/path/to/a/watchdog/session.jsonl\nnext line", 12);

    expect(lines.every((line) => line.length <= 12)).toBe(true);
    expect(lines.at(-1)).toBe("next line");
    expect(lines.join("")).toContain("session.jsonl");
  });

  it("moves Page Up and Page Down by half the visible inspector", () => {
    expect(inspectorPageStep(6)).toBe(3);
    expect(inspectorPageStep(9)).toBe(4);
    expect(inspectorPageStep(1)).toBe(1);
  });

  it("shows only controls supported by the selected agent", () => {
    const capability = (available: boolean) => ({ available });
    const child: AgentCapabilities = {
      observe: capability(true),
      steer: capability(false),
      interrupt: capability(true),
      retry: capability(false),
      modelOverride: capability(false),
    };
    const root: AgentCapabilities = {
      observe: capability(true),
      steer: capability(true),
      interrupt: capability(true),
      retry: capability(true),
      modelOverride: capability(true),
    };

    expect(availableControlHints(child)).toEqual(["x stop"]);
    expect(availableControlHints(root)).toEqual(["s steer", "x stop", "r retry"]);
    expect(availableControlHints()).toEqual([]);
  });
});
