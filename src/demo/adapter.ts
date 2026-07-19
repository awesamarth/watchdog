import type { AdapterEventListener, AdapterTarget, AgentCapabilities, HarnessAdapter, RetryOptions } from "../adapters/types.js";
import { available, unavailable } from "../adapters/types.js";
import type { WatchdogEvent } from "../adapters/events.js";
import { adapterSnapshot } from "../runtime/adapter.js";
import { RuntimeState } from "../runtime/state.js";

const CHILD_STEER_REASON = "The demo mirrors Codex native-child limits: stop the child, then steer or retry the root.";

export class WatchdogDemoAdapter implements HarnessAdapter {
  readonly descriptor = { harness: "watchdog-demo", transport: "simulation", mode: "live", label: "Watchdog deterministic simulation" } as const;
  #listeners = new Set<AdapterEventListener>();
  #turn = 3;

  constructor(private readonly state: RuntimeState) {}

  onEvent(listener: AdapterEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    for (const event of demoEvents()) this.#emit(event);
  }

  async stop(): Promise<void> { this.#listeners.clear(); }

  capabilities(target: AdapterTarget): AgentCapabilities {
    const active = Boolean(target.activeTurnId);
    if (target.parentThreadId) return {
      observe: available(),
      steer: unavailable(CHILD_STEER_REASON),
      followUp: unavailable(CHILD_STEER_REASON),
      interrupt: active ? available() : unavailable("This simulated child is no longer running."),
      retry: unavailable(CHILD_STEER_REASON),
      modelOverride: unavailable(CHILD_STEER_REASON),
    };
    return {
      observe: available(),
      steer: active ? available() : unavailable("The simulated root has no active turn to steer."),
      followUp: unavailable("The deterministic demo does not model a separate follow-up queue."),
      interrupt: active ? available() : unavailable("The simulated root has no active turn to stop."),
      retry: available(),
      modelOverride: available(),
    };
  }

  async steer(target: AdapterTarget, message: string): Promise<unknown> {
    if (target.parentThreadId) throw new Error(CHILD_STEER_REASON);
    this.#emit({ type: "agent.activity", threadId: target.threadId, tool: "operator steer", status: "completed" });
    this.#emit({ type: "evidence.collected", threadId: target.threadId, summary: `Operator steering received: ${message}`, source: "Watchdog demo" });
    return { steered: agentLabel(target), message };
  }
  async followUp(): Promise<unknown> { throw new Error("The deterministic demo does not model a separate follow-up queue."); }

  async interrupt(target: AdapterTarget): Promise<unknown> {
    if (!target.activeTurnId) throw new Error(`${agentLabel(target)} has no active turn to interrupt`);
    this.#emit({ type: "turn.completed", threadId: target.threadId, turnId: target.activeTurnId });
    this.#emit({ type: "thread.status", threadId: target.threadId, status: "interrupted" });
    this.#emit({ type: "agent.activity", threadId: target.threadId, tool: "operator stop", status: "completed" });
    if (!target.parentThreadId) return { stopped: agentLabel(target), parentNotified: false };

    const agent = this.state.resolve(target.threadId);
    if (agent.requested?.prompt) this.#emit({
      type: "agent.requestedConfig",
      parentThreadId: target.parentThreadId,
      agentThreadId: target.threadId,
      prompt: `Stopped by Watchdog: ${agent.requested.prompt}`,
      model: agent.requested.model,
      reasoningEffort: agent.requested.effort,
    });
    const root = this.state.rootFor(target.threadId);
    this.#emit({ type: "agent.activity", threadId: root.threadId, tool: "re-plan after Watchdog stop", status: "inProgress" });
    this.#emit({ type: "evidence.collected", threadId: root.threadId, summary: `${agentLabel(target)} stopped; duplicate work removed and parent re-planning`, source: "Watchdog intervention" });
    return { stopped: agentLabel(target), parentNotified: true, notificationTarget: agentLabel(root) };
  }

  async retry(target: AdapterTarget, options: RetryOptions): Promise<unknown> {
    if (target.parentThreadId) throw new Error(CHILD_STEER_REASON);
    if (target.activeTurnId) this.#emit({ type: "turn.completed", threadId: target.threadId, turnId: target.activeTurnId });
    if (options.model || options.effort) this.#emit({
      type: "agent.effectiveConfig",
      threadId: target.threadId,
      model: options.model ?? this.state.resolve(target.threadId).effective?.model,
      reasoningEffort: options.effort ?? this.state.resolve(target.threadId).effective?.effort,
    });
    const turnId = `demo-root-turn-${++this.#turn}`;
    this.#emit({ type: "turn.started", threadId: target.threadId, turnId });
    this.#emit({ type: "loop.objective", threadId: target.threadId, turnId, objective: options.message });
    this.#emit({ type: "agent.activity", threadId: target.threadId, tool: "retry with operator overrides", status: "inProgress", model: options.model, reasoningEffort: options.effort });
    return { retried: agentLabel(target), turnId, model: options.model, effort: options.effort };
  }

  #emit(event: WatchdogEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

