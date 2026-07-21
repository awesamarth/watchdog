import { randomUUID } from "node:crypto";
import {
  unavailable,
  type AgentCapabilities,
  type Capability,
  type ExecutionCapabilities,
  type ExecutionTargetCapabilities,
  type HarnessAdapter,
} from "../adapters/types.js";
import type { WatchdogEvent } from "../adapters/events.js";
import type { ExecutionGraphState, ExecutionPolicy, NodeActivation } from "../execution/types.js";
import type { ControlHandlers } from "./control.js";
import { RuntimeState, type AgentState, type RunSnapshot } from "./state.js";

export function adapterSnapshot(adapter: HarnessAdapter, state: RuntimeState): RunSnapshot {
  const snapshot = state.snapshot();
  return {
    ...snapshot,
    adapter: adapter.descriptor,
    capabilities: Object.fromEntries(snapshot.agents.map((agent) => [agent.threadId, adapter.capabilities(agent)])),
    executionCapabilities: Object.fromEntries(snapshot.executions.map((execution) => [
      execution.id,
      executionControlCapabilities(adapter, snapshot, execution),
    ])),
  };
}

export function createRuntimeControlHandlers(
  adapter: HarnessAdapter,
  state: RuntimeState,
  recordEvent: (event: WatchdogEvent) => void,
): ControlHandlers {
  return {
    snapshot: () => adapterSnapshot(adapter, state),
    steer: async (target, message) => {
      const agent = state.resolve(target);
      requireCapability(adapter.capabilities(agent).steer, "steer");
      return await adapter.steer(agent, message);
    },
    followUp: async (target, message) => {
      const agent = state.resolve(target);
      requireCapability(adapter.capabilities(agent).followUp, "send a follow-up to");
      return await adapter.followUp(agent, message);
    },
    interrupt: async (target) => {
      const agent = state.resolve(target);
      requireCapability(adapter.capabilities(agent).interrupt, "interrupt");
      return await adapter.interrupt(agent);
    },
    retry: async (target, message, model, effort) => {
      const agent = state.resolve(target);
      const capabilities = adapter.capabilities(agent);
      requireCapability(capabilities.retry, "retry");
      if (model || effort) requireCapability(capabilities.modelOverride, "change model or reasoning effort");
      return await adapter.retry(agent, { message, model, effort });
    },
    configureLoop: async (target, options) => {
      const agent = state.resolve(target);
      const execution = explicitExecutionFor(state, agent.threadId);
      if (execution) {
        recordEvent({
          type: "execution.updated",
          executionId: execution.id,
          objective: options.objective,
          policy: definedLoopPolicy(options),
        });
        return state.snapshot().executions.find((candidate) => candidate.id === execution.id);
      }
      recordEvent({ type: "loop.configured", threadId: agent.threadId, ...options });
      return state.snapshot().loops.find((loop) => loop.threadId === agent.threadId);
    },
    addEvidence: async (target, summary, source) => {
      const agent = state.resolve(target);
      const execution = explicitExecutionFor(state, agent.threadId);
      if (execution) {
        recordEvent({
          type: "execution.evidence.collected",
          executionId: execution.id,
          threadId: agent.threadId,
          nodeId: agent.execution?.executionId === execution.id ? agent.execution.nodeId : undefined,
          summary,
          source: source ?? "operator",
        });
        return { recorded: true, executionId: execution.id, agent: agentLabel(agent) };
      }
      recordEvent({ type: "evidence.collected", threadId: agent.threadId, summary, source: source ?? "operator" });
      return { recorded: true, agent: agentLabel(agent) };
    },
    verifyLoop: async (target, status, summary) => {
      const agent = state.resolve(target);
      const execution = explicitExecutionFor(state, agent.threadId);
      if (execution) {
        recordEvent({ type: "execution.verified", executionId: execution.id, status, summary });
        return state.snapshot().executions.find((candidate) => candidate.id === execution.id);
      }
      recordEvent({ type: "loop.verified", threadId: agent.threadId, status, summary });
      return state.snapshot().loops.find((loop) => loop.threadId === agent.threadId);
    },
    declareExecution: async (graph) => {
      const owner = state.resolve(graph.ownerThreadId);
      const normalized = { ...graph, ownerThreadId: owner.threadId };
      recordEvent({ type: "execution.declared", graph: normalized });
      return state.snapshot().executions.find((execution) => execution.id === graph.id);
    },
    updateExecution: async ({ executionId, nodes, edges, entryNodeIds, terminalNodeIds, objective, label, policy }) => {
      recordEvent({ type: "execution.updated", executionId, nodes, edges, entryNodeIds, terminalNodeIds, objective, label, policy });
      return state.snapshot().executions.find((execution) => execution.id === executionId);
    },
    startExecutionIteration: async (executionId, iteration, reason) => {
      recordEvent({ type: "execution.iteration.started", executionId, iteration, reason });
      return state.snapshot().executions.find((execution) => execution.id === executionId);
    },
    startExecutionNode: async ({ executionId, nodeId, activationId, agent: target, iteration, status }) => {
      const agent = state.resolve(target);
      recordEvent({ type: "execution.node.started", executionId, nodeId, activationId, threadId: agent.threadId, iteration, status });
      return state.snapshot().executions.find((execution) => execution.id === executionId);
    },
    completeExecutionNode: async ({ executionId, nodeId, activationId, status, summary }) => {
      recordEvent({ type: "execution.node.completed", executionId, nodeId, activationId, status, summary });
      return state.snapshot().executions.find((execution) => execution.id === executionId);
    },
    selectExecutionEdge: async ({ executionId, edgeId, traversalId, iteration }) => {
      recordEvent({ type: "execution.edge.selected", executionId, edgeId, traversalId, iteration });
      return state.snapshot().executions.find((execution) => execution.id === executionId);
    },
    addExecutionEvidence: async ({ executionId, agent: target, nodeId, summary, source }) => {
      const agent = state.resolve(target);
      recordEvent({
        type: "execution.evidence.collected",
        executionId,
        threadId: agent.threadId,
        nodeId,
        summary,
        source: source ?? "operator",
      });
      return state.snapshot().executions.find((execution) => execution.id === executionId);
    },
    verifyExecution: async (executionId, status, summary) => {
      recordEvent({ type: "execution.verified", executionId, status, summary });
      return state.snapshot().executions.find((execution) => execution.id === executionId);
    },
    stopExecution: async (executionId, nodeId, reason) => {
      return await stopExecutionTarget(adapter, state, recordEvent, executionId, nodeId, reason);
    },
    retryExecutionNode: async ({ executionId, nodeId, message, model, effort }) => {
      return await retryExecutionNode(adapter, state, recordEvent, executionId, nodeId, message, model, effort);
    },
    completeExecution: async (executionId, status, reason) => {
      recordEvent({ type: "execution.completed", executionId, status, reason });
      return state.snapshot().executions.find((execution) => execution.id === executionId);
    },
  };
}

