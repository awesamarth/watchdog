import { describe, expect, it } from "vitest";
import { executionHasCycle, normalizeExecutionGraph } from "./types.js";

describe("execution graph definitions", () => {
  it("preserves real node names and recognizes a directed cycle", () => {
    const graph = normalizeExecutionGraph({
      id: "repair-loop",
      ownerThreadId: "root",
      source: { kind: "watchdog" },
      authority: "declared",
      nodes: [
        { id: "reproduce", label: "REPRODUCE", kind: "stage" },
        { id: "patch", label: "PATCH", kind: "stage" },
        { id: "regression", label: "REGRESSION", kind: "verifier" },
      ],
      edges: [
        { id: "reproduce-patch", from: "reproduce", to: "patch", kind: "normal" },
        { id: "patch-regression", from: "patch", to: "regression", kind: "normal" },
        { id: "retry", from: "regression", to: "patch", kind: "loop-back" },
      ],
      entryNodeIds: [],
      terminalNodeIds: [],
    });

    expect(graph.entryNodeIds).toEqual(["reproduce"]);
    expect(executionHasCycle(graph)).toBe(true);
    expect(graph.nodes.map((node) => node.label)).toEqual(["REPRODUCE", "PATCH", "REGRESSION"]);
  });

  it("rejects duplicate nodes and edges that point at invented stages", () => {
    const base = {
      id: "bad",
      ownerThreadId: "root",
      source: { kind: "operator" as const },
      authority: "declared" as const,
      entryNodeIds: [],
      terminalNodeIds: [],
    };
    expect(() => normalizeExecutionGraph({
      ...base,
      nodes: [
        { id: "same", label: "ONE", kind: "stage" },
        { id: "same", label: "TWO", kind: "stage" },
      ],
      edges: [],
    })).toThrow("Duplicate execution id 'same'");
    expect(() => normalizeExecutionGraph({
      ...base,
      nodes: [{ id: "known", label: "KNOWN", kind: "stage" }],
      edges: [{ id: "fabricated", from: "known", to: "unknown", kind: "normal" }],
    })).toThrow("references an unknown node");
    expect(() => normalizeExecutionGraph({
      ...base,
      nodes: [{ id: "nested", label: "NESTED", kind: "subgraph" }],
      edges: [],
    })).toThrow("must declare subgraphId");
  });
});
