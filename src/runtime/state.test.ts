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
    state.apply({ type: "loop.configured", threadId: "root", verifier: "done" });
    state.apply({ type: "turn.started", threadId: "root", turnId: "turn-1" });
    state.apply({ type: "turn.started", threadId: "root", turnId: "turn-1" });
    expect(state.snapshot().loops[0]?.iteration).toBe(1);
  });

  it("keeps an ordinary task out of the loop model and captures child message history", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root" });
    state.apply({ type: "turn.started", threadId: "root", turnId: "turn-1" });
    state.apply({ type: "turn.input", threadId: "root", turnId: "turn-1", input: "Inspect one file with two subagents" });
    state.apply({ type: "thread.started", threadId: "child", parentThreadId: "root", nickname: "Curie" });
    state.apply({ type: "agent.message.delta", threadId: "child", itemId: "report-1", delta: "Inspection complete; " });
    state.apply({ type: "agent.message.delta", threadId: "child", itemId: "report-1", delta: "sleeping before final report." });
    expect(state.resolve("child").streamingMessage?.text).toBe("Inspection complete; sleeping before final report.");
    state.apply({ type: "agent.message", threadId: "child", itemId: "report-1", message: "Inspection complete; sleeping before final report.", at: "2026-07-17T12:00:00.000Z" });
    state.apply({ type: "agent.message", threadId: "child", itemId: "report-2", message: "Final finding: one stale registry path.", at: "2026-07-17T12:01:00.000Z" });
    state.apply({ type: "agent.message", threadId: "child", itemId: "report-2", message: "Duplicate delivery must be ignored." });

    const snapshot = state.snapshot();
    const child = snapshot.agents.find((agent) => agent.threadId === "child");
    expect(snapshot.loops).toEqual([]);
    expect(snapshot.agents.find((agent) => agent.threadId === "root")?.task).toBe("Inspect one file with two subagents");
    expect(child?.streamingMessage).toBeUndefined();
    expect(child?.messages).toEqual([
      { id: "report-1", text: "Inspection complete; sleeping before final report.", at: "2026-07-17T12:00:00.000Z" },
      { id: "report-2", text: "Final finding: one stale registry path.", at: "2026-07-17T12:01:00.000Z" },
    ]);
    expect(child?.messageCount).toBe(2);
    expect(child?.latestMessage).toBe("Final finding: one stale registry path.");
  });

  it("bounds in-memory message history while retaining the total count", () => {
    const state = new RuntimeState();
    for (let index = 1; index <= 105; index += 1) {
      state.apply({ type: "agent.message", threadId: "child", itemId: `message-${index}`, message: `Report ${index}` });
    }
    const child = state.resolve("child");
    expect(child.messageCount).toBe(105);
    expect(child.messages).toHaveLength(100);
    expect(child.messages?.[0]?.text).toBe("Report 6");
    expect(child.messages?.at(-1)?.text).toBe("Report 105");
  });

  it("does not leave an abandoned streaming response marked live after a turn ends", () => {
    const state = new RuntimeState();
    state.apply({ type: "turn.started", threadId: "child", turnId: "turn-1" });
    state.apply({ type: "agent.message.delta", threadId: "child", itemId: "draft", delta: "Partial draft" });
    state.apply({ type: "turn.completed", threadId: "child", turnId: "turn-1" });
    expect(state.resolve("child").streamingMessage).toBeUndefined();
  });

  it("does not treat ordinary agent commentary as verified loop evidence", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root" });
    state.apply({ type: "loop.configured", threadId: "root", verifier: "tests pass" });
    state.apply({ type: "thread.started", threadId: "child", parentThreadId: "root" });
    state.apply({ type: "agent.message", threadId: "child", itemId: "commentary", message: "I am starting the audit." });
    expect(state.snapshot().loops[0]?.evidence).toEqual([]);
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
