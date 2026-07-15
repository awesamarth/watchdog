import { EventEmitter } from "node:events";
import { type CodexAppServerClient, type JsonObject } from "./protocol.js";

export type WatchdogEvent =
  | { type: "thread.started"; threadId: string; parentThreadId?: string; nickname?: string; role?: string }
  | { type: "thread.status"; threadId: string; status: string }
  | { type: "turn.started" | "turn.completed"; threadId: string; turnId: string }
  | { type: "loop.objective"; threadId: string; turnId: string; objective: string }
  | { type: "agent.spawned"; parentThreadId: string; agentThreadId: string; agentPath?: string; state: string }
  | { type: "agent.identity"; threadId: string; nickname?: string; role?: string; parentThreadId?: string }
  | { type: "agent.activity"; threadId: string; tool: string; status: string; model?: string; reasoningEffort?: string }
  | { type: "agent.requestedConfig"; parentThreadId: string; agentThreadId: string; prompt?: string; model?: string; reasoningEffort?: string }
  | { type: "agent.effectiveConfig"; threadId: string; model?: string; reasoningEffort?: string }
  | { type: "tokens.updated"; threadId: string; totalTokens?: number; outputTokens?: number }
  | { type: "loop.configured"; threadId: string; objective?: string; verifier?: string; maxTokens?: number; maxIterations?: number }
  | { type: "evidence.collected"; threadId: string; itemId?: string; summary: string; source: string }
  | { type: "loop.verified"; threadId: string; status: "passed" | "failed"; summary?: string };

export class CodexEventNormalizer extends EventEmitter {
  #hydrating = new Set<string>();
  #seenItems = new Set<string>();
  #knownThreads = new Set<string>();

  constructor(private readonly client: CodexAppServerClient) {
    super();
    client.on("notification", (method: string, params: JsonObject) => this.#onNotification(method, params));
  }

  #onNotification(method: string, params: JsonObject): void {
    if (method === "thread/started") {
      const thread = object(params.thread);
      const threadId = text(thread.id);
      if (threadId) this.#announceThread(threadId, text(thread.parentThreadId), text(thread.agentNickname), text(thread.agentRole));
      return;
    }
    if (method === "thread/status/changed") {
      const threadId = text(params.threadId);
      const status = text(object(params.status).type);
      if (threadId && status) {
        void this.#observeThread(threadId);
        if (status === "active") void this.#observeActiveTurn(threadId);
        this.emit("event", { type: "thread.status", threadId, status } satisfies WatchdogEvent);
      }
      return;
    }
    if (method === "turn/started" || method === "turn/completed") {
      const threadId = text(params.threadId);
      const turnId = text(object(params.turn).id);
      if (threadId && turnId) {
        this.emit("event", { type: method === "turn/started" ? "turn.started" : "turn.completed", threadId, turnId } satisfies WatchdogEvent);
        if (method === "turn/started") void this.#observeObjective(threadId, turnId);
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const threadId = text(params.threadId);
      const total = object(object(params.tokenUsage).total);
      if (threadId) this.emit("event", { type: "tokens.updated", threadId, totalTokens: numeric(total.totalTokens), outputTokens: numeric(total.outputTokens) } satisfies WatchdogEvent);
      return;
    }
    if (method === "item/started" || method === "item/completed") this.#onItem(object(params.item), text(params.threadId), method === "item/completed" ? "completed" : "started");
  }

  #onItem(item: JsonObject, parentThreadId: string | undefined, lifecycle: "started" | "completed"): void {
    const itemId = text(item.id);
    const seenKey = itemId ? `${lifecycle}:${itemId}` : undefined;
    if (seenKey && this.#seenItems.has(seenKey)) return;
    if (seenKey) this.#seenItems.add(seenKey);
    if (lifecycle === "completed" && parentThreadId && text(item.type) === "agentMessage") {
      const summary = itemText(item);
      if (summary) this.emit("event", { type: "evidence.collected", threadId: parentThreadId, itemId, summary, source: "agent message" } satisfies WatchdogEvent);
    }
    if (text(item.type) === "subAgentActivity") {
      // In this protocol notification the enclosing thread is the child and
      // `agentThreadId` can refer back to its parent. Read the thread record
      // instead of guessing edge direction from this activity item.
      if (parentThreadId) void this.#observeThread(parentThreadId);
      return;
    }
    if (text(item.type) === "collabAgentToolCall") {
      const senderThreadId = text(item.senderThreadId) ?? parentThreadId;
      const receivers = strings(item.receiverThreadIds);
      if (senderThreadId && receivers.length) {
        for (const agentThreadId of receivers) {
          this.emit("event", {
            type: "agent.requestedConfig",
            parentThreadId: senderThreadId,
            agentThreadId,
            prompt: text(item.prompt),
            model: text(item.model),
            reasoningEffort: text(item.reasoningEffort),
          } satisfies WatchdogEvent);
          void this.#observeThread(agentThreadId);
        }
      }
      if (senderThreadId && text(item.tool)) {
        this.emit("event", { type: "agent.activity", threadId: senderThreadId, tool: text(item.tool)!, status: text(item.status) ?? "unknown", model: text(item.model), reasoningEffort: text(item.reasoningEffort) } satisfies WatchdogEvent);
      }
    }
  }

  #announceThread(threadId: string, parentThreadId?: string, nickname?: string, role?: string): void {
    const firstSeen = !this.#knownThreads.has(threadId);
    this.#knownThreads.add(threadId);
    if (!firstSeen) return;
    this.emit("event", { type: "thread.started", threadId, parentThreadId, nickname, role } satisfies WatchdogEvent);
    if (parentThreadId) this.emit("event", { type: "agent.spawned", parentThreadId, agentThreadId: threadId, state: "started" } satisfies WatchdogEvent);
  }

