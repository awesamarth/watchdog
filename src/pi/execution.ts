import type { WatchdogEvent } from "../adapters/events.js";
import type {
  ExecutionEdgeDefinition,
  ExecutionNodeDefinition,
  ExecutionStatus,
  NodeActivationStatus,
} from "../execution/types.js";
import type { RunSnapshot } from "../runtime/state.js";

export type PiExecutionOperation =
  | {
    action: "declare";
    executionId: string;
    label?: string;
    objective?: string;
    parentExecutionId?: string;
    parentNodeId?: string;
    nodes: ExecutionNodeDefinition[];
    edges: ExecutionEdgeDefinition[];
    entryNodeIds?: string[];
    terminalNodeIds?: string[];
  }
  | {
    action: "update";
    executionId: string;
    label?: string;
    objective?: string;
    nodes?: ExecutionNodeDefinition[];
    edges?: ExecutionEdgeDefinition[];
    entryNodeIds?: string[];
    terminalNodeIds?: string[];
  }
  | { action: "list" }
  | { action: "start_iteration"; executionId: string; iteration: number; reason?: string }
  | { action: "start_node"; executionId: string; nodeId: string; activationId: string; iteration?: number; status?: "running" | "waiting" }
  | { action: "complete_node"; executionId: string; nodeId: string; activationId: string; status: Exclude<NodeActivationStatus, "queued" | "running" | "waiting">; summary?: string }
  | { action: "select_edge"; executionId: string; edgeId: string; traversalId: string; iteration?: number }
  | { action: "complete"; executionId: string; status: Extract<ExecutionStatus, "completed" | "failed" | "stopped" | "blocked">; reason?: string };

export function executePiExecutionOperation(
  ownerThreadId: string,
  operation: PiExecutionOperation,
  emit: (event: WatchdogEvent) => void,
  snapshot: () => RunSnapshot,
): unknown {
  if (operation.action === "list") {
    return {
      executions: snapshot().executions.filter((execution) =>
        execution.ownerThreadId === ownerThreadId
        || execution.activations.some((activation) => activation.threadIds.includes(ownerThreadId)),
      ),
    };
  }
  if (operation.action === "declare") {
    emit({
      type: "execution.declared",
      graph: {
        id: operation.executionId,
        ownerThreadId,
        label: operation.label,
        objective: operation.objective,
        source: { kind: "watchdog", label: "Pi execution instrumentation" },
        authority: "declared",
        parentExecutionId: operation.parentExecutionId,
        parentNodeId: operation.parentNodeId,
        nodes: operation.nodes,
        edges: operation.edges,
        entryNodeIds: operation.entryNodeIds ?? [],
        terminalNodeIds: operation.terminalNodeIds ?? [],
      },
    });
  } else if (operation.action === "update") {
    emit({
      type: "execution.updated",
      executionId: operation.executionId,
      label: operation.label,
      objective: operation.objective,
      nodes: operation.nodes,
      edges: operation.edges,
      entryNodeIds: operation.entryNodeIds,
      terminalNodeIds: operation.terminalNodeIds,
    });
  } else if (operation.action === "start_iteration") {
    emit({ type: "execution.iteration.started", executionId: operation.executionId, iteration: operation.iteration, reason: operation.reason });
  } else if (operation.action === "start_node") {
    emit({
      type: "execution.node.started",
      executionId: operation.executionId,
      nodeId: operation.nodeId,
      activationId: operation.activationId,
      threadId: ownerThreadId,
      iteration: operation.iteration,
      status: operation.status,
    });
  } else if (operation.action === "complete_node") {
    emit({
      type: "execution.node.completed",
      executionId: operation.executionId,
      nodeId: operation.nodeId,
      activationId: operation.activationId,
      status: operation.status,
      summary: operation.summary,
    });
  } else if (operation.action === "select_edge") {
    emit({
      type: "execution.edge.selected",
      executionId: operation.executionId,
      edgeId: operation.edgeId,
      traversalId: operation.traversalId,
      iteration: operation.iteration,
    });
  } else {
    emit({ type: "execution.completed", executionId: operation.executionId, status: operation.status, reason: operation.reason });
  }
  return snapshot().executions.find((execution) => execution.id === operation.executionId);
}
