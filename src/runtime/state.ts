import { EventEmitter } from "node:events";
import type { AdapterDescriptor, AgentCapabilities, ExecutionCapabilities } from "../adapters/types.js";
import type { WatchdogEvent } from "../adapters/events.js";
import {
  EXECUTION_AUTHORITY_RANK,
  createLegacyLoopGraph,
  executionHasCycle,
  legacyLoopExecutionId,
  normalizeExecutionGraph,
  type ExecutionGraphDefinition,
  type ExecutionGraphState,
  type NodeActivation,
} from "../execution/types.js";

type AgentConfig = { model?: string; effort?: string };
type AgentMessage = { id: string; text: string; at: string };
type StreamingAgentMessage = { itemId: string; text: string; startedAt: string; updatedAt: string };
type AgentActivity = { id: string; tool: string; status: string; at: string };

export type AgentState = {
  threadId: string;
  parentThreadId?: string;
  nickname?: string;
  role?: string;
  kind?: "root" | "native-child" | "subprocess-worker" | "independent-session";
  agentPath?: string;
  status: string;
  activeTurnId?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  requested?: AgentConfig & { prompt?: string };
  effective?: AgentConfig;
  latestActivity?: { tool: string; status: string };
  activities?: AgentActivity[];
  activityCount?: number;
  task?: string;
  latestMessage?: string;
  messages?: AgentMessage[];
  messageCount?: number;
  streamingMessage?: StreamingAgentMessage;
  execution?: { executionId: string; nodeId: string; activationId: string };
  startedAt?: string;
  lastActivityAt?: string;
  lastTurnCompletedAt?: string;
};

export type RunSnapshot = {
  startedAt: string;
  mode: "live" | "observed";
  agents: AgentState[];
  loops: LoopState[];
  executions: ExecutionGraphState[];
  adapter?: AdapterDescriptor;
  capabilities?: Record<string, AgentCapabilities>;
  executionCapabilities?: Record<string, ExecutionCapabilities>;
};

export type LoopState = {
  threadId: string;
  objective?: string;
  iteration: number;
  activeTurnId?: string;
  phase: "plan" | "execute" | "verify" | "done" | "blocked";
  verifier?: string;
  verification: { status: "not-run" | "running" | "passed" | "failed"; summary?: string; at?: string };
  evidence: Array<{ id: string; iteration: number; summary: string; source: string; agentThreadId: string; at: string }>;
  budget: { maxTokens?: number; maxIterations?: number; usedTokens: number };
  warnings: string[];
};

export class RuntimeState extends EventEmitter {
  #agents = new Map<string, AgentState>();
  #loops = new Map<string, LoopState>();
  #executions = new Map<string, ExecutionGraphState>();
  readonly startedAt = new Date().toISOString();

  constructor(readonly mode: "live" | "observed" = "live") { super(); }

