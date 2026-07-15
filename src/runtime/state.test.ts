import { describe, expect, it } from "vitest";
import { RuntimeState } from "./state.js";

describe("RuntimeState", () => {
  it("builds a loop summary and flags requested/effective mismatches", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root" });
    state.apply({ type: "turn.started", threadId: "root", turnId: "turn-1" });
    state.apply({ type: "loop.objective", threadId: "root", turnId: "turn-1", objective: "Find and verify the issue" });
    state.apply({ type: "agent.spawned", parentThreadId: "root", agentThreadId: "child", state: "started" });
    state.apply({ type: "agent.requestedConfig", parentThreadId: "root", agentThreadId: "child", model: "cheap", reasoningEffort: "low" });
    state.apply({ type: "agent.effectiveConfig", threadId: "child", model: "expensive", reasoningEffort: "high" });

    const snapshot = state.snapshot();
    expect(snapshot.loops).toEqual([expect.objectContaining({ threadId: "root", iteration: 1, objective: "Find and verify the issue", phase: "execute" })]);
    expect(snapshot.loops[0]?.warnings).toEqual(expect.arrayContaining(["child model differs from request", "child effort differs from request"]));
  });

  it("resolves unique nickname targets", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "child-id", nickname: "Ampere" });
    expect(state.resolve("ampere").threadId).toBe("child-id");
  });

  it("does not count a duplicated active-turn observation as another loop iteration", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root" });
    state.apply({ type: "turn.started", threadId: "root", turnId: "turn-1" });
    state.apply({ type: "turn.started", threadId: "root", turnId: "turn-1" });
    expect(state.snapshot().loops[0]?.iteration).toBe(1);
  });

  it("waits for a parent turn to become steerable", async () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root" });
    const waiting = state.waitForActiveTurn("root", 100);
    state.apply({ type: "turn.started", threadId: "root", turnId: "turn-1" });
    await expect(waiting).resolves.toMatchObject({ threadId: "root", activeTurnId: "turn-1" });
  });

  it("tracks verifier, evidence, budgets, and verification outcome", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root" });
    state.apply({ type: "turn.started", threadId: "root", turnId: "turn-1" });
    state.apply({ type: "loop.configured", threadId: "root", verifier: "all tests pass", maxTokens: 100, maxIterations: 2 });
    state.apply({ type: "tokens.updated", threadId: "root", totalTokens: 90 });
    state.apply({ type: "evidence.collected", threadId: "root", itemId: "proof-1", summary: "tests passed", source: "operator" });
    state.apply({ type: "loop.verified", threadId: "root", status: "passed", summary: "green suite" });

    const loop = state.snapshot().loops[0]!;
    expect(loop).toMatchObject({ phase: "done", verifier: "all tests pass", verification: { status: "passed" }, budget: { maxTokens: 100, maxIterations: 2, usedTokens: 90 } });
    expect(loop.evidence).toHaveLength(1);
    expect(loop.warnings).toContain("token budget at 90%");
  });

  it("supports nested loops and resolves their root ancestor", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root" });
    state.apply({ type: "agent.spawned", parentThreadId: "root", agentThreadId: "child", state: "started" });
    state.apply({ type: "agent.spawned", parentThreadId: "child", agentThreadId: "grandchild", state: "started" });
    state.apply({ type: "loop.configured", threadId: "child", verifier: "child proof" });
    state.apply({ type: "turn.started", threadId: "child", turnId: "child-turn" });
    state.apply({ type: "evidence.collected", threadId: "grandchild", summary: "nested evidence", source: "agent message" });

    expect(state.rootFor("grandchild").threadId).toBe("root");
    expect(state.snapshot().loops.find((loop) => loop.threadId === "child")).toMatchObject({ iteration: 1, evidence: [expect.objectContaining({ agentThreadId: "grandchild" })] });
  });
});
