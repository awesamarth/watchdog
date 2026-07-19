import type { ExecutionGraphState } from "./types";

export type ChildTrackSlot = { side: "above" | "below"; x: number; y: number };
export type WorkflowStation = {
  id: string;
  x: number;
  label: string;
  status: "pending" | "running" | "waiting" | "passed" | "failed" | "stopped";
  subgraphId?: string;
  collapsedCount?: number;
};

/** Semantic targets only: elapsed animation time never changes these values. */
export function rootTrainTargetX(active: boolean, status = "unknown"): number {
  if (active) return 600;
  return status === "unknown" ? 365 : 900;
}

export function executionTrainTargetX(
  execution: ExecutionGraphState | undefined,
  active: boolean,
  status = "unknown",
): number {
  if (!execution) return rootTrainTargetX(active, status);
  const stations = executionStations(execution);
  if (!stations.length) return rootTrainTargetX(active, status);
  const activeId = execution.activeNodeIds[0];
  const activeStation = activeId && stations.find((station) => station.id === activeId);
  if (activeStation) return activeStation.x;
  if (execution.status === "completed") {
    const terminal = [...stations].reverse().find((station) => execution.terminalNodeIds.includes(station.id));
    return terminal?.x ?? stations.at(-1)!.x;
  }
  const latest = [...execution.activations].reverse().find((activation) => activation.status !== "queued");
  return stations.find((station) => station.id === latest?.nodeId)?.x
    ?? stations.find((station) => execution.entryNodeIds.includes(station.id))?.x
    ?? stations[0]!.x;
}

export function childTrainTargetX(baseX: number, active: boolean, activityStatus?: string): number {
  return baseX + (!active && activityStatus === "completed" ? 12 : 0);
}

export function childTrainTargetY(
  baseY: number,
  active: boolean,
  status: string,
  activityStatus?: string,
  mainLineY = 410,
  scale = 1,
): number {
  const completed = !active && (activityStatus === "completed" || status === "idle" || status === "done" || status === "completed");
  if (!completed) return baseY;
  const railHalfHeight = 28;
  const clearance = 10;
  const nameplateBottom = 63 * scale;
  const selectedTop = 49 * scale;
  return baseY < mainLineY
    ? mainLineY - railHalfHeight - clearance - nameplateBottom
    : mainLineY + railHalfHeight + clearance + selectedTop;
}

/**
 * Keep spawn order stable while distributing work across perpendicular
 * sidings: first child above, second below, then alternate.
 */
export function childTrackSlots(count: number): ChildTrackSlot[] {
  if (count <= 0) return [];
  const aboveCount = Math.ceil(count / 2);
  const belowCount = Math.floor(count / 2);
  const aboveX = spreadTrackXs(aboveCount);
  const belowX = spreadTrackXs(belowCount);
  let aboveIndex = 0;
  let belowIndex = 0;
  return Array.from({ length: count }, (_, index) => {
    const side = index % 2 === 0 ? "above" : "below";
    return side === "above"
      ? { side, x: aboveX[aboveIndex++]!, y: 205 }
      : { side, x: belowX[belowIndex++]!, y: 610 };
  });
}

/** Reduce only child cars once either side of the yard gets crowded. */
export function childTrainScale(count: number): number {
  const busiestSide = Math.ceil(Math.max(0, count) / 2);
  return Math.max(.62, 1 - Math.max(0, busiestSide - 2) * .1);
}

/**
 * Build a stable, honest Yard projection from semantic graph nodes. Large
 * graphs retain their entry, active neighborhood, and terminal nodes; omitted
 * nodes are represented by one explicit collapsed station rather than silently
 * disappearing or inventing phases.
 */
export function executionStations(execution?: ExecutionGraphState): WorkflowStation[] {
  if (!execution) {
    return [
      { id: "ordinary-start", x: 365, label: "START", status: "pending" },
      { id: "ordinary-end", x: 900, label: "END", status: "pending" },
    ];
  }
  const ordered = orderedExecutionNodes(execution);
  const projected = projectNodes(ordered, execution.activeNodeIds[0]);
  const minX = 315;
  const maxX = 950;
  const gap = projected.length <= 1 ? 0 : (maxX - minX) / (projected.length - 1);
  return projected.map((node, index) => {
    if ("collapsedCount" in node) {
      return {
        id: node.id,
        x: minX + gap * index,
        label: `+${node.collapsedCount}`,
        status: "pending",
        collapsedCount: node.collapsedCount,
      };
    }
    return {
      id: node.id,
      x: minX + gap * index,
      label: node.label,
      status: nodeStatus(execution, node.id),
      subgraphId: node.subgraphId,
    };
  });
}

function orderedExecutionNodes(execution: ExecutionGraphState): ExecutionGraphState["nodes"] {
  const byId = new Map(execution.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of execution.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const ordered: ExecutionGraphState["nodes"] = [];
  const seen = new Set<string>();
  const queue = [...execution.entryNodeIds];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) ordered.push(node);
    for (const next of outgoing.get(id) ?? []) if (!seen.has(next)) queue.push(next);
  }
  for (const node of execution.nodes) if (!seen.has(node.id)) ordered.push(node);
  return ordered;
}

function projectNodes(
  nodes: ExecutionGraphState["nodes"],
  activeId?: string,
): Array<ExecutionGraphState["nodes"][number] | { id: string; collapsedCount: number }> {
  const maxVisible = 9;
  if (nodes.length <= maxVisible) return nodes;
  const activeIndex = Math.max(0, nodes.findIndex((node) => node.id === activeId));
  const keep = new Set([
    0,
    1,
    nodes.length - 2,
    nodes.length - 1,
    activeIndex - 1,
    activeIndex,
    activeIndex + 1,
  ].filter((index) => index >= 0 && index < nodes.length));
  const result: Array<ExecutionGraphState["nodes"][number] | { id: string; collapsedCount: number }> = [];
  let omitted = 0;
  nodes.forEach((node, index) => {
    if (!keep.has(index)) {
      omitted += 1;
      return;
    }
    if (omitted) {
      result.push({ id: `collapsed-before:${node.id}`, collapsedCount: omitted });
      omitted = 0;
    }
    result.push(node);
  });
  if (omitted) result.push({ id: "collapsed-tail", collapsedCount: omitted });
  return result;
}

function nodeStatus(execution: ExecutionGraphState, nodeId: string): WorkflowStation["status"] {
  const activation = [...execution.activations].reverse().find((candidate) => candidate.nodeId === nodeId);
  if (execution.activeNodeIds.includes(nodeId)) return activation?.status === "waiting" ? "waiting" : "running";
  return activation?.status === "queued" ? "pending" : activation?.status ?? "pending";
}

function spreadTrackXs(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [690];
  const start = count <= 2 ? 520 : 390;
  const end = count <= 2 ? 860 : 990;
  return Array.from({ length: count }, (_, index) => start + index * ((end - start) / (count - 1)));
}