export function createReadOnlyControlHandlers(adapter: HarnessAdapter, state: RuntimeState): ControlHandlers {
  const reject = async () => {
    throw new Error("Historical and observed Watchdog runs are read-only.");
  };
  return {
    snapshot: () => adapterSnapshot(adapter, state),
    steer: reject,
    followUp: reject,
    interrupt: reject,
    retry: reject,
    configureLoop: reject,
    addEvidence: reject,
    verifyLoop: reject,
  };
}

function explicitExecutionFor(state: RuntimeState, threadId: string): ExecutionGraphState | undefined {
  const execution = state.executionForThread(threadId);
  return execution?.authority === "legacy" ? undefined : execution;
}

function definedLoopPolicy(options: ExecutionPolicy): ExecutionPolicy {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as ExecutionPolicy;
}

function executionControlCapabilities(
  adapter: HarnessAdapter,
  snapshot: RunSnapshot,
  execution: ExecutionGraphState,
): ExecutionCapabilities {
  const nodes = Object.fromEntries(execution.nodes.map((node) => [
    node.id,
    nodeControlCapabilities(adapter, snapshot, execution, node.id),
  ]));
  return {
    pause: unavailable("The connected harness does not expose a resumable execution pause primitive."),
    stop: stopCapability(adapter, snapshot, execution, undefined),
    retry: unavailable("Retry an individual node so Watchdog can preserve the graph's real recovery path."),
    nodes,
  };
}