export function createDemoSnapshot() {
  const state = new RuntimeState();
  const adapter = new WatchdogDemoAdapter(state);
  for (const event of demoEvents()) state.apply(event);
  return adapterSnapshot(adapter, state);
}

function demoEvents(): WatchdogEvent[] {
  const root = "demo-root";
  const duplicatePrompt = "Inspect checkout callback ordering and return one reproducible race with evidence.";
  return [
    { type: "thread.started", threadId: root, nickname: "Root", role: "orchestrator" },
    {
      type: "execution.declared",
      graph: {
        id: "demo-checkout",
        ownerThreadId: root,
        label: "Checkout repair",
        objective: "Repair the flaky checkout flow and prove the fix",
        source: { kind: "harness", label: "Deterministic demo workflow" },
        authority: "authoritative",
        nodes: [
          { id: "reproduce", label: "REPRODUCE", kind: "stage" },
          { id: "repair", label: "REPAIR", kind: "subgraph", subgraphId: "demo-repair" },
          { id: "soak", label: "SOAK TEST", kind: "verifier" },
          { id: "done", label: "DONE", kind: "terminal" },
        ],
        edges: [
          { id: "reproduce-repair", from: "reproduce", to: "repair", kind: "normal" },
          { id: "repair-soak", from: "repair", to: "soak", kind: "normal" },
          { id: "soak-repair", from: "soak", to: "repair", kind: "loop-back", condition: "checkout still flakes" },
          { id: "soak-done", from: "soak", to: "done", kind: "success", condition: "20 clean runs" },
        ],
        entryNodeIds: ["reproduce"],
        terminalNodeIds: ["done"],
      },
    },
    { type: "execution.iteration.started", executionId: "demo-checkout", iteration: 3 },
    { type: "execution.node.started", executionId: "demo-checkout", nodeId: "repair", activationId: "demo-repair-active", threadId: root, iteration: 3 },
    { type: "agent.effectiveConfig", threadId: root, model: "gpt-5.6-terra", reasoningEffort: "medium" },
    { type: "turn.started", threadId: root, turnId: "demo-root-turn-1" },
    { type: "loop.objective", threadId: root, turnId: "demo-root-turn-1", objective: "Repair the flaky checkout flow and prove the fix" },
    { type: "loop.configured", threadId: root, verifier: "20 clean checkout runs and the regression suite passes", maxTokens: 125_000, maxIterations: 4 },
    { type: "turn.completed", threadId: root, turnId: "demo-root-turn-1" },
    { type: "turn.started", threadId: root, turnId: "demo-root-turn-2" },
    { type: "turn.completed", threadId: root, turnId: "demo-root-turn-2" },
    { type: "turn.started", threadId: root, turnId: "demo-root-turn-3" },
    { type: "tokens.updated", threadId: root, totalTokens: 42_000, outputTokens: 3_100 },
    { type: "agent.activity", threadId: root, tool: "wait for delegated evidence", status: "inProgress" },

    ...childEvents(root, "demo-locke", "Locke", "investigator", "demo-locke-turn", duplicatePrompt, "gpt-5.6-luna", "low", "gpt-5.6-luna", "low", 18_000, "trace callbacks"),
    {
      type: "execution.declared",
      graph: {
        id: "demo-repair",
        ownerThreadId: "demo-locke",
        label: "Repair yard",
        objective: "Trace the mutation, patch it, and prove the regression",
        source: { kind: "harness", label: "Deterministic nested workflow" },
        authority: "authoritative",
        parentExecutionId: "demo-checkout",
        parentNodeId: "repair",
        nodes: [
          { id: "trace", label: "TRACE", kind: "stage" },
          { id: "patch", label: "PATCH", kind: "action" },
          { id: "regression", label: "REGRESSION", kind: "verifier" },
          { id: "ready", label: "READY", kind: "terminal" },
        ],
        edges: [
          { id: "trace-patch", from: "trace", to: "patch", kind: "normal" },
          { id: "patch-regression", from: "patch", to: "regression", kind: "normal" },
          { id: "regression-patch", from: "regression", to: "patch", kind: "loop-back", condition: "regression fails" },
          { id: "regression-ready", from: "regression", to: "ready", kind: "success", condition: "regression passes" },
        ],
        entryNodeIds: ["trace"],
        terminalNodeIds: ["ready"],
      },
    },
    { type: "execution.iteration.started", executionId: "demo-repair", iteration: 2 },
    { type: "execution.node.started", executionId: "demo-repair", nodeId: "regression", activationId: "demo-regression-active", threadId: "demo-locke", iteration: 2 },
    ...childEvents(root, "demo-mirror", "Mirror", "investigator", "demo-mirror-turn", duplicatePrompt, "gpt-5.6-luna", "low", "gpt-5.6-luna", "low", 15_500, "trace callbacks"),
    ...childEvents(root, "demo-kepler", "Kepler", "verifier", "demo-kepler-turn", "Run the checkout verifier and report only reproducible evidence.", "gpt-5.6-luna", "low", "gpt-5.6-terra", "high", 27_500, "test checkout"),
    ...childEvents(root, "demo-hopper", "Hopper", "reviewer", undefined, "Review gathered evidence and flag unsupported claims.", undefined, undefined, "gpt-5.6-luna", "low", 9_000, "blocked on evidence"),
    { type: "thread.status", threadId: "demo-hopper", status: "blocked" },
    { type: "evidence.collected", threadId: "demo-locke", itemId: "demo-evidence-race", summary: "Race reproduced when two payment callbacks overlap before commit", source: "Locke" },
  ];
}

