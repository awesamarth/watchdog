import { describe, expect, it } from "vitest";
import { WatchdogDemoAdapter } from "./adapter.js";
import { adapterSnapshot } from "../runtime/adapter.js";
import { RuntimeState } from "../runtime/state.js";

describe("Watchdog deterministic demo adapter", () => {
  it("starts with an explainable bad loop and resolves duplicate work through intervention", async () => {
    const state = new RuntimeState();
    const adapter = new WatchdogDemoAdapter(state);
    adapter.onEvent((event) => state.apply(event));
    await adapter.start();

    const initial = adapterSnapshot(adapter, state);
    expect(initial.adapter).toMatchObject({ harness: "watchdog-demo", transport: "simulation" });
    expect(initial.loops[0]?.warnings).toEqual(expect.arrayContaining([
      "token budget at 90%",
      "fan-out: 4 subagents",
      "3 subagents active concurrently",
      "Kepler model differs from request",
      "Kepler effort differs from request",
      "duplicate assignment across 2 subagents",
    ]));

    const mirror = state.resolve("Mirror");
    await expect(adapter.interrupt(mirror)).resolves.toMatchObject({ stopped: "Mirror", parentNotified: true });
    const intervened = adapterSnapshot(adapter, state);
    expect(state.resolve("Mirror")).toMatchObject({ status: "interrupted", activeTurnId: undefined });
    expect(intervened.loops[0]?.warnings).not.toContain("duplicate assignment across 2 subagents");
    expect(state.resolve("root").latestActivity?.tool).toBe("re-plan after Watchdog stop");
  });

  it("retries the root with explicit model and effort overrides", async () => {
    const state = new RuntimeState();
    const adapter = new WatchdogDemoAdapter(state);
    adapter.onEvent((event) => state.apply(event));
    await adapter.start();

    await expect(adapter.retry(state.resolve("root"), { message: "Continue with only verified evidence", model: "gpt-5.6-luna", effort: "low" })).resolves.toMatchObject({ model: "gpt-5.6-luna", effort: "low" });
    expect(state.resolve("root")).toMatchObject({ activeTurnId: "demo-root-turn-4", effective: { model: "gpt-5.6-luna", effort: "low" } });
    expect(state.snapshot().loops[0]).toMatchObject({ iteration: 4, objective: "Continue with only verified evidence" });
  });
});
