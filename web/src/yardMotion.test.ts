import { describe, expect, it } from "vitest";
import type { ExecutionGraphState } from "./types";
import { childTrackSlots, childTrainScale, childTrainTargetX, childTrainTargetY, executionStations, executionTrainTargetX, rootTrainTargetX } from "./yardMotion";

describe("rail-yard semantic motion", () => {
  it("moves a child only after its work completes", () => {
    expect(childTrainTargetX(700, true, "inProgress")).toBe(700);
    expect(childTrainTargetX(700, false, "completed")).toBe(712);
    expect(childTrainTargetY(272, true, "active", "inProgress")).toBe(272);
    expect(childTrainTargetY(205, false, "idle", "completed")).toBe(309);
    expect(childTrainTargetY(610, false, "idle", "completed")).toBe(497);
    expect(childTrainTargetY(205, false, "idle", "completed", 410, .7)).toBeCloseTo(327.9);
    expect(childTrainTargetY(610, false, "idle", "completed", 410, .7)).toBeCloseTo(482.3);
  });

  it("alternates stable perpendicular sidings above and below the main line", () => {
    expect(childTrackSlots(1).map(({ side, x }) => ({ side, x }))).toEqual([
      { side: "above", x: 690 },
    ]);
    expect(childTrackSlots(2).map(({ side, x }) => ({ side, x }))).toEqual([
      { side: "above", x: 690 },
      { side: "below", x: 690 },
    ]);
    expect(childTrackSlots(3).map(({ side, x }) => ({ side, x }))).toEqual([
      { side: "above", x: 520 },
      { side: "below", x: 690 },
      { side: "above", x: 860 },
    ]);
    expect(childTrackSlots(4).map(({ side, x }) => ({ side, x }))).toEqual([
      { side: "above", x: 520 },
      { side: "below", x: 520 },
      { side: "above", x: 860 },
      { side: "below", x: 860 },
    ]);
  });

  it("shrinks child cars only when a siding becomes crowded", () => {
    expect(childTrainScale(4)).toBe(1);
    expect(childTrainScale(5)).toBe(.9);
    expect(childTrainScale(9)).toBe(.7);
    expect(childTrainScale(20)).toBe(.62);
  });

  it("uses START and END for an ordinary task instead of inventing a loop", () => {
    expect(executionStations()).toEqual([
      { id: "ordinary-start", x: 365, label: "START", status: "pending" },
      { id: "ordinary-end", x: 900, label: "END", status: "pending" },
    ]);
    expect(rootTrainTargetX(true, "active")).toBe(600);
    expect(rootTrainTargetX(false, "idle")).toBe(900);
  });

  it("uses declared node names and places the locomotive at the active graph node", () => {
    const execution: ExecutionGraphState = {
      id: "release",
      ownerThreadId: "root",
      source: { kind: "watchdog" },
      authority: "declared",
      nodes: [
        { id: "audit", label: "AUDIT", kind: "stage" },
        { id: "repair", label: "REPAIR", kind: "subgraph", subgraphId: "repair-subgraph" },
        { id: "ship", label: "SHIP", kind: "terminal" },
      ],
      edges: [
        { id: "audit-repair", from: "audit", to: "repair", kind: "normal" },
        { id: "repair-ship", from: "repair", to: "ship", kind: "success" },
      ],
      entryNodeIds: ["audit"],
      terminalNodeIds: ["ship"],
      status: "running",
      iteration: 1,
      activations: [{ id: "repair-1", nodeId: "repair", iteration: 1, status: "running", threadIds: ["root"], startedAt: "2026-07-19T00:00:00.000Z" }],
      traversals: [],
      activeNodeIds: ["repair"],
      warnings: [],
    };
    const stations = executionStations(execution);
    expect(stations.map(({ id, label, subgraphId }) => ({ id, label, subgraphId }))).toEqual([
      { id: "audit", label: "AUDIT", subgraphId: undefined },
      { id: "repair", label: "REPAIR", subgraphId: "repair-subgraph" },
      { id: "ship", label: "SHIP", subgraphId: undefined },
    ]);
    expect(executionTrainTargetX(execution, true)).toBe(stations[1]?.x);
  });
});