  apply(event: WatchdogEvent): void {
    switch (event.type) {
      case "thread.started": {
        const agent = this.#ensure(event.threadId);
        agent.parentThreadId = event.parentThreadId ?? agent.parentThreadId;
        agent.nickname = event.nickname ?? agent.nickname;
        agent.role = event.role ?? agent.role;
        agent.kind = event.kind ?? agent.kind ?? (event.parentThreadId ? undefined : "root");
        agent.startedAt ??= new Date().toISOString();
        break;
      }
      case "thread.status": {
        const agent = this.#ensure(event.threadId);
        agent.status = event.status;
        agent.lastActivityAt = new Date().toISOString();
        break;
      }
      case "turn.started": {
        const agent = this.#ensure(event.threadId);
        if (agent.activeTurnId === event.turnId) break;
        agent.activeTurnId = event.turnId;
        agent.status = "active";
        agent.lastActivityAt = new Date().toISOString();
        const loop = this.#loops.get(event.threadId);
        if (loop) {
          loop.iteration += 1;
          loop.activeTurnId = event.turnId;
          loop.phase = "execute";
          this.#startLegacyAttempt(loop, event.turnId);
        }
        break;
      }
      case "turn.input": {
        const agent = this.#ensure(event.threadId);
        agent.task = event.input;
        agent.lastActivityAt = new Date().toISOString();
        break;
      }
      case "agent.message.delta": {
        const agent = this.#ensure(event.threadId);
        const at = event.at ?? new Date().toISOString();
        if (agent.streamingMessage?.itemId === event.itemId) {
          agent.streamingMessage.text += event.delta;
          agent.streamingMessage.updatedAt = at;
        } else {
          agent.streamingMessage = { itemId: event.itemId, text: event.delta, startedAt: at, updatedAt: at };
        }
        agent.lastActivityAt = at;
        break;
      }
      case "agent.message": {
        const agent = this.#ensure(event.threadId);
        const at = event.at ?? new Date().toISOString();
        const messages = agent.messages ??= [];
        const messageCount = agent.messageCount ?? 0;
        const id = event.itemId ?? `${event.threadId}:message:${messageCount + 1}`;
        if (messages.some((message) => message.id === id)) break;
        messages.push({ id, text: event.message, at });
        agent.messageCount = messageCount + 1;
        if (messages.length > MAX_AGENT_MESSAGES) messages.splice(0, messages.length - MAX_AGENT_MESSAGES);
        agent.latestMessage = event.message;
        if (agent.streamingMessage?.itemId === event.itemId) agent.streamingMessage = undefined;
        agent.lastActivityAt = at;
        break;
      }
      case "turn.completed": {
        const agent = this.#ensure(event.threadId);
        if (agent.activeTurnId === event.turnId) agent.activeTurnId = undefined;
        agent.streamingMessage = undefined;
        agent.lastActivityAt = new Date().toISOString();
        agent.lastTurnCompletedAt = agent.lastActivityAt;
        const loop = this.#loops.get(event.threadId);
        if (loop?.activeTurnId === event.turnId) {
          loop.activeTurnId = undefined;
          if (loop.verification.status !== "passed") loop.phase = "verify";
          this.#waitForLegacyVerification(loop, event.turnId);
        }
        break;
      }
      case "loop.objective": {
        const agent = this.#ensure(event.threadId);
        if (!agent.parentThreadId) {
          const loop = this.#loop(event.threadId);
          loop.objective = event.objective;
          this.#syncLegacyLoop(loop);
          this.#activateLoop(loop, agent, event.turnId);
        }
        break;
      }
      case "agent.spawned": {
        const agent = this.#ensure(event.agentThreadId);
        agent.parentThreadId = event.parentThreadId;
        agent.agentPath = event.agentPath ?? agent.agentPath;
        this.#associateSpawnedAgent(agent, event.parentThreadId);
        break;
      }
      case "agent.identity": {
        const agent = this.#ensure(event.threadId);
        agent.parentThreadId = event.parentThreadId ?? agent.parentThreadId;
        agent.nickname = event.nickname ?? agent.nickname;
        agent.role = event.role ?? agent.role;
        break;
      }
      case "agent.activity": {
        const agent = this.#ensure(event.threadId);
        const at = event.at ?? new Date().toISOString();
        const activities = agent.activities ??= [];
        const existing = event.itemId
          ? activities.find((activity) => activity.id === event.itemId)
          : event.status !== "inProgress"
            ? [...activities].reverse().find((activity) => activity.tool === event.tool && activity.status === "inProgress")
            : undefined;
        if (existing) {
          existing.tool = event.tool;
          existing.status = event.status;
          existing.at = at;
          const index = activities.indexOf(existing);
          if (index >= 0 && index !== activities.length - 1) activities.push(...activities.splice(index, 1));
        } else {
          activities.push({
            id: event.itemId ?? `${event.threadId}:activity:${(agent.activityCount ?? 0) + 1}`,
            tool: event.tool,
            status: event.status,
            at,
          });
          agent.activityCount = (agent.activityCount ?? 0) + 1;
          if (activities.length > MAX_AGENT_ACTIVITIES) activities.splice(0, activities.length - MAX_AGENT_ACTIVITIES);
        }
        agent.latestActivity = { tool: event.tool, status: event.status };
        agent.lastActivityAt = at;
        break;
      }
      case "agent.requestedConfig": {
        const agent = this.#ensure(event.agentThreadId);
        agent.parentThreadId = event.parentThreadId;
        const current = agent.requested ?? {};
        agent.requested = {
          model: event.model ?? current.model,
          effort: event.reasoningEffort ?? current.effort,
          prompt: readablePrompt(event.prompt) ?? current.prompt,
        };
        break;
      }
      case "agent.effectiveConfig": {
        const agent = this.#ensure(event.threadId);
        agent.effective = { model: event.model, effort: event.reasoningEffort };
        break;
      }
      case "tokens.updated": {
        const agent = this.#ensure(event.threadId);
        agent.totalTokens = event.totalTokens ?? agent.totalTokens;
        agent.inputTokens = event.inputTokens ?? agent.inputTokens;
        agent.outputTokens = event.outputTokens ?? agent.outputTokens;
        agent.costUsd = event.costUsd ?? agent.costUsd;
        break;
      }
      case "loop.configured": {
        const agent = this.#ensure(event.threadId);
        const loop = this.#loop(event.threadId);
        loop.objective = event.objective ?? loop.objective;
        loop.verifier = event.verifier ?? loop.verifier;
        loop.budget.maxTokens = event.maxTokens ?? loop.budget.maxTokens;
        loop.budget.maxIterations = event.maxIterations ?? loop.budget.maxIterations;
        this.#syncLegacyLoop(loop);
        if (agent.activeTurnId) this.#activateLoop(loop, agent, agent.activeTurnId);
        break;
      }
      case "evidence.collected": {
        const loop = this.#owningLoop(event.threadId);
        if (!loop) break;
        this.#addEvidence(loop, event.threadId, event.summary, event.source, event.itemId);
        break;
      }
      case "loop.verified": {
        const loop = this.#loop(event.threadId);
        loop.verification = { status: event.status, summary: event.summary, at: new Date().toISOString() };
        loop.phase = event.status === "passed" ? "done" : "blocked";
        this.#completeLegacyVerification(loop, event.status, event.summary);
        break;
      }
      case "execution.declared": {
        this.#declareExecution(event.graph);
        break;
      }
      case "execution.updated": {
        this.#updateExecution(event.executionId, event);
        break;
      }
      case "execution.iteration.started": {
        const execution = this.#execution(event.executionId);
        execution.iteration = Math.max(execution.iteration, event.iteration);
        execution.status = "running";
        execution.startedAt ??= new Date().toISOString();
        execution.completedAt = undefined;
        execution.stopReason = undefined;
        if (execution.policy?.verifier || execution.nodes.some((node) => node.kind === "verifier")) {
          execution.verification = { status: "not-run" };
        }
        break;
      }
      case "execution.node.started": {
        this.#startNode(event.executionId, {
          id: event.activationId,
          nodeId: event.nodeId,
          iteration: event.iteration,
          threadId: event.threadId,
          status: event.status,
        });
        break;
      }
      case "execution.node.completed": {
        this.#completeNode(event.executionId, event.nodeId, event.activationId, event.status, event.summary);
        break;
      }
      case "execution.edge.selected": {
        this.#selectEdge(event.executionId, event.edgeId, event.traversalId, event.iteration);
        break;
      }
      case "execution.evidence.collected": {
        this.#addExecutionEvidence(event.executionId, event.threadId, event.summary, event.source, event.itemId, event.nodeId);
        break;
      }
      case "execution.verified": {
        const execution = this.#execution(event.executionId);
        execution.verification = { status: event.status, summary: event.summary, at: new Date().toISOString() };
        if (event.status === "failed") {
          execution.status = "blocked";
          execution.stopReason = event.summary ?? "Execution verifier failed.";
        } else {
          execution.status = execution.activeNodeIds.length ? "running" : "waiting";
          execution.stopReason = undefined;
        }
        break;
      }
      case "execution.completed": {
        const execution = this.#execution(event.executionId);
        execution.status = event.status;
        execution.stopReason = event.reason;
        execution.completedAt ??= new Date().toISOString();
        execution.activeNodeIds = [];
        break;
      }
    }
    this.emit("changed", this.snapshot());
  }

  snapshot(): RunSnapshot {
    const agents = [...this.#agents.values()].map((agent) => ({
      ...agent,
      activities: (agent.activities ?? []).map((activity) => ({ ...activity })),
      activityCount: agent.activityCount ?? agent.activities?.length ?? 0,
      messages: (agent.messages ?? []).map((message) => ({ ...message })),
      messageCount: agent.messageCount ?? agent.messages?.length ?? 0,
      streamingMessage: agent.streamingMessage ? { ...agent.streamingMessage } : undefined,
    }));
    const executions = [...this.#executions.values()];
    return {
      startedAt: this.startedAt,
      mode: this.mode,
      agents,
      loops: [...this.#loops.values()].map((loop) => ({
        ...loop,
        evidence: [...loop.evidence],
        budget: { ...loop.budget, usedTokens: loopTokenUse(loop.threadId, agents) },
        warnings: loopWarnings(loop, agents),
      })),
      executions: executions.map((execution) => {
        const incompleteReason = executionIncompleteReason(execution, agents);
        return {
          ...execution,
          status: incompleteReason ? "waiting" : execution.status,
          incompleteReason,
          policy: { ...execution.policy },
          source: { ...execution.source },
          nodes: execution.nodes.map((node) => ({ ...node })),
          edges: execution.edges.map((edge) => ({ ...edge })),
          entryNodeIds: [...execution.entryNodeIds],
          terminalNodeIds: [...execution.terminalNodeIds],
          activations: execution.activations.map((activation) => ({ ...activation, threadIds: [...activation.threadIds] })),
          traversals: execution.traversals.map((traversal) => ({ ...traversal })),
          activeNodeIds: [...execution.activeNodeIds],
          evidence: execution.evidence.map((item) => ({ ...item })),
          verification: { ...execution.verification },
          usedTokens: executionTokenUse(execution, agents, executions),
          warnings: executionWarnings(execution, agents, executions, incompleteReason),
        };
      }),
    };
  }

  resolve(target: string): AgentState {
    if (target.toLowerCase() === "root") {
      const roots = [...this.#agents.values()].filter((agent) => !agent.parentThreadId);
      if (roots.length === 1) return roots[0]!;
    }
    const needle = target.toLowerCase();
    const matches = [...this.#agents.values()].filter((agent) =>
      agent.threadId.toLowerCase().startsWith(needle)
      || agent.nickname?.toLowerCase() === needle
      || agent.agentPath?.toLowerCase() === needle,
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`No active Watchdog agent matches '${target}'`);
    throw new Error(`'${target}' is ambiguous; use a longer thread id`);
  }

  rootFor(threadId: string): AgentState {
    let agent = this.#ensure(threadId);
    const seen = new Set<string>();
    while (agent.parentThreadId && !seen.has(agent.threadId)) {
      seen.add(agent.threadId);
      agent = this.#ensure(agent.parentThreadId);
    }
    return agent;
  }

  executionForThread(threadId: string): ExecutionGraphState | undefined {
    const agent = this.#agents.get(threadId);
    if (agent?.execution) return this.#executions.get(agent.execution.executionId);
    return [...this.#executions.values()].reverse().find((execution) =>
      execution.ownerThreadId === threadId
      || execution.activations.some((activation) => activation.threadIds.includes(threadId)),
    );
  }

  async waitForIdle(threadId: string, timeoutMs = 12_000): Promise<void> {
    if (!this.#ensure(threadId).activeTurnId) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("changed", onChange);
        reject(new Error("Timed out waiting for the agent to stop"));
      }, timeoutMs);
      const onChange = () => {
        if (!this.#ensure(threadId).activeTurnId) {
          clearTimeout(timer);
          this.off("changed", onChange);
          resolve();
        }
      };
      this.on("changed", onChange);
    });
  }

  async waitForActiveTurn(threadId: string, timeoutMs = 1_500): Promise<AgentState | undefined> {
    const current = this.#ensure(threadId);
    if (current.activeTurnId) return current;
    return await new Promise<AgentState | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.off("changed", onChange);
        resolve(undefined);
      }, timeoutMs);
      const onChange = () => {
        const agent = this.#ensure(threadId);
        if (agent.activeTurnId) {
          clearTimeout(timer);
          this.off("changed", onChange);
          resolve(agent);
        }
      };
      this.on("changed", onChange);
    });
  }

  #ensure(threadId: string): AgentState {
    let agent = this.#agents.get(threadId);
    if (!agent) {
      agent = { threadId, status: "unknown", messages: [], messageCount: 0 };
      this.#agents.set(threadId, agent);
    }
    return agent;
  }

  #loop(threadId: string): LoopState {
    let loop = this.#loops.get(threadId);
    if (!loop) {
      loop = { threadId, iteration: 0, phase: "plan", verification: { status: "not-run" }, evidence: [], budget: { usedTokens: 0 }, warnings: [] };
      this.#loops.set(threadId, loop);
    }
    return loop;
  }

  #activateLoop(loop: LoopState, agent: AgentState, turnId: string): void {
    if (agent.activeTurnId !== turnId) return;
    if (loop.activeTurnId !== turnId) {
      loop.iteration = Math.max(1, loop.iteration);
      loop.activeTurnId = turnId;
    }
    loop.phase = "execute";
    this.#startLegacyAttempt(loop, turnId);
  }

  #declareExecution(definition: ExecutionGraphDefinition): void {
    const graph = normalizeExecutionGraph(definition);
    const current = this.#executions.get(graph.id);
    if (current && EXECUTION_AUTHORITY_RANK[current.authority] > EXECUTION_AUTHORITY_RANK[graph.authority]) return;
    this.#validateNestedGraph(graph);
    this.#ensure(graph.ownerThreadId);
    this.#executions.set(graph.id, {
      ...graph,
      status: current?.status ?? "pending",
      iteration: current?.iteration ?? 0,
      activations: current?.activations ?? [],
      traversals: current?.traversals ?? [],
      activeNodeIds: current?.activeNodeIds ?? [],
      startedAt: current?.startedAt,
      completedAt: current?.completedAt,
      stopReason: current?.stopReason,
      evidence: current?.evidence ?? [],
      verification: current?.verification ?? { status: "not-run" },
      usedTokens: current?.usedTokens ?? 0,
      warnings: current?.warnings ?? [],
    });
  }

  #validateNestedGraph(graph: ExecutionGraphDefinition): void {
    const parent = graph.parentExecutionId ? this.#executions.get(graph.parentExecutionId) : undefined;
    if (parent && graph.parentNodeId) validateSubgraphLink(parent, graph.parentNodeId, graph.id);
    for (const child of this.#executions.values()) {
      if (child.parentExecutionId === graph.id && child.parentNodeId) {
        validateSubgraphLink(graph, child.parentNodeId, child.id);
      }
    }
  }

  #updateExecution(
    executionId: string,
    update: Extract<WatchdogEvent, { type: "execution.updated" }>,
  ): void {
    const current = this.#execution(executionId);
    const nodes = mergeById(current.nodes, update.nodes ?? []);
    const edges = mergeById(current.edges, update.edges ?? []);
    const graph = normalizeExecutionGraph({
      ...current,
      objective: update.objective ?? current.objective,
      label: update.label ?? current.label,
      policy: update.policy ? { ...current.policy, ...update.policy } : current.policy,
      nodes,
      edges,
      entryNodeIds: update.entryNodeIds ?? current.entryNodeIds,
      terminalNodeIds: update.terminalNodeIds ?? current.terminalNodeIds,
    });
    this.#validateNestedGraph(graph);
    Object.assign(current, graph);
  }

  #execution(executionId: string): ExecutionGraphState {
    const execution = this.#executions.get(executionId);
    if (!execution) throw new Error(`Unknown execution '${executionId}'.`);
    return execution;
  }

  #startNode(
    executionId: string,
    input: {
      id: string;
      nodeId: string;
      iteration?: number;
      threadId: string;
      status?: "running" | "waiting";
    },
  ): NodeActivation {
    const execution = this.#execution(executionId);
    if (!execution.nodes.some((node) => node.id === input.nodeId)) {
      throw new Error(`Execution '${executionId}' has no node '${input.nodeId}'.`);
    }
    const existing = execution.activations.find((activation) => activation.id === input.id);
    if (existing) {
      if (!existing.threadIds.includes(input.threadId)) existing.threadIds.push(input.threadId);
      return existing;
    }
    const iteration = input.iteration ?? Math.max(1, execution.iteration);
    execution.iteration = Math.max(execution.iteration, iteration);
    execution.status = input.status === "waiting" ? "waiting" : "running";
    execution.startedAt ??= new Date().toISOString();
    execution.completedAt = undefined;
    execution.stopReason = undefined;
    const activation: NodeActivation = {
      id: input.id,
      nodeId: input.nodeId,
      iteration,
      status: input.status ?? "running",
      threadIds: [input.threadId],
      startedAt: new Date().toISOString(),
    };
    execution.activations.push(activation);
    execution.activeNodeIds = [...new Set([...execution.activeNodeIds, input.nodeId])];
    if (execution.nodes.find((node) => node.id === input.nodeId)?.kind === "verifier") {
      execution.verification = { status: "running" };
    }
    const agent = this.#ensure(input.threadId);
    const assignedExecution = agent.execution && this.#executions.get(agent.execution.executionId);
    const assignedActivation = agent.execution && assignedExecution?.activations.find((candidate) => candidate.id === agent.execution?.activationId);
    const assignedIsActive = assignedActivation && ["running", "waiting", "queued"].includes(assignedActivation.status);
    if (!assignedExecution
      || !assignedIsActive
      || EXECUTION_AUTHORITY_RANK[execution.authority] >= EXECUTION_AUTHORITY_RANK[assignedExecution.authority]) {
      agent.execution = { executionId, nodeId: input.nodeId, activationId: input.id };
    }
    return activation;
  }

  #completeNode(
    executionId: string,
    nodeId: string,
    activationId: string,
    status: "passed" | "failed" | "stopped",
    summary?: string,
  ): void {
    const execution = this.#execution(executionId);
    const activation = execution.activations.find((candidate) => candidate.id === activationId);
    if (!activation || activation.nodeId !== nodeId) {
      throw new Error(`Execution '${executionId}' has no activation '${activationId}' for node '${nodeId}'.`);
    }
    activation.status = status;
    activation.summary = summary ?? activation.summary;
    activation.completedAt ??= new Date().toISOString();
    if (!execution.activations.some((candidate) =>
      candidate.id !== activation.id
      && candidate.nodeId === nodeId
      && ["running", "waiting", "queued"].includes(candidate.status),
    )) {
      execution.activeNodeIds = execution.activeNodeIds.filter((candidate) => candidate !== nodeId);
    }
    const node = execution.nodes.find((candidate) => candidate.id === nodeId);
    if (node?.kind === "verifier") {
      execution.verification = {
        status: status === "passed" ? "passed" : status === "failed" ? "failed" : "not-run",
        summary,
        at: new Date().toISOString(),
      };
    }
    if (status === "failed" || status === "stopped") {
      execution.status = "blocked";
      execution.stopReason = summary ?? `${node?.label ?? nodeId} ${status}.`;
    }
    else if (execution.activeNodeIds.length === 0 && execution.status !== "completed") execution.status = "waiting";
  }

  #selectEdge(executionId: string, edgeId: string, traversalId: string, iteration?: number): void {
    const execution = this.#execution(executionId);
    const edge = execution.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) throw new Error(`Execution '${executionId}' has no edge '${edgeId}'.`);
    if (execution.traversals.some((traversal) => traversal.id === traversalId)) return;
    execution.traversals.push({
      id: traversalId,
      edgeId,
      from: edge.from,
      to: edge.to,
      iteration: iteration ?? Math.max(1, execution.iteration),
      at: new Date().toISOString(),
    });
  }

  #syncLegacyLoop(loop: LoopState): ExecutionGraphState {
    const id = legacyLoopExecutionId(loop.threadId);
    const graph = createLegacyLoopGraph({
      threadId: loop.threadId,
      objective: loop.objective,
      verifier: loop.verifier,
    });
    this.#declareExecution(graph);
    return this.#execution(id);
  }

  #startLegacyAttempt(loop: LoopState, turnId: string): void {
    const execution = this.#syncLegacyLoop(loop);
    const activationId = `${turnId}:attempt`;
    const existing = execution.activations.find((activation) => activation.id === activationId);
    if (!existing) {
      this.#startNode(execution.id, {
        id: activationId,
        nodeId: "attempt",
        iteration: Math.max(1, loop.iteration),
        threadId: loop.threadId,
      });
    }
    execution.status = "running";
  }

  #waitForLegacyVerification(loop: LoopState, turnId: string): void {
    const execution = this.#syncLegacyLoop(loop);
    const attemptId = `${turnId}:attempt`;
    const attempt = execution.activations.find((activation) => activation.id === attemptId);
    if (attempt && ["running", "waiting", "queued"].includes(attempt.status)) {
      this.#completeNode(execution.id, "attempt", attemptId, "passed", "Iteration body completed.");
    }
    const verifyId = `${turnId}:verify`;
    if (!execution.activations.some((activation) => activation.id === verifyId)) {
      this.#startNode(execution.id, {
        id: verifyId,
        nodeId: "verify",
        iteration: Math.max(1, loop.iteration),
        threadId: loop.threadId,
        status: "waiting",
      });
    }
    this.#selectEdge(execution.id, "attempt-to-verify", `${turnId}:attempt-to-verify`, Math.max(1, loop.iteration));
    execution.status = "waiting";
  }

  #completeLegacyVerification(loop: LoopState, status: "passed" | "failed", summary?: string): void {
    const execution = this.#syncLegacyLoop(loop);
    const verify = [...execution.activations].reverse().find((activation) =>
      activation.nodeId === "verify" && ["running", "waiting", "queued"].includes(activation.status),
    );
    const activation = verify ?? this.#startNode(execution.id, {
      id: `${execution.id}:verify:${Math.max(1, loop.iteration)}`,
      nodeId: "verify",
      iteration: Math.max(1, loop.iteration),
      threadId: loop.threadId,
      status: "waiting",
    });
    this.#completeNode(execution.id, "verify", activation.id, status, summary);
    const edgeId = status === "passed" ? "verify-pass" : "verify-fail";
    this.#selectEdge(execution.id, edgeId, `${activation.id}:${edgeId}`, Math.max(1, loop.iteration));
    if (status === "passed") {
      const doneId = `${execution.id}:done`;
      this.#startNode(execution.id, {
        id: doneId,
        nodeId: "done",
        iteration: Math.max(1, loop.iteration),
        threadId: loop.threadId,
      });
      this.#completeNode(execution.id, "done", doneId, "passed", summary);
      execution.status = "completed";
      execution.completedAt = new Date().toISOString();
    } else {
      execution.status = "blocked";
      execution.stopReason = summary ?? "Verifier failed; waiting for the next attempt.";
    }
  }

  #associateSpawnedAgent(agent: AgentState, parentThreadId: string): void {
    const parent = this.#agents.get(parentThreadId);
    const parentReference = parent?.execution;
    const parentExecution = parentReference && this.#executions.get(parentReference.executionId);
    const parentActivation = parentReference && parentExecution?.activations.find((candidate) => candidate.id === parentReference.activationId);
    const reference = parentActivation && ["running", "waiting", "queued"].includes(parentActivation.status)
      ? parentReference
      : this.#latestActiveExecutionFor(parentThreadId);
    if (!reference) return;
    agent.execution = { ...reference };
    const execution = this.#executions.get(reference.executionId);
    const activation = execution?.activations.find((candidate) => candidate.id === reference.activationId);
    if (activation && !activation.threadIds.includes(agent.threadId)) activation.threadIds.push(agent.threadId);
  }

  #latestActiveExecutionFor(threadId: string): AgentState["execution"] {
    for (const execution of [...this.#executions.values()].reverse()) {
      for (const activation of [...execution.activations].reverse()) {
        if (["running", "waiting", "queued"].includes(activation.status) && activation.threadIds.includes(threadId)) {
          return { executionId: execution.id, nodeId: activation.nodeId, activationId: activation.id };
        }
      }
    }
    return undefined;
  }

  #addEvidence(loop: LoopState, threadId: string, summary: string, source: string, itemId?: string): void {
    const id = itemId ?? `${threadId}:${loop.iteration}:${summary}`;
    if (loop.evidence.some((item) => item.id === id)) return;
    loop.evidence.push({
      id,
      iteration: loop.iteration,
      summary,
      source,
      agentThreadId: threadId,
      at: new Date().toISOString(),
    });
    const execution = this.#executions.get(legacyLoopExecutionId(loop.threadId));
    if (execution) this.#addExecutionEvidence(execution.id, threadId, summary, source, id);
  }

  #addExecutionEvidence(
    executionId: string,
    threadId: string,
    summary: string,
    source: string,
    itemId?: string,
    nodeId?: string,
  ): void {
    const execution = this.#execution(executionId);
    const id = itemId ?? `${executionId}:${execution.iteration}:${threadId}:${summary}`;
    if (execution.evidence.some((item) => item.id === id)) return;
    execution.evidence.push({
      id,
      iteration: Math.max(1, execution.iteration),
      summary,
      source,
      threadId,
      nodeId,
      at: new Date().toISOString(),
    });
  }

  #owningLoop(threadId: string): LoopState | undefined {
    let current: string | undefined = threadId;
    while (current) {
      const loop = this.#loops.get(current);
      if (loop) return loop;
      current = this.#agents.get(current)?.parentThreadId;
    }
    return undefined;
  }
}

