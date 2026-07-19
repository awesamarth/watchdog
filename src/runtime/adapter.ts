import type { HarnessAdapter, AgentCapabilities } from "../adapters/types.js";
import type { WatchdogEvent } from "../adapters/events.js";
import type { ControlHandlers } from "./control.js";
import { RuntimeState, type RunSnapshot } from "./state.js";

export function adapterSnapshot(adapter: HarnessAdapter, state: RuntimeState): RunSnapshot {
  const snapshot = state.snapshot();
  return {
    ...snapshot,
    adapter: adapter.descriptor,
    capabilities: Object.fromEntries(snapshot.agents.map((agent) => [agent.threadId, adapter.capabilities(agent)])),
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
      recordEvent({ type: "loop.configured", threadId: agent.threadId, ...options });
      return state.snapshot().loops.find((loop) => loop.threadId === agent.threadId);
    },
    addEvidence: async (target, summary, source) => {
      const agent = state.resolve(target);
      recordEvent({ type: "evidence.collected", threadId: agent.threadId, summary, source: source ?? "operator" });
      return { recorded: true, agent: agentLabel(agent) };
    },
    verifyLoop: async (target, status, summary) => {
      const agent = state.resolve(target);
      recordEvent({ type: "loop.verified", threadId: agent.threadId, status, summary });
      return state.snapshot().loops.find((loop) => loop.threadId === agent.threadId);
    },
    declareExecution: async (graph) => {
      const owner = state.resolve(graph.ownerThreadId);
      const normalized = { ...graph, ownerThreadId: owner.threadId };
      recordEvent({ type: "execution.declared", graph: normalized });
      return state.snapshot().executions.find((execution) => execution.id === graph.id);
    },
    updateExecution: async ({ executionId, nodes, edges, entryNodeIds, terminalNodeIds, objective, label }) => {
      recordEvent({ type: "execution.updated", executionId, nodes, edges, entryNodeIds, terminalNodeIds, objective, label });
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
    completeExecution: async (executionId, status, reason) => {
      recordEvent({ type: "execution.completed", executionId, status, reason });
      return state.snapshot().executions.find((execution) => execution.id === executionId);
    },
  };
}

function requireCapability(capability: AgentCapabilities[keyof AgentCapabilities], action: string): void {
  if (!capability.available) throw new Error(capability.reason ?? `This adapter cannot ${action} the selected agent.`);
}

function agentLabel(agent: { nickname?: string; agentPath?: string; threadId: string }): string {
  return agent.nickname ?? agent.agentPath ?? agent.threadId.slice(0, 8);
}