function childEvents(
  parentThreadId: string,
  threadId: string,
  nickname: string,
  role: string,
  turnId: string | undefined,
  prompt: string,
  requestedModel: string | undefined,
  requestedEffort: string | undefined,
  effectiveModel: string,
  effectiveEffort: string,
  tokens: number,
  tool: string,
): WatchdogEvent[] {
  const events: WatchdogEvent[] = [
    { type: "thread.started", threadId, parentThreadId, nickname, role },
    { type: "agent.spawned", parentThreadId, agentThreadId: threadId, agentPath: `/root/${nickname.toLowerCase()}`, state: turnId ? "started" : "blocked" },
    { type: "agent.requestedConfig", parentThreadId, agentThreadId: threadId, prompt, model: requestedModel, reasoningEffort: requestedEffort },
    { type: "agent.effectiveConfig", threadId, model: effectiveModel, reasoningEffort: effectiveEffort },
    { type: "tokens.updated", threadId, totalTokens: tokens, outputTokens: Math.round(tokens * .08) },
    { type: "agent.activity", threadId, tool, status: turnId ? "inProgress" : "blocked" },
    { type: "agent.message", threadId, itemId: `${threadId}-note`, message: turnId ? `${nickname} started the assignment and is gathering evidence.` : `${nickname} cannot start until upstream evidence arrives.` },
    { type: "agent.message", threadId, itemId: `${threadId}-report`, message: turnId ? `${nickname} is ${tool}; latest findings are being checked before reporting.` : `${nickname} is blocked waiting for upstream evidence.` },
  ];
  if (turnId) events.push(
    { type: "turn.started", threadId, turnId },
    { type: "agent.message.delta", threadId, itemId: `${threadId}-live`, delta: "Preparing the next verified update…" },
  );
  return events;
}

function agentLabel(agent: { nickname?: string; agentPath?: string; threadId: string }): string {
  return agent.nickname ?? agent.agentPath ?? agent.threadId.slice(0, 8);
}
