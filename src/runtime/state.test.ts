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

  it("prefers the hydrated child task over opaque spawn metadata and retains command history", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "child", parentThreadId: "root" });
    state.apply({
      type: "agent.requestedConfig",
      parentThreadId: "root",
      agentThreadId: "child",
      prompt: `gAAAAA${"x".repeat(100)}`,
    });
    state.apply({ type: "turn.input", threadId: "child", turnId: "turn-1", input: "Inspect the control path" });
    state.apply({ type: "agent.activity", threadId: "child", itemId: "exec-1", tool: "command · rg control src", status: "inProgress", at: "2026-07-20T12:00:00.000Z" });
    state.apply({ type: "agent.activity", threadId: "child", itemId: "exec-1", tool: "command · rg control src", status: "completed", at: "2026-07-20T12:00:01.000Z" });
    state.apply({ type: "agent.activity", threadId: "child", itemId: "exec-2", tool: "command · sed -n 1,80p src/runtime/control.ts", status: "inProgress", at: "2026-07-20T12:00:02.000Z" });

    expect(state.resolve("child")).toMatchObject({
      task: "Inspect the control path",
      requested: { prompt: undefined },
      latestActivity: { tool: "command · sed -n 1,80p src/runtime/control.ts", status: "inProgress" },
      activityCount: 2,
      activities: [
        { id: "exec-1", tool: "command · rg control src", status: "completed", at: "2026-07-20T12:00:01.000Z" },
        { id: "exec-2", tool: "command · sed -n 1,80p src/runtime/control.ts", status: "inProgress", at: "2026-07-20T12:00:02.000Z" },
      ],
    });
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
    state.apply({ type: "tokens.updated", threadId: "root", totalTokens: 90, inputTokens: 80, outputTokens: 10 });
    state.apply({ type: "evidence.collected", threadId: "root", itemId: "proof-1", summary: "tests passed", source: "operator" });
    state.apply({ type: "loop.verified", threadId: "root", status: "passed", summary: "green suite" });

    const loop = state.snapshot().loops[0]!;
    expect(state.snapshot().agents[0]).toMatchObject({ totalTokens: 90, inputTokens: 80, outputTokens: 10 });
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

  it("tracks explicit graph activations, transitions, cycles, and child ownership without inventing phases", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root", kind: "root" });
    state.apply({
      type: "execution.declared",
      graph: {
        id: "repair-loop",
        ownerThreadId: "root",
        label: "Repair loop",
        objective: "Repair until regression passes",
        source: { kind: "watchdog", label: "test instrument" },
        authority: "declared",
        nodes: [
          { id: "reproduce", label: "REPRODUCE", kind: "stage" },
          { id: "patch", label: "PATCH", kind: "stage" },
          { id: "regression", label: "REGRESSION", kind: "verifier" },
          { id: "ready", label: "READY", kind: "terminal" },
        ],
        edges: [
          { id: "reproduce-patch", from: "reproduce", to: "patch", kind: "normal" },
          { id: "patch-regression", from: "patch", to: "regression", kind: "normal" },
          { id: "retry", from: "regression", to: "patch", kind: "loop-back" },
          { id: "pass", from: "regression", to: "ready", kind: "success" },
        ],
        entryNodeIds: ["reproduce"],
        terminalNodeIds: ["ready"],
      },
    });
    state.apply({ type: "execution.iteration.started", executionId: "repair-loop", iteration: 1 });
    state.apply({ type: "execution.node.started", executionId: "repair-loop", nodeId: "patch", activationId: "patch-1", threadId: "root", iteration: 1 });
    state.apply({ type: "agent.spawned", parentThreadId: "root", agentThreadId: "worker", state: "started" });
    state.apply({ type: "execution.node.completed", executionId: "repair-loop", nodeId: "patch", activationId: "patch-1", status: "passed" });
    state.apply({ type: "execution.edge.selected", executionId: "repair-loop", edgeId: "patch-regression", traversalId: "edge-1", iteration: 1 });
    state.apply({ type: "execution.node.started", executionId: "repair-loop", nodeId: "regression", activationId: "verify-1", threadId: "root", iteration: 1 });
    state.apply({ type: "execution.node.completed", executionId: "repair-loop", nodeId: "regression", activationId: "verify-1", status: "failed", summary: "one test failed" });
    state.apply({ type: "execution.edge.selected", executionId: "repair-loop", edgeId: "retry", traversalId: "retry-1", iteration: 1 });
    state.apply({ type: "execution.iteration.started", executionId: "repair-loop", iteration: 2 });
    state.apply({
      type: "execution.updated",
      executionId: "repair-loop",
      nodes: [{ id: "report", label: "REPORT", kind: "terminal" }],
      edges: [{ id: "ready-report", from: "ready", to: "report", kind: "normal" }],
      terminalNodeIds: ["report"],
    });

    const snapshot = state.snapshot();
    expect(snapshot.loops).toEqual([]);
    expect(snapshot.executions[0]).toMatchObject({
      id: "repair-loop",
      iteration: 2,
      status: "running",
      activeNodeIds: [],
      traversals: [
        expect.objectContaining({ edgeId: "patch-regression" }),
        expect.objectContaining({ edgeId: "retry" }),
      ],
      terminalNodeIds: ["report"],
    });
    expect(snapshot.executions[0]?.nodes.at(-1)?.label).toBe("REPORT");
    expect(snapshot.agents.find((agent) => agent.threadId === "worker")?.execution).toEqual({
      executionId: "repair-loop",
      nodeId: "patch",
      activationId: "patch-1",
    });
  });

  it("flags abandoned running instrumentation without fabricating completion", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root", kind: "root" });
    state.apply({
      type: "execution.declared",
      graph: {
        id: "bounded-loop",
        ownerThreadId: "root",
        source: { kind: "watchdog" },
        authority: "declared",
        nodes: [{ id: "done", label: "DONE", kind: "terminal" }],
        edges: [],
        entryNodeIds: ["done"],
        terminalNodeIds: ["done"],
      },
    });
    state.apply({ type: "turn.started", threadId: "root", turnId: "turn-1" });
    state.apply({ type: "execution.iteration.started", executionId: "bounded-loop", iteration: 1 });
    state.apply({ type: "execution.node.started", executionId: "bounded-loop", nodeId: "done", activationId: "done-1", threadId: "root" });
    state.apply({ type: "turn.completed", threadId: "root", turnId: "turn-1" });

    let execution = state.snapshot().executions[0]!;
    expect(execution).toMatchObject({
      status: "waiting",
      incompleteReason: "Instrumentation incomplete: DONE never reported completion after associated work ended",
      activeNodeIds: ["done"],
      activations: [expect.objectContaining({ id: "done-1", status: "running" })],
    });
    expect(execution.warnings).toContain(execution.incompleteReason);

    state.apply({ type: "execution.node.completed", executionId: "bounded-loop", nodeId: "done", activationId: "done-1", status: "passed" });
    execution = state.snapshot().executions[0]!;
    expect(execution.incompleteReason).toContain("terminal node passed");

    state.apply({ type: "execution.completed", executionId: "bounded-loop", status: "completed" });
    expect(state.snapshot().executions[0]).toMatchObject({
      status: "completed",
      incompleteReason: undefined,
      activeNodeIds: [],
    });
  });

  it("keeps verifier, evidence, budgets, and orchestration warnings inside the execution model", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root", kind: "root" });
    state.apply({
      type: "execution.declared",
      graph: {
        id: "bounded-repair",
        ownerThreadId: "root",
        objective: "Repair until verified",
        policy: { verifier: "the regression suite passes", maxTokens: 100, maxIterations: 3 },
        source: { kind: "watchdog" },
        authority: "declared",
        nodes: [
          { id: "patch", label: "PATCH", kind: "action" },
          { id: "verify", label: "VERIFY", kind: "verifier" },
        ],
        edges: [
          { id: "check", from: "patch", to: "verify", kind: "normal" },
          { id: "retry", from: "verify", to: "patch", kind: "loop-back" },
        ],
        entryNodeIds: ["patch"],
        terminalNodeIds: ["verify"],
      },
    });
    state.apply({ type: "tokens.updated", threadId: "root", totalTokens: 90 });
    state.apply({ type: "execution.iteration.started", executionId: "bounded-repair", iteration: 3 });
    state.apply({ type: "execution.node.started", executionId: "bounded-repair", nodeId: "verify", activationId: "verify-3", threadId: "root", iteration: 3 });
    state.apply({ type: "execution.node.completed", executionId: "bounded-repair", nodeId: "verify", activationId: "verify-3", status: "failed", summary: "one regression remains" });

    let execution = state.snapshot().executions[0]!;
    expect(execution).toMatchObject({
      policy: { verifier: "the regression suite passes", maxTokens: 100, maxIterations: 3 },
      verification: { status: "failed", summary: "one regression remains" },
      usedTokens: 90,
    });
    expect(execution.warnings).toEqual(expect.arrayContaining([
      "no evidence collected across iterations",
      "possible runaway loop: 3 iterations without passing verification",
      "iteration budget reached: 3/3",
      "token budget at 90%",
      "VERIFY failed without a selected recovery path",
    ]));

    state.apply({ type: "execution.evidence.collected", executionId: "bounded-repair", threadId: "root", summary: "failure reproduced", source: "tests" });
    state.apply({ type: "execution.edge.selected", executionId: "bounded-repair", edgeId: "retry", traversalId: "retry-3", iteration: 3 });
    execution = state.snapshot().executions[0]!;
    expect(execution.evidence).toEqual([expect.objectContaining({ summary: "failure reproduced", iteration: 3 })]);
    expect(execution.warnings).not.toContain("no evidence collected across iterations");
    expect(execution.warnings).not.toContain("VERIFY failed without a selected recovery path");
  });

  it("keeps a higher-authority graph and translates legacy loop metadata into honest generic stations", () => {
    const state = new RuntimeState();
    state.apply({ type: "thread.started", threadId: "root", kind: "root" });
    state.apply({
      type: "execution.declared",
      graph: {
        id: "workflow",
        ownerThreadId: "root",
        source: { kind: "harness" },
        authority: "authoritative",
        nodes: [{ id: "ship", label: "SHIP", kind: "terminal" }],
        edges: [],
        entryNodeIds: ["ship"],
        terminalNodeIds: ["ship"],
      },
    });
    state.apply({
      type: "execution.declared",
      graph: {
        id: "workflow",
        ownerThreadId: "root",
        source: { kind: "inferred" },
        authority: "suspected",
        nodes: [{ id: "guess", label: "GUESSED", kind: "stage" }],
        edges: [],
        entryNodeIds: ["guess"],
        terminalNodeIds: ["guess"],
      },
    });
    state.apply({ type: "loop.configured", threadId: "root", objective: "Keep trying", verifier: "proof exists" });

    const snapshot = state.snapshot();
    expect(snapshot.executions.find((execution) => execution.id === "workflow")?.nodes.map((node) => node.label)).toEqual(["SHIP"]);
    expect(snapshot.executions.find((execution) => execution.id.startsWith("legacy-loop:"))?.nodes.map((node) => node.label))
      .toEqual(["ATTEMPT", "VERIFY", "DONE"]);
  });
});