const MAX_AGENT_MESSAGES = 100;
const MAX_AGENT_ACTIVITIES = 50;

function readablePrompt(prompt?: string): string | undefined {
  const value = prompt?.trim();
  if (!value) return undefined;
  if (/^gAAAAA[A-Za-z0-9_-]{80,}={0,2}$/.test(value)) return undefined;
  return value;
}

function mergeById<T extends { id: string }>(current: T[], updates: T[]): T[] {
  const merged = new Map(current.map((value) => [value.id, value]));
  for (const update of updates) merged.set(update.id, { ...merged.get(update.id), ...update });
  return [...merged.values()];
}

function validateSubgraphLink(parent: ExecutionGraphDefinition, parentNodeId: string, childExecutionId: string): void {
  const node = parent.nodes.find((candidate) => candidate.id === parentNodeId);
  if (!node) throw new Error(`Execution '${parent.id}' has no parent node '${parentNodeId}' for nested execution '${childExecutionId}'.`);
  if (node.kind !== "subgraph" || node.subgraphId !== childExecutionId) {
    throw new Error(`Execution node '${parent.id}/${parentNodeId}' does not link to nested execution '${childExecutionId}'.`);
  }
}

function executionWarnings(
  execution: ExecutionGraphState,
  agents: AgentState[],
  executions: ExecutionGraphState[],
  incompleteReason?: string,
): string[] {
  const warnings = [...execution.warnings];
  if (incompleteReason) warnings.push(incompleteReason);
  const participants = executionAgents(execution, agents, executions);
  const usedTokens = executionTokenUse(execution, agents, executions);
  const verifierNodes = new Set(execution.nodes.filter((node) => node.kind === "verifier").map((node) => node.id));
  const cyclic = executionHasCycle(execution);
  if (execution.authority === "suspected") warnings.push("suspected execution shape; node boundaries are inferred");
  if (execution.iteration >= 2 && cyclic && !execution.policy?.verifier && verifierNodes.size === 0) {
    warnings.push("cyclic execution has no verifier node");
  }
  if (cyclic && execution.iteration >= 2 && execution.evidence.length === 0) {
    warnings.push("no evidence collected across iterations");
  }
  if (cyclic && execution.iteration >= 3 && execution.verification.status === "failed") {
    warnings.push(`possible runaway loop: ${execution.iteration} iterations without passing verification`);
  }
  if (execution.policy?.maxIterations && execution.iteration >= execution.policy.maxIterations) {
    warnings.push(`iteration budget reached: ${execution.iteration}/${execution.policy.maxIterations}`);
  }
  if (execution.policy?.maxTokens && usedTokens >= execution.policy.maxTokens) {
    warnings.push(`token budget exceeded: ${usedTokens}/${execution.policy.maxTokens}`);
  } else if (execution.policy?.maxTokens && usedTokens >= execution.policy.maxTokens * .8) {
    warnings.push(`token budget at ${Math.round(usedTokens / execution.policy.maxTokens * 100)}%`);
  }
  const failures = new Map<string, number>();
  for (const activation of execution.activations) {
    if (activation.status === "failed") failures.set(activation.nodeId, (failures.get(activation.nodeId) ?? 0) + 1);
  }
  for (const [nodeId, count] of failures) {
    if (count >= 2) warnings.push(`${execution.nodes.find((node) => node.id === nodeId)?.label ?? nodeId} failed ${count} times`);
  }
  const latestByNode = latestActivations(execution);
  for (const nodeId of verifierNodes) {
    const activation = latestByNode.get(nodeId);
    if (activation?.status === "waiting" && elapsedMs(activation.startedAt) >= STALLED_NODE_MS) {
      warnings.push(`${execution.nodes.find((node) => node.id === nodeId)?.label ?? nodeId} verifier appears stalled`);
    }
    if (activation?.status === "failed") {
      const recovered = execution.traversals.some((traversal) =>
        traversal.from === nodeId
        && traversal.iteration === activation.iteration
        && traversal.at >= (activation.completedAt ?? activation.startedAt),
      );
      if (!recovered) warnings.push(`${execution.nodes.find((node) => node.id === nodeId)?.label ?? nodeId} failed without a selected recovery path`);
    }
  }
  for (const node of execution.nodes) {
    const incoming = execution.edges.filter((edge) => edge.to === node.id);
    const activation = latestByNode.get(node.id);
    if (incoming.length < 2 || activation?.status !== "waiting") continue;
    const blockedBy = incoming
      .map((edge) => latestByNode.get(edge.from))
      .filter((candidate) => candidate?.status === "failed" || candidate?.status === "stopped");
    if (blockedBy.length) warnings.push(`${node.label} join is blocked by ${blockedBy.length} failed or stopped predecessor${blockedBy.length === 1 ? "" : "s"}`);
  }
  const workers = participants.filter((agent) => agent.parentThreadId);
  if (workers.length >= 4) warnings.push(`fan-out: ${workers.length} subagents`);
  const activeWorkers = workers.filter((agent) => agent.activeTurnId).length;
  if (activeWorkers >= 3) warnings.push(`${activeWorkers} subagents active concurrently`);
  addConfigurationWarnings(warnings, workers);
  addDuplicateAssignmentWarnings(warnings, workers);
  return [...new Set(warnings)];
}