function nodeControlCapabilities(
  adapter: HarnessAdapter,
  snapshot: RunSnapshot,
  execution: ExecutionGraphState,
  nodeId: string,
): ExecutionTargetCapabilities {
  const node = execution.nodes.find((candidate) => candidate.id === nodeId);
  const latest = latestNodeActivation(execution, nodeId);
  const retry = (() => {
    if (node?.kind === "subgraph") return unavailable("Retry the nested execution's concrete node instead of manufacturing a subgraph restart.");
    if (!latest || ["queued", "running", "waiting"].includes(latest.status)) return unavailable("This node has no completed attempt to retry.");
    const agents = activationAgents(snapshot, latest);
    if (agents.length !== 1) return unavailable("Node retry requires exactly one retained agent context.");
    return adapter.capabilities(agents[0]!).retry;
  })();
  return {
    pause: unavailable("The connected harness does not expose a resumable node pause primitive."),
    stop: stopCapability(adapter, snapshot, execution, nodeId),
    retry,
  };
}

function stopCapability(
  adapter: HarnessAdapter,
  snapshot: RunSnapshot,
  execution: ExecutionGraphState,
  nodeId: string | undefined,
): Capability {
  const activations = activeTargetActivations(snapshot, execution, nodeId);
  const agents = uniqueAgents(activations.flatMap(({ activation }) => activationAgents(snapshot, activation)))
    .filter((agent) => agent.activeTurnId);
  if (agents.length === 0) return unavailable(nodeId ? "This node has no interruptible active agent." : "This execution has no interruptible active agents.");
  const unavailableAgent = agents.find((agent) => !adapter.capabilities(agent).interrupt.available);
  if (unavailableAgent) {
    const capability = adapter.capabilities(unavailableAgent).interrupt;
    return unavailable(capability.reason ?? `${agentLabel(unavailableAgent)} cannot be interrupted by this adapter.`);
  }
  return { available: true };
}

async function stopExecutionTarget(
  adapter: HarnessAdapter,
  state: RuntimeState,
  recordEvent: (event: WatchdogEvent) => void,
  executionId: string,
  nodeId?: string,
  reason?: string,
): Promise<unknown> {
  const snapshot = state.snapshot();
  const execution = requiredExecution(snapshot, executionId);
  if (nodeId && !execution.nodes.some((node) => node.id === nodeId)) {
    throw new Error(`Execution '${executionId}' has no node '${nodeId}'.`);
  }
  const capability = stopCapability(adapter, snapshot, execution, nodeId);
  requireCapability(capability, nodeId ? "stop this execution node" : "stop this execution");
  const activations = activeTargetActivations(snapshot, execution, nodeId);
  const agents = uniqueAgents(activations.flatMap(({ activation }) => activationAgents(snapshot, activation)))
    .filter((agent) => agent.activeTurnId);
  const outcomes = await Promise.allSettled(agents.map(async (agent) => ({
    threadId: agent.threadId,
    agent: agentLabel(agent),
    result: await adapter.interrupt(agent),
  })));
  const stoppedThreadIds = new Set(outcomes.flatMap((outcome) =>
    outcome.status === "fulfilled" ? [outcome.value.threadId] : []));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [{ agent: agentLabel(agents[index]!), error: errorMessage(outcome.reason) }]
      : []);
  const stoppedAt = reason ?? "Stopped by Watchdog operator.";
  for (const { execution: owner, activation } of activations) {
    const activeAgents = activationAgents(snapshot, activation).filter((agent) => agent.activeTurnId);
    if (!activeAgents.length || !activeAgents.every((agent) => stoppedThreadIds.has(agent.threadId))) continue;
    recordEvent({
      type: "execution.node.completed",
      executionId: owner.id,
      nodeId: activation.nodeId,
      activationId: activation.id,
      status: "stopped",
      summary: stoppedAt,
    });
  }
  const targetExecutions = targetExecutionIds(snapshot, execution, nodeId);
  if (!failures.length && !nodeId) {
    for (const id of [...targetExecutions].reverse()) {
      recordEvent({ type: "execution.completed", executionId: id, status: "stopped", reason: stoppedAt });
    }
  } else if (!failures.length) {
    const node = execution.nodes.find((candidate) => candidate.id === nodeId);
    if (node?.subgraphId) {
      for (const id of [...targetExecutions].filter((id) => id !== execution.id).reverse()) {
        recordEvent({ type: "execution.completed", executionId: id, status: "stopped", reason: stoppedAt });
      }
    }
  }
  if (failures.length) {
    throw new Error(`Execution stop was partial: ${failures.map((failure) => `${failure.agent}: ${failure.error}`).join("; ")}`);
  }
  return {
    stopped: nodeId ? `${executionId}/${nodeId}` : executionId,
    agents: outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []),
  };
}