  async #observeThread(threadId: string): Promise<void> {
    if (this.#hydrating.has(threadId)) return;
    this.#hydrating.add(threadId);
    try {
      const result = await this.client.request<JsonObject>("thread/read", { threadId, includeTurns: false });
      const thread = object(result.thread);
      const parentThreadId = text(thread.parentThreadId);
      const nickname = text(thread.agentNickname);
      const role = text(thread.agentRole);
      this.#announceThread(threadId, parentThreadId, nickname, role);
      this.emit("event", { type: "agent.identity", threadId, parentThreadId, nickname, role } satisfies WatchdogEvent);
      try {
        const resumed = await this.client.request<JsonObject>("thread/resume", { threadId });
        this.emit("event", { type: "agent.effectiveConfig", threadId, model: text(resumed.model), reasoningEffort: text(resumed.reasoningEffort) } satisfies WatchdogEvent);
      } catch {
        // Reading history remains useful even when the runtime declines a rejoin.
      }
    } catch {
      // Child startup can race its persisted metadata. Its thread id and agent path remain usable.
    } finally {
      this.#hydrating.delete(threadId);
    }
  }

  async #observeObjective(threadId: string, turnId: string): Promise<void> {
    // The turn-start notification can arrive slightly before its persisted input.
    // A tiny bounded retry keeps loop semantics useful without blocking the stream.
    for (const delayMs of [0, 100, 400]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const result = await this.client.request<JsonObject>("thread/read", { threadId, includeTurns: true });
        const turns: unknown[] = Array.isArray(object(result.thread).turns) ? object(result.thread).turns as unknown[] : [];
        const turn = turns.find((value) => text(object(value).id) === turnId);
        const items: unknown[] = Array.isArray(object(turn).items) ? object(turn).items as unknown[] : [];
        const message = items.find((value) => text(object(value).type) === "userMessage");
        const content: unknown[] = Array.isArray(object(message).content) ? object(message).content as unknown[] : [];
        const objective = content.map((value) => text(object(value).text)).filter((value): value is string => Boolean(value)).join("\n").trim();
        if (objective) {
          this.emit("event", { type: "loop.objective", threadId, turnId, objective } satisfies WatchdogEvent);
          return;
        }
      } catch {
        // Loop semantics are additive: a lifecycle event is still useful if history is unavailable.
      }
    }
  }

  async #observeActiveTurn(threadId: string): Promise<void> {
    try {
      const result = await this.client.request<JsonObject>("thread/read", { threadId, includeTurns: true });
      const turns: unknown[] = Array.isArray(object(result.thread).turns) ? object(result.thread).turns as unknown[] : [];
      const active = [...turns].reverse().find((turn) => text(object(turn).status) === "inProgress");
      const turnId = text(object(active).id);
      if (turnId) {
        this.emit("event", { type: "turn.started", threadId, turnId } satisfies WatchdogEvent);
        void this.#observeObjective(threadId, turnId);
      }
    } catch {
      // Some status changes race history persistence; the normal notification still handles most turns.
    }
  }
}

function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function numeric(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function itemText(item: JsonObject): string | undefined {
  const direct = text(item.text);
  if (direct) return direct.slice(0, 500);
  const content = Array.isArray(item.content) ? item.content : [];
  const joined = content.map((value) => typeof value === "string" ? value : text(object(value).text)).filter((value): value is string => Boolean(value)).join("\n").trim();
  return joined ? joined.slice(0, 500) : undefined;
}