function executionIncompleteReason(
  execution: ExecutionGraphState,
  agents: AgentState[],
): string | undefined {
  if (["completed", "failed", "stopped", "blocked"].includes(execution.status)) return undefined;
  const byId = new Map(agents.map((agent) => [agent.threadId, agent]));
  const owner = byId.get(execution.ownerThreadId);
  const ownerActive = Boolean(owner?.activeTurnId);
  const liveStatuses = new Set(["queued", "running", "waiting"]);
  const activeActivations = execution.activations.filter((activation) => liveStatuses.has(activation.status));
  const associatedAgentActive = activeActivations.some((activation) =>
    activation.threadIds.some((threadId) => Boolean(byId.get(threadId)?.activeTurnId)),
  );
  if (ownerActive || associatedAgentActive || !owner?.lastTurnCompletedAt) return undefined;

  const abandoned = activeActivations.filter((activation) => activation.status !== "waiting");
  if (abandoned.length) {
    const labels = [...new Set(abandoned.map((activation) =>
      execution.nodes.find((node) => node.id === activation.nodeId)?.label ?? activation.nodeId,
    ))];
    return `Instrumentation incomplete: ${labels.join(", ")} never reported completion after associated work ended`;
  }

  const terminalPassed = execution.activations.some((activation) =>
    execution.terminalNodeIds.includes(activation.nodeId) && activation.status === "passed",
  );
  if (terminalPassed) {
    return "Instrumentation incomplete: a terminal node passed, but execution completion was not reported";
  }
  if (execution.status === "running" && execution.startedAt) {
    return "Instrumentation incomplete: execution is marked running with no associated work active";
  }
  return undefined;
}