async function retryExecutionNode(
  adapter: HarnessAdapter,
  state: RuntimeState,
  recordEvent: (event: WatchdogEvent) => void,
  executionId: string,
  nodeId: string,
  message: string,
  model?: string,
  effort?: string,
): Promise<unknown> {
  const snapshot = state.snapshot();
  const execution = requiredExecution(snapshot, executionId);
  const capabilities = nodeControlCapabilities(adapter, snapshot, execution, nodeId);
  requireCapability(capabilities.retry, "retry this execution node");
  if (model || effort) {
    const activation = latestNodeActivation(execution, nodeId)!;
    const agent = activationAgents(snapshot, activation)[0]!;
    requireCapability(adapter.capabilities(agent).modelOverride, "change model or reasoning effort");
  }
  const previous = latestNodeActivation(execution, nodeId)!;
  const agent = activationAgents(snapshot, previous)[0]!;
  const result = await adapter.retry(agent, { message, model, effort });
  const activationId = `operator-retry:${randomUUID()}`;
  recordEvent({
    type: "execution.node.started",
    executionId,
    nodeId,
    activationId,
    threadId: agent.threadId,
    iteration: Math.max(1, execution.iteration),
  });
  return { retrying: `${executionId}/${nodeId}`, activationId, agent: agentLabel(agent), result };
}

function activeTargetActivations(
  snapshot: RunSnapshot,
  execution: ExecutionGraphState,
  nodeId?: string,
): Array<{ execution: ExecutionGraphState; activation: NodeActivation }> {
  const ids = targetExecutionIds(snapshot, execution, nodeId);
  const active = new Set(["queued", "running", "waiting"]);
  const result: Array<{ execution: ExecutionGraphState; activation: NodeActivation }> = [];
  for (const id of ids) {
    const candidate = requiredExecution(snapshot, id);
    for (const activation of candidate.activations) {
      if (!active.has(activation.status)) continue;
      if (id === execution.id && nodeId && activation.nodeId !== nodeId) continue;
      result.push({ execution: candidate, activation });
    }
  }
  return result;
}

function targetExecutionIds(snapshot: RunSnapshot, execution: ExecutionGraphState, nodeId?: string): string[] {
  const rootIds = nodeId
    ? [execution.nodes.find((node) => node.id === nodeId)?.subgraphId].filter((id): id is string => Boolean(id))
    : [execution.id];
  const ids = nodeId ? [execution.id] : [];
  const visit = (id: string) => {
    if (ids.includes(id)) return;
    ids.push(id);
    for (const child of snapshot.executions.filter((candidate) => candidate.parentExecutionId === id)) visit(child.id);
  };
  for (const id of rootIds) visit(id);
  return ids;
}

function activationAgents(snapshot: RunSnapshot, activation: NodeActivation): AgentState[] {
  const ids = new Set(activation.threadIds);
  return snapshot.agents.filter((agent) => ids.has(agent.threadId));
}

function uniqueAgents(agents: AgentState[]): AgentState[] {
  return [...new Map(agents.map((agent) => [agent.threadId, agent])).values()];
}

function latestNodeActivation(execution: ExecutionGraphState, nodeId: string): NodeActivation | undefined {
  return [...execution.activations].reverse().find((activation) => activation.nodeId === nodeId);
}

function requiredExecution(snapshot: RunSnapshot, executionId: string): ExecutionGraphState {
  const execution = snapshot.executions.find((candidate) => candidate.id === executionId);
  if (!execution) throw new Error(`Unknown execution '${executionId}'.`);
  return execution;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireCapability(capability: AgentCapabilities[keyof AgentCapabilities], action: string): void {
  if (!capability.available) throw new Error(capability.reason ?? `This adapter cannot ${action} the selected agent.`);
}

function agentLabel(agent: { nickname?: string; agentPath?: string; threadId: string }): string {
  return agent.nickname ?? agent.agentPath ?? agent.threadId.slice(0, 8);
}
