import { EventEmitter } from "node:events";
import { type CodexAppServerClient, type JsonObject } from "./protocol.js";

export type WatchdogEvent =
  | { type: "thread.started"; threadId: string; parentThreadId?: string; nickname?: string; role?: string }
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
  | { type: "tokens.updated"; threadId: string; totalTokens?: number; outputTokens?: number }
  | { type: "loop.configured"; threadId: string; objective?: string; verifier?: string; maxTokens?: number; maxIterations?: number }
  | { type: "evidence.collected"; threadId: string; itemId?: string; summary: string; source: string }
  | { type: "loop.verified"; threadId: string; status: "passed" | "failed"; summary?: string };

export class CodexEventNormalizer extends EventEmitter {
  #hydrating = new Set<string>();
  #requestedKnown = new Set<string>();
  #seenItems = new Set<string>();
  #knownThreads = new Set<string>();

  constructor(private readonly client: CodexAppServerClient) {
    super();
    client.on("notification", (method: string, params: JsonObject) => this.#onNotification(method, params));
  }

  #onNotification(method: string, params: JsonObject): void {
    if (method === "item/agentMessage/delta") {
      const threadId = text(params.threadId);
      const itemId = text(params.itemId);
      const delta = text(params.delta);
      if (threadId && itemId && delta) {
        this.emit("event", { type: "agent.message.delta", threadId, itemId, delta, at: new Date().toISOString() } satisfies WatchdogEvent);
      }
      return;
    }
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
        if (method === "turn/started") void this.#observeTurnInput(threadId, turnId);
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
      if (summary) this.emit("event", { type: "agent.message", threadId: parentThreadId, itemId, message: summary, at: new Date().toISOString() } satisfies WatchdogEvent);
    }
    const activity = itemActivity(item, lifecycle);
    if (parentThreadId && activity) {
      this.emit("event", { type: "agent.activity", threadId: parentThreadId, ...activity } satisfies WatchdogEvent);
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
          this.#requestedKnown.add(agentThreadId);
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
      if (parentThreadId) void this.#observeRequestedConfig(parentThreadId, threadId);
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

  async #observeRequestedConfig(parentThreadId: string, childThreadId: string): Promise<void> {
    if (this.#requestedKnown.has(childThreadId)) return;
    for (const delayMs of [0, 100, 400]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const result = await this.client.request<JsonObject>("thread/read", { threadId: parentThreadId, includeTurns: true });
        const turns = array(object(result.thread).turns);
        const items = turns.flatMap((turn) => array(object(turn).items));
        const call = [...items].reverse().map(object).find((item) =>
          text(item.type) === "collabAgentToolCall" && strings(item.receiverThreadIds).includes(childThreadId));
        if (!call) continue;
        this.emit("event", {
          type: "agent.requestedConfig",
          parentThreadId,
          agentThreadId: childThreadId,
          prompt: text(call.prompt),
          model: text(call.model),
          reasoningEffort: text(call.reasoningEffort),
        } satisfies WatchdogEvent);
        this.#requestedKnown.add(childThreadId);
        return;
      } catch {
        // The parent turn can still be persisting while its child is starting.
      }
    }
  }

  async #observeTurnInput(threadId: string, turnId: string): Promise<void> {
    // The turn-start notification can arrive slightly before its persisted input.
    // A tiny bounded retry keeps the generic task visible without blocking the stream.
    for (const delayMs of [0, 100, 400]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const result = await this.client.request<JsonObject>("thread/read", { threadId, includeTurns: true });
        const turns: unknown[] = Array.isArray(object(result.thread).turns) ? object(result.thread).turns as unknown[] : [];
        const turn = turns.find((value) => text(object(value).id) === turnId);
        const items: unknown[] = Array.isArray(object(turn).items) ? object(turn).items as unknown[] : [];
        const message = items.find((value) => text(object(value).type) === "userMessage");
        const content: unknown[] = Array.isArray(object(message).content) ? object(message).content as unknown[] : [];
        const input = content.map((value) => text(object(value).text)).filter((value): value is string => Boolean(value)).join("\n").trim();
        if (input) {
          this.emit("event", { type: "turn.input", threadId, turnId, input } satisfies WatchdogEvent);
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
        void this.#observeTurnInput(threadId, turnId);
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
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function itemText(item: JsonObject): string | undefined {
  const direct = text(item.text);
  if (direct) return direct;
  const content = Array.isArray(item.content) ? item.content : [];
  const joined = content.map((value) => typeof value === "string" ? value : text(object(value).text)).filter((value): value is string => Boolean(value)).join("\n").trim();
  return joined || undefined;
}
function itemActivity(item: JsonObject, lifecycle: "started" | "completed"): { tool: string; status: string } | undefined {
  const type = text(item.type);
  const status = text(item.status) ?? (lifecycle === "started" ? "inProgress" : "completed");
  if (type === "commandExecution") return { tool: `command · ${truncate(text(item.command) ?? "shell")}`, status };
  if (type === "fileChange") return { tool: `file change · ${array(item.changes).length || "?"} files`, status };
  if (type === "mcpToolCall") return { tool: `MCP · ${[text(item.server), text(item.tool)].filter(Boolean).join("/") || "tool"}`, status };
  if (type === "dynamicToolCall") return { tool: [text(item.namespace), text(item.tool)].filter(Boolean).join("/") || "tool", status };
  if (type === "webSearch") return { tool: `web search · ${truncate(text(item.query) ?? "query")}`, status };
  if (type === "imageView") return { tool: `view image · ${truncate(text(item.path) ?? "image")}`, status };
  if (type === "imageGeneration") return { tool: "generate image", status };
  if (type === "sleep") return { tool: `sleep · ${Math.round((numeric(item.durationMs) ?? 0) / 1_000)}s`, status };
  if (type === "plan") return { tool: "update plan", status };
  if (type === "reasoning") return { tool: "reasoning", status };
  return undefined;
}
function truncate(value: string): string { return value.length > 90 ? `${value.slice(0, 87)}…` : value; }