function loopWarnings(loop: LoopState, agents: AgentState[]): string[] {
  const descendants = agents.filter((agent) => belongsTo(loop.threadId, agent, agents));
  const warnings: string[] = [];
  const usedTokens = loopTokenUse(loop.threadId, agents);
  if (!loop.verifier && loop.iteration >= 2) warnings.push("no verifier declared");
  if (loop.iteration >= 2 && loop.evidence.length === 0) warnings.push("no evidence collected across iterations");
  if (loop.budget.maxIterations && loop.iteration >= loop.budget.maxIterations) warnings.push(`iteration budget reached: ${loop.iteration}/${loop.budget.maxIterations}`);
  if (loop.budget.maxTokens && usedTokens >= loop.budget.maxTokens) warnings.push(`token budget exceeded: ${usedTokens}/${loop.budget.maxTokens}`);
  else if (loop.budget.maxTokens && usedTokens >= loop.budget.maxTokens * .8) warnings.push(`token budget at ${Math.round(usedTokens / loop.budget.maxTokens * 100)}%`);
  if (descendants.length >= 4) warnings.push(`fan-out: ${descendants.length} subagents`);
  const active = descendants.filter((agent) => agent.activeTurnId).length;
  if (active >= 3) warnings.push(`${active} subagents active concurrently`);
  addConfigurationWarnings(warnings, descendants);
  addDuplicateAssignmentWarnings(warnings, descendants);
  return warnings;
}

