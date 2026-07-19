import type {
  ExecutionEdgeDefinition,
  ExecutionGraphDefinition,
  ExecutionNodeDefinition,
  ExecutionStatus,
  NodeActivationStatus,
} from "../execution/types.js";

export type WatchdogEvent =
  | { type: "thread.started"; threadId: string; parentThreadId?: string; nickname?: string; role?: string; kind?: "root" | "native-child" | "subprocess-worker" | "independent-session" }
  | { type: "thread.status"; threadId: string; status: string }
  | { type: "turn.started" | "turn.completed"; threadId: string; turnId: string }
  | { type: "turn.input"; threadId: string; turnId: string; input: string }
  | { type: "agent.message.delta"; threadId: string; itemId: string; delta: string; at?: string }
  | { type: "agent.message"; threadId: string; itemId?: string; message: string; at?: string }
  | { type: "loop.objective"; threadId: string; turnId: string; objective: string }
  | { type: "agent.spawned"; parentThreadId: string; agentThreadId: string; agentPath?: string; state: string }
  | { type: "agent.identity"; threadId: string; nickname?: string; role?: string; parentThreadId?: string }
  | { type: "agent.activity"; threadId: string; tool: string; status: string; model?: string; reasoningEffort?: string }
  | { type: "agent.requestedConfig"; parentThreadId: string; agentThreadId: string; prompt?: string; model?: string; reasoningEffort?: string }
  | { type: "agent.effectiveConfig"; threadId: string; model?: string; reasoningEffort?: string }
  | { type: "tokens.updated"; threadId: string; totalTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "loop.configured"; threadId: string; objective?: string; verifier?: string; maxTokens?: number; maxIterations?: number }
  | { type: "evidence.collected"; threadId: string; itemId?: string; summary: string; source: string }
  | { type: "loop.verified"; threadId: string; status: "passed" | "failed"; summary?: string }
  | { type: "execution.declared"; graph: ExecutionGraphDefinition }
  | { type: "execution.updated"; executionId: string; nodes?: ExecutionNodeDefinition[]; edges?: ExecutionEdgeDefinition[]; entryNodeIds?: string[]; terminalNodeIds?: string[]; objective?: string; label?: string }
  | { type: "execution.iteration.started"; executionId: string; iteration: number; reason?: string }
  | { type: "execution.node.started"; executionId: string; nodeId: string; activationId: string; threadId: string; iteration?: number; status?: "running" | "waiting" }
  | { type: "execution.node.completed"; executionId: string; nodeId: string; activationId: string; status: Exclude<NodeActivationStatus, "queued" | "running" | "waiting">; summary?: string }
  | { type: "execution.edge.selected"; executionId: string; edgeId: string; traversalId: string; iteration?: number }
  | { type: "execution.completed"; executionId: string; status: Extract<ExecutionStatus, "completed" | "failed" | "stopped" | "blocked">; reason?: string };
