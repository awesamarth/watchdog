import { describe, expect, it, vi } from "vitest";
import type { AdapterEventListener, AgentCapabilities, AdapterTarget, HarnessAdapter, RetryOptions } from "../adapters/types.js";
import { available, unavailable } from "../adapters/types.js";
import { adapterSnapshot, createRuntimeControlHandlers } from "./adapter.js";
import { RuntimeState } from "./state.js";

class FakeAdapter implements HarnessAdapter {
  readonly descriptor = { harness: "test", transport: "fixture", mode: "live", label: "Test adapter" } as const;
  steer = vi.fn(async () => ({ steered: true }));
  interrupt = vi.fn(async () => ({ stopped: true }));
  retry = vi.fn(async () => ({ retried: true }));
  onEvent(_listener: AdapterEventListener): () => void { return () => undefined; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  capabilities(target: AdapterTarget): AgentCapabilities {
    return {
      observe: available(),
      steer: target.parentThreadId ? unavailable("child steering is unavailable") : available(),
      interrupt: target.activeTurnId ? available() : unavailable("no active turn"),
      retry: target.parentThreadId ? unavailable("child retry is unavailable") : available(),
      modelOverride: available(),
    };
  }
}

describe("normalized harness adapter boundary", () => {
  it("publishes adapter metadata and per-agent capabilities", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root" });
    state.apply({ type: "turn.started", threadId: "root", turnId: "turn-1" });
    state.apply({ type: "thread.started", threadId: "child", parentThreadId: "root" });
    const snapshot = adapterSnapshot(new FakeAdapter(), state);

    expect(snapshot.adapter?.harness).toBe("test");
    expect(snapshot.capabilities?.root?.steer.available).toBe(true);
    expect(snapshot.capabilities?.child?.steer).toEqual({ available: false, reason: "child steering is unavailable" });
  });

  it("rejects unsupported controls before calling the harness and keeps loop metadata generic", async () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root" });
    state.apply({ type: "thread.started", threadId: "child", parentThreadId: "root" });
    const adapter = new FakeAdapter();
    const record = vi.fn((event) => state.apply(event));
    const handlers = createRuntimeControlHandlers(adapter, state, record);

    await expect(handlers.steer("child", "change course")).rejects.toThrow("child steering is unavailable");
    expect(adapter.steer).not.toHaveBeenCalled();
    await handlers.configureLoop("root", { verifier: "all tests pass", maxIterations: 4 });
    expect(handlers.snapshot().loops[0]).toMatchObject({ verifier: "all tests pass", budget: { maxIterations: 4 } });
  });
});