function loopTokenUse(rootThreadId: string, agents: AgentState[]): number {
  return agents.filter((agent) => agent.threadId === rootThreadId || belongsTo(rootThreadId, agent, agents)).reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0);
}

function executionTokenUse(
  execution: ExecutionGraphState,
  agents: AgentState[],
  executions: ExecutionGraphState[],
): number {
  return executionAgents(execution, agents, executions).reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0);
}

function executionAgents(
  execution: ExecutionGraphState,
  agents: AgentState[],
  executions: ExecutionGraphState[],
): AgentState[] {
  const executionIds = new Set([execution.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of executions) {
      if (candidate.parentExecutionId && executionIds.has(candidate.parentExecutionId) && !executionIds.has(candidate.id)) {
        executionIds.add(candidate.id);
        grew = true;
      }
    }
  }
  const ids = new Set<string>();
  for (const candidate of executions) {
    if (!executionIds.has(candidate.id)) continue;
    ids.add(candidate.ownerThreadId);
    for (const activation of candidate.activations) {
      for (const threadId of activation.threadIds) ids.add(threadId);
    }
  }
  for (const agent of agents) {
    if (agent.execution && executionIds.has(agent.execution.executionId)) ids.add(agent.threadId);
  }
  return agents.filter((agent) => ids.has(agent.threadId));
}

