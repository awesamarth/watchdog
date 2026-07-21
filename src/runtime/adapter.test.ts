import { describe, expect, it, vi } from "vitest";
import type { AdapterEventListener, AgentCapabilities, AdapterTarget, HarnessAdapter } from "../adapters/types.js";
import { available, unavailable } from "../adapters/types.js";
import { adapterSnapshot, createRuntimeControlHandlers } from "./adapter.js";
import { RuntimeState } from "./state.js";

class FakeAdapter implements HarnessAdapter {
  readonly descriptor = { harness: "test", transport: "fixture", mode: "live", label: "Test adapter" } as const;
  steer = vi.fn(async () => ({ steered: true }));
  followUp = vi.fn(async () => ({ queued: true }));
  interrupt = vi.fn(async () => ({ stopped: true }));
  retry = vi.fn(async () => ({ retried: true }));
  onEvent(_listener: AdapterEventListener): () => void { return () => undefined; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  capabilities(target: AdapterTarget): AgentCapabilities {
    return {
      observe: available(),
      steer: target.parentThreadId ? unavailable("child steering is unavailable") : available(),
      followUp: available(),
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
    await expect(handlers.followUp("child", "send this next")).resolves.toEqual({ queued: true });
    expect(adapter.followUp).toHaveBeenCalledWith(expect.objectContaining({ threadId: "child" }), "send this next");
    await handlers.configureLoop("root", { verifier: "all tests pass", maxIterations: 4 });
    expect(handlers.snapshot().loops[0]).toMatchObject({ verifier: "all tests pass", budget: { maxIterations: 4 } });

    await handlers.declareExecution?.({
      id: "release",
      ownerThreadId: "root",
      source: { kind: "operator" },
      authority: "declared",
      nodes: [{ id: "audit", label: "AUDIT", kind: "stage" }],
      edges: [],
      entryNodeIds: ["audit"],
      terminalNodeIds: ["audit"],
    });
    await handlers.updateExecution?.({
      executionId: "release",
      nodes: [{ id: "ship", label: "SHIP", kind: "terminal" }],
      edges: [{ id: "audit-ship", from: "audit", to: "ship", kind: "success" }],
      terminalNodeIds: ["ship"],
    });
    expect(handlers.snapshot().executions.find((execution) => execution.id === "release")).toMatchObject({
      id: "release",
      ownerThreadId: "root",
      terminalNodeIds: ["ship"],
      nodes: [expect.objectContaining({ label: "AUDIT" }), expect.objectContaining({ label: "SHIP" })],
    });
  });

  it("derives graph controls from live adapter capabilities and stops or retries concrete nodes", async () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root", kind: "root" });
    state.apply({ type: "turn.started", threadId: "root", turnId: "root-turn" });
    const adapter = new FakeAdapter();
    const record = vi.fn((event) => state.apply(event));
    const handlers = createRuntimeControlHandlers(adapter, state, record);
    await handlers.declareExecution?.({
      id: "repair",
      ownerThreadId: "root",
      source: { kind: "operator" },
      authority: "declared",
      nodes: [{ id: "patch", label: "PATCH", kind: "action" }],
      edges: [],
      entryNodeIds: ["patch"],
      terminalNodeIds: ["patch"],
    });
    await handlers.startExecutionNode?.({
      executionId: "repair",
      nodeId: "patch",
      activationId: "patch-1",
      agent: "root",
    });

    expect(handlers.snapshot().executionCapabilities?.repair?.stop.available).toBe(true);
    await handlers.stopExecution?.("repair", undefined, "operator stop");
    expect(adapter.interrupt).toHaveBeenCalledWith(expect.objectContaining({ threadId: "root" }));
    expect(handlers.snapshot().executions[0]).toMatchObject({
      status: "stopped",
      activations: [expect.objectContaining({ id: "patch-1", status: "stopped" })],
    });

    expect(handlers.snapshot().executionCapabilities?.repair?.nodes.patch?.retry.available).toBe(true);
    await handlers.retryExecutionNode?.({
      executionId: "repair",
      nodeId: "patch",
      message: "Try the patch again with the retained findings",
    });
    expect(adapter.retry).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "root" }),
      expect.objectContaining({ message: "Try the patch again with the retained findings" }),
    );
    expect(handlers.snapshot().executions[0]).toMatchObject({
      status: "running",
      activations: [
        expect.objectContaining({ id: "patch-1", status: "stopped" }),
        expect.objectContaining({ status: "running", threadIds: ["root"] }),
      ],
    });
  });
});
