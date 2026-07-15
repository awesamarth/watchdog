import { EventEmitter } from "node:events";
import type { AdapterDescriptor, AgentCapabilities } from "../adapters/types.js";
import type { WatchdogEvent } from "../codex/normalizer.js";

export type AgentConfig = { model?: string; effort?: string };

export type AgentState = {
  threadId: string;
  parentThreadId?: string;
  nickname?: string;
  role?: string;
  agentPath?: string;
  status: string;
  activeTurnId?: string;
  totalTokens?: number;
  outputTokens?: number;
  requested?: AgentConfig & { prompt?: string };
  effective?: AgentConfig;
  latestActivity?: { tool: string; status: string };
  startedAt?: string;
  lastActivityAt?: string;
};

export type RunSnapshot = {
  startedAt: string;
  mode: "live" | "observed";
  agents: AgentState[];
  loops: LoopState[];
  adapter?: AdapterDescriptor;
  capabilities?: Record<string, AgentCapabilities>;
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
  readonly startedAt = new Date().toISOString();

  constructor(readonly mode: "live" | "observed" = "live") { super(); }

  apply(event: WatchdogEvent): void {
    switch (event.type) {
      case "thread.started": {
        const agent = this.#ensure(event.threadId);
        agent.parentThreadId = event.parentThreadId ?? agent.parentThreadId;
        agent.nickname = event.nickname ?? agent.nickname;
        agent.role = event.role ?? agent.role;
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
        if (!agent.parentThreadId || this.#loops.has(event.threadId)) {
          const loop = this.#loop(event.threadId);
          loop.iteration += 1;
          loop.activeTurnId = event.turnId;
          loop.phase = "execute";
        }
        break;
      }
      case "turn.completed": {
        const agent = this.#ensure(event.threadId);
        if (agent.activeTurnId === event.turnId) agent.activeTurnId = undefined;
        agent.lastActivityAt = new Date().toISOString();
        const loop = this.#loops.get(event.threadId);
        if (loop?.activeTurnId === event.turnId) {
          loop.activeTurnId = undefined;
          if (loop.verification.status !== "passed") loop.phase = "verify";
        }
        break;
      }
      case "loop.objective": {
        const agent = this.#ensure(event.threadId);
        if (!agent.parentThreadId) this.#loop(event.threadId).objective = event.objective;
        break;
      }
      case "agent.spawned": {
        const agent = this.#ensure(event.agentThreadId);
        agent.parentThreadId = event.parentThreadId;
        agent.agentPath = event.agentPath ?? agent.agentPath;
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
        agent.latestActivity = { tool: event.tool, status: event.status };
        agent.lastActivityAt = new Date().toISOString();
        break;
      }
      case "agent.requestedConfig": {
        const agent = this.#ensure(event.agentThreadId);
        agent.parentThreadId = event.parentThreadId;
        agent.requested = { model: event.model, effort: event.reasoningEffort, prompt: event.prompt };
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
        agent.outputTokens = event.outputTokens ?? agent.outputTokens;
        break;
      }
      case "loop.configured": {
        const loop = this.#loop(event.threadId);
        loop.objective = event.objective ?? loop.objective;
        loop.verifier = event.verifier ?? loop.verifier;
        loop.budget.maxTokens = event.maxTokens ?? loop.budget.maxTokens;
        loop.budget.maxIterations = event.maxIterations ?? loop.budget.maxIterations;
        if (loop.phase === "plan" && loop.activeTurnId) loop.phase = "execute";
        break;
      }
      case "evidence.collected": {
        const loop = this.#owningLoop(event.threadId);
        if (!loop) break;
        const id = event.itemId ?? `${event.threadId}:${loop.iteration}:${event.summary}`;
        if (!loop.evidence.some((item) => item.id === id)) loop.evidence.push({
          id,
          iteration: loop.iteration,
          summary: event.summary,
          source: event.source,
          agentThreadId: event.threadId,
          at: new Date().toISOString(),
        });
        break;
      }
      case "loop.verified": {
        const loop = this.#loop(event.threadId);
        loop.verification = { status: event.status, summary: event.summary, at: new Date().toISOString() };
        loop.phase = event.status === "passed" ? "done" : "blocked";
        break;
      }
    }
    this.emit("changed", this.snapshot());
  }

  snapshot(): RunSnapshot {
    const agents = [...this.#agents.values()];
    return { startedAt: this.startedAt, mode: this.mode, agents, loops: [...this.#loops.values()].map((loop) => ({
      ...loop,
      evidence: [...loop.evidence],
      budget: { ...loop.budget, usedTokens: loopTokenUse(loop.threadId, agents) },
      warnings: loopWarnings(loop, agents),
    })) };
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
      agent = { threadId, status: "unknown" };
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
  for (const agent of descendants) {
    if (agent.requested?.model && agent.effective?.model && agent.requested.model !== agent.effective.model) warnings.push(`${agent.nickname ?? agent.threadId.slice(0, 8)} model differs from request`);
    if (agent.requested?.effort && agent.effective?.effort && agent.requested.effort !== agent.effective.effort) warnings.push(`${agent.nickname ?? agent.threadId.slice(0, 8)} effort differs from request`);
  }
  const assignments = new Map<string, AgentState[]>();
  for (const agent of descendants) {
    const prompt = normalizeAssignment(agent.requested?.prompt);
    if (prompt) assignments.set(prompt, [...(assignments.get(prompt) ?? []), agent]);
  }
  for (const duplicates of assignments.values()) if (duplicates.length >= 2) warnings.push(`duplicate assignment across ${duplicates.length} subagents`);
  return warnings;
}

function loopTokenUse(rootThreadId: string, agents: AgentState[]): number {
  return agents.filter((agent) => agent.threadId === rootThreadId || belongsTo(rootThreadId, agent, agents)).reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0);
}

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