function latestActivations(execution: ExecutionGraphState): Map<string, NodeActivation> {
  const latest = new Map<string, NodeActivation>();
  for (const activation of execution.activations) latest.set(activation.nodeId, activation);
  return latest;
}

function elapsedMs(timestamp: string): number {
  const startedAt = Date.parse(timestamp);
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
}

function addConfigurationWarnings(warnings: string[], agents: AgentState[]): void {
  for (const agent of agents) {
    if (agent.requested?.model && agent.effective?.model && agent.requested.model !== agent.effective.model) warnings.push(`${agent.nickname ?? agent.threadId.slice(0, 8)} model differs from request`);
    if (agent.requested?.effort && agent.effective?.effort && agent.requested.effort !== agent.effective.effort) warnings.push(`${agent.nickname ?? agent.threadId.slice(0, 8)} effort differs from request`);
  }
}

function addDuplicateAssignmentWarnings(warnings: string[], agents: AgentState[]): void {
  const assignments = new Map<string, AgentState[]>();
  for (const agent of agents) {
    const prompt = normalizeAssignment(agent.requested?.prompt);
    if (prompt) assignments.set(prompt, [...(assignments.get(prompt) ?? []), agent]);
  }
  for (const duplicates of assignments.values()) {
    if (duplicates.length >= 2) warnings.push(`duplicate assignment across ${duplicates.length} subagents`);
  }
}

const STALLED_NODE_MS = 120_000;

function normalizeAssignment(value?: string): string | undefined {
  const normalized = value?.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
  return normalized && normalized.length >= 12 ? normalized.slice(0, 180) : undefined;
}

function belongsTo(rootThreadId: string, agent: AgentState, agents: AgentState[]): boolean {
  let parentId = agent.parentThreadId;
  while (parentId) {
    if (parentId === rootThreadId) return true;
    parentId = agents.find((candidate) => candidate.threadId === parentId)?.parentThreadId;
  }
  return false;
}
