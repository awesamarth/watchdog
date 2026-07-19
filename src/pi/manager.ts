import { randomUUID } from "node:crypto";
import type { WatchdogEvent } from "../adapters/events.js";
import type { RunSnapshot } from "../runtime/state.js";
import { executePiExecutionOperation, type PiExecutionOperation } from "./execution.js";
import { PiRpcClient, type PiRpcClientOptions, type PiRpcEvent, type PiRpcState, type PiThinkingLevel } from "./rpc.js";

export type PiSubagentTask = {
  task: string;
  name?: string;
  role?: string;
  model?: string;
  thinking?: PiThinkingLevel;
  tools?: string[];
  cwd?: string;
  timeoutSeconds?: number;
  allowDelegation?: boolean;
  maxChildren?: number;
  maxDepth?: number;
};

export type PiSubagentOperation =
  | { action: "spawn"; tasks: PiSubagentTask[] }
  | { action: "list" }
  | { action: "steer"; agent: string; message: string }
  | { action: "follow_up"; agent: string; message: string }
  | { action: "stop"; agent: string }
  | { action: "retry"; agent: string; message?: string; model?: string; thinking?: PiThinkingLevel };

export type PiWorkerStatus = "queued" | "starting" | "working" | "waiting" | "idle" | "stopped" | "failed";

export type PiWorkerView = {
  id: string;
  parentId: string;
  name: string;
  role: string;
  task: string;
  cwd: string;
  status: PiWorkerStatus;
  model?: string;
  thinking?: PiThinkingLevel;
  totalTokens: number;
  outputTokens: number;
  costUsd: number;
  latestMessage?: string;
  error?: string;
  delegation?: {
    maxChildren: number;
    spawnedChildren: number;
    maxDepth: number;
  };
};

type PiWorker = PiWorkerView & {
  client?: PiRpcClient;
  requestedModel?: string;
  requestedThinking?: PiThinkingLevel;
  tools?: string[];
  allowDelegation: boolean;
  maxChildren: number;
  maxDepth: number;
  spawnedChildren: number;
  coordinatorToken: string;
  timeoutMs: number;
  turn: number;
  hasPermit: boolean;
  stopRequested: boolean;
  messageSequence: number;
  currentMessageId?: string;
  operationTail: Promise<void>;
};

export type PiWorkerManagerOptions = {
  rootId: string;
  cwd: string;
  extensionPath: string;
  coordinatorSocket: string;
  emit(event: WatchdogEvent): void;
  onChanged?(): void;
  snapshot?(): RunSnapshot;
  piBin?: string;
  maxWorkers?: number;
  maxConcurrent?: number;
  maxDepth?: number;
  createClient?(options: PiRpcClientOptions): PiRpcClient;
};

export class PiWorkerManager {
  #workers = new Map<string, PiWorker>();
  #workerTokens = new Map<string, string>();
  #activePermits = 0;
  #permitQueue: Array<{ worker: PiWorker; resolve(): void }> = [];
  #closed = false;
  readonly maxWorkers: number;
  readonly maxConcurrent: number;
  readonly maxDepth: number;

  constructor(private readonly options: PiWorkerManagerOptions) {
    this.maxWorkers = positiveLimit(options.maxWorkers, 12);
    this.maxConcurrent = positiveLimit(options.maxConcurrent, 4);
    this.maxDepth = positiveLimit(options.maxDepth, 3);
  }

  list(): PiWorkerView[] {
    return [...this.#workers.values()].map(workerView);
  }

  get(target: string): PiWorkerView {
    return workerView(this.#resolve(target));
  }

  async execute(parentId: string, operation: PiSubagentOperation, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new Error("Watchdog Pi subagents are stopped.");
    if (parentId !== this.options.rootId && !this.#workers.has(parentId)) throw new Error(`Unknown Pi parent '${parentId}'.`);
    if (operation.action === "list") {
      return {
        agents: parentId === this.options.rootId
          ? this.list()
          : this.#descendants(parentId).map(workerView),
      };
    }
    if (operation.action === "spawn") {
      if (!operation.tasks.length) throw new Error("Spawn needs at least one task.");
      const parent = this.#workers.get(parentId);
      if (parent && !parent.allowDelegation) {
        throw new Error(`${parent.name} is not allowed to delegate. Its parent must spawn it with allowDelegation: true.`);
      }
      for (const task of operation.tasks) this.#validateTask(parentId, task);
      const depth = this.#depth(parentId) + 1;
      if (depth > this.maxDepth) throw new Error(`Watchdog Pi subagent depth limit reached (${this.maxDepth}).`);
      if (this.#workers.size + operation.tasks.length > this.maxWorkers) {
        throw new Error(`Watchdog Pi worker limit reached (${this.maxWorkers}). Stop/reuse an existing worker instead of spawning more.`);
      }
      if (parent) {
        const remaining = parent.maxChildren - parent.spawnedChildren;
        if (operation.tasks.length > remaining) {
          throw new Error(`${parent.name} may spawn ${remaining} more ${remaining === 1 ? "child" : "children"} (lifetime limit ${parent.maxChildren}).`);
        }
        parent.spawnedChildren += operation.tasks.length;
        this.options.onChanged?.();
      }
      const run = async () => await Promise.all(operation.tasks.map((task) => this.#spawnAndRun(parentId, task, signal)));
      if (parentId === this.options.rootId) return { agents: await run() };
      return await this.#whileParentDelegates(parentId, run);
    }
    const worker = parentId === this.options.rootId
      ? this.#resolve(operation.agent)
      : this.#resolveDescendant(parentId, operation.agent);
    if (operation.action === "steer") {
      if (!["working", "waiting"].includes(worker.status)) {
        throw new Error(`${worker.name} is not actively working; use follow_up or retry.`);
      }
      await worker.client?.steer(operation.message);
      return { steered: worker.name };
    }
    if (operation.action === "follow_up") {
      const task = operation.message.trim();
      if (!task) throw new Error("A follow-up message is required.");
      return await this.#followUp(worker, task, signal);
    }
    if (operation.action === "stop") return await this.stop(worker.id);
    return await this.retry(worker.id, {
      message: operation.message,
      model: operation.model,
      thinking: operation.thinking,
    }, signal);
  }

  async executeDelegated(token: string, operation: PiSubagentOperation, signal?: AbortSignal): Promise<unknown> {
    const parentId = this.#workerTokens.get(token);
    if (!parentId) throw new Error("Invalid or expired Watchdog Pi worker credential.");
    const parent = this.#workers.get(parentId);
    if (!parent?.allowDelegation) throw new Error(`${parent?.name ?? "This worker"} is not allowed to delegate.`);
    return await this.execute(parentId, operation, signal);
  }

  executeDelegatedExecution(token: string, operation: PiExecutionOperation): unknown {
    const workerId = this.#workerTokens.get(token);
    if (!workerId) throw new Error("Invalid or expired Watchdog Pi worker credential.");
    return executePiExecutionOperation(workerId, operation, this.options.emit, () => this.options.snapshot?.() ?? emptySnapshot());
  }

  async steer(target: string, message: string): Promise<unknown> {
    return await this.execute(this.options.rootId, { action: "steer", agent: target, message });
  }

  queueFollowUp(target: string, message: string): unknown {
    const worker = this.#resolve(target);
    if (!worker.client) throw new Error(`${worker.name} has not started.`);
    const task = message.trim();
    if (!task) throw new Error("A follow-up message is required.");
    const active = ["working", "waiting", "starting"].includes(worker.status);
    this.options.emit({
      type: "agent.activity",
      threadId: worker.id,
      tool: active ? "operator follow-up queued" : "operator follow-up starting",
      status: "queued",
    });
    void this.#followUp(worker, task).catch((error) => this.#recordBackgroundFailure(worker, error));
    return { queued: worker.name, mode: active ? "follow-up" : "new-turn" };
  }

  queueRetry(target: string, options: { message?: string; model?: string; thinking?: PiThinkingLevel }): unknown {
    const worker = this.#resolve(target);
    if (!worker.client) throw new Error(`${worker.name} has not started.`);
    this.options.emit({ type: "agent.activity", threadId: worker.id, tool: "operator retry queued", status: "queued" });
    void this.retry(worker.id, options).catch((error) => this.#recordBackgroundFailure(worker, error));
    return { retrying: worker.name, model: options.model, effort: options.thinking };
  }

  async stop(target: string): Promise<unknown> {
    const worker = this.#resolve(target);
    if (!worker.client || !["working", "waiting", "starting"].includes(worker.status)) {
      throw new Error(`${worker.name} has no active work to stop.`);
    }
    worker.stopRequested = true;
    await worker.client.abort();
    this.#setStatus(worker, "stopped");
    return { stopped: worker.name, parentNotified: true, notificationTarget: this.#label(worker.parentId) };
  }

  async retry(
    target: string,
    options: { message?: string; model?: string; thinking?: PiThinkingLevel },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const worker = this.#resolve(target);
    if (!worker.client) throw new Error(`${worker.name} has not started.`);
    if (["working", "waiting", "starting"].includes(worker.status)) {
      worker.stopRequested = true;
      await worker.client.abort();
    }
    return await this.#serialize(worker, async () => {
      if (this.#closed) throw new Error("Watchdog Pi runtime stopped before the retry could start.");
      if (options.model) {
        const effective = await worker.client!.setModel(options.model);
        worker.requestedModel = options.model;
        worker.model = `${effective.provider}/${effective.id}`;
      }
      if (options.thinking) {
        await worker.client!.setThinkingLevel(options.thinking);
        worker.requestedThinking = options.thinking;
        worker.thinking = options.thinking;
      }
      if (options.model || options.thinking) {
        this.options.emit({ type: "agent.effectiveConfig", threadId: worker.id, model: worker.model, reasoningEffort: worker.thinking });
      }
      await worker.client!.newSession();
      const task = options.message?.trim() || worker.task;
      worker.task = task;
      this.#emitRequested(worker);
      return await this.#runWithPermit(worker, task, signal);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const queued = this.#permitQueue.splice(0);
    for (const waiter of queued) waiter.resolve();
    await Promise.all([...this.#workers.values()].map(async (worker) => {
      await worker.client?.stop();
      worker.client = undefined;
      worker.hasPermit = false;
    }));
    this.#workerTokens.clear();
    this.#activePermits = 0;
  }

  async #spawnAndRun(parentId: string, input: PiSubagentTask, signal?: AbortSignal): Promise<PiWorkerView> {
    const task = input.task.trim();
    if (!task) throw new Error("Every Pi subagent needs a non-empty task.");
    const index = this.#workers.size;
    const delegation = this.#delegationPolicy(parentId, input);
    const worker: PiWorker = {
      id: `pi-worker-${randomUUID()}`,
      parentId,
      name: uniqueName(input.name?.trim() || DEFAULT_NAMES[index % DEFAULT_NAMES.length]!, this.#workers),
      role: input.role?.trim() || "worker",
      task,
      cwd: input.cwd?.trim() || this.options.cwd,
      status: "queued",
      requestedModel: input.model,
      requestedThinking: input.thinking,
      tools: input.tools,
      allowDelegation: delegation.allowed,
      maxChildren: delegation.maxChildren,
      maxDepth: delegation.maxDepth,
      spawnedChildren: 0,
      coordinatorToken: randomUUID(),
      timeoutMs: Math.min(Math.max((input.timeoutSeconds ?? 900) * 1_000, 10_000), 3_600_000),
      turn: 0,
      hasPermit: false,
      stopRequested: false,
      messageSequence: 0,
      currentMessageId: undefined,
      operationTail: Promise.resolve(),
      totalTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    this.#workers.set(worker.id, worker);
    this.#workerTokens.set(worker.coordinatorToken, worker.id);
    this.options.emit({ type: "thread.started", threadId: worker.id, parentThreadId: parentId, nickname: worker.name, role: worker.role, kind: "subprocess-worker" });
    this.options.emit({ type: "agent.spawned", parentThreadId: parentId, agentThreadId: worker.id, agentPath: this.#agentPath(worker), state: "queued" });
    this.options.emit({ type: "agent.identity", threadId: worker.id, parentThreadId: parentId, nickname: worker.name, role: worker.role });
    this.#emitRequested(worker);
    this.options.emit({ type: "thread.status", threadId: worker.id, status: "queued" });
    this.options.onChanged?.();

    return await this.#serialize(worker, async () => {
      await this.#acquire(worker);
      try {
        if (this.#closed) throw new Error("Watchdog Pi runtime stopped before the worker could start.");
        this.#setStatus(worker, "starting");
        const client = (this.options.createClient ?? ((options) => new PiRpcClient(options)))({
          cwd: worker.cwd,
          model: worker.requestedModel,
          thinking: worker.requestedThinking,
          tools: worker.tools?.length
            ? [...new Set([
              ...worker.tools.filter((tool) => !["subagent", "watchdog_subagent"].includes(tool.toLowerCase())),
              "watchdog_execution",
              ...(worker.allowDelegation ? ["subagent"] : []),
            ])]
            : undefined,
          extensionPath: this.options.extensionPath,
          piBin: this.options.piBin,
          env: {
            WATCHDOG_PI_COORDINATOR_SOCKET: this.options.coordinatorSocket,
            WATCHDOG_PI_COORDINATOR_TOKEN: worker.coordinatorToken,
            WATCHDOG_PI_ALLOW_DELEGATION: worker.allowDelegation ? "1" : "0",
          },
        });
        worker.client = client;
        client.onEvent((event) => this.#onRpcEvent(worker, event));
        const initial = await client.start();
        this.#applyEffective(worker, initial);
        return await this.#runPrompt(worker, task, signal);
      } catch (error) {
        worker.error = error instanceof Error ? error.message : String(error);
        this.#setStatus(worker, worker.stopRequested ? "stopped" : "failed");
        return workerView(worker);
      } finally {
        this.#release(worker);
      }
    });
  }

  async #followUp(worker: PiWorker, task: string, signal?: AbortSignal): Promise<unknown> {
    const client = worker.client;
    if (!client) throw new Error(`${worker.name} has not started.`);
    if (["working", "waiting", "starting"].includes(worker.status)) {
      await client.followUp(task);
      return { queued: worker.name, mode: "follow-up" };
    }
    worker.task = task;
    return await this.#runExisting(worker, task, signal);
  }

  async #runExisting(worker: PiWorker, task: string, signal?: AbortSignal): Promise<PiWorkerView> {
    return await this.#serialize(worker, async () => await this.#runWithPermit(worker, task, signal));
  }

  async #runWithPermit(worker: PiWorker, task: string, signal?: AbortSignal): Promise<PiWorkerView> {
    await this.#acquire(worker);
    try {
      if (this.#closed) throw new Error("Watchdog Pi runtime stopped before the worker turn could start.");
      return await this.#runPrompt(worker, task, signal);
    } finally {
      this.#release(worker);
    }
  }

  async #serialize<T>(worker: PiWorker, operation: () => Promise<T>): Promise<T> {
    const run = worker.operationTail.then(operation, operation);
    worker.operationTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  async #runPrompt(worker: PiWorker, task: string, signal?: AbortSignal): Promise<PiWorkerView> {
    const client = worker.client;
    if (!client) throw new Error(`${worker.name} has no Pi RPC client.`);
    worker.stopRequested = false;
    worker.error = undefined;
    worker.turn += 1;
    const turnId = `${worker.id}:turn:${worker.turn}`;
    this.options.emit({ type: "turn.input", threadId: worker.id, turnId, input: task });
    this.options.emit({ type: "turn.started", threadId: worker.id, turnId });
    this.#setStatus(worker, "working");

    const abort = () => {
      worker.stopRequested = true;
      void client.abort().catch(() => undefined);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      await client.prompt(task);
      await client.waitForSettled(worker.timeoutMs);
      if (worker.stopRequested) this.#setStatus(worker, "stopped");
      else if (worker.status !== "failed") this.#setStatus(worker, "idle");
    } catch (error) {
      worker.error = error instanceof Error ? error.message : String(error);
      if (!worker.stopRequested) await client.abort().catch(() => undefined);
      this.#setStatus(worker, worker.stopRequested ? "stopped" : "failed");
    } finally {
      signal?.removeEventListener("abort", abort);
      this.options.emit({ type: "turn.completed", threadId: worker.id, turnId });
    }
    return workerView(worker);
  }

  #onRpcEvent(worker: PiWorker, event: PiRpcEvent): void {
    if (event.type === "process_exit") {
      worker.error = typeof event.error === "string" ? event.error : "Pi RPC worker exited.";
      this.#setStatus(worker, worker.stopRequested ? "stopped" : "failed");
      return;
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const status = event.type === "tool_execution_end" ? (event.isError ? "failed" : "completed") : "inProgress";
      const tool = typeof event.toolName === "string" ? event.toolName : "tool";
      this.options.emit({ type: "agent.activity", threadId: worker.id, tool, status });
      return;
    }
    if (event.type === "message_start") {
      const message = object(event.message);
      if (message.role === "assistant") worker.currentMessageId = `${worker.id}:message:${++worker.messageSequence}`;
      return;
    }
    if (event.type === "message_update") {
      const delta = textDelta(event);
      if (delta) this.options.emit({
        type: "agent.message.delta",
        threadId: worker.id,
        itemId: worker.currentMessageId ?? `${worker.id}:turn:${worker.turn}:assistant`,
        delta,
        at: new Date().toISOString(),
      });
      return;
    }
    if (event.type === "message_end") {
      const message = object(event.message);
      if (message.role !== "assistant") return;
      const content = messageText(message);
      const itemId = worker.currentMessageId ?? `${worker.id}:message:${++worker.messageSequence}`;
      if (content) {
        worker.latestMessage = content;
        this.options.emit({ type: "agent.message", threadId: worker.id, itemId, message: content, at: new Date().toISOString() });
      }
      const usage = object(message.usage);
      const input = numeric(usage.input) + numeric(usage.cacheRead) + numeric(usage.cacheWrite);
      const output = numeric(usage.output);
      worker.totalTokens += input + output;
      worker.outputTokens += output;
      worker.costUsd += numeric(object(usage.cost).total);
      this.options.emit({
        type: "tokens.updated",
        threadId: worker.id,
        totalTokens: worker.totalTokens,
        outputTokens: worker.outputTokens,
        costUsd: worker.costUsd,
      });
      worker.currentMessageId = undefined;
    }
  }

  #applyEffective(worker: PiWorker, state: PiRpcState): void {
    worker.model = [state.model?.provider, state.model?.id].filter(Boolean).join("/") || state.model?.id;
    worker.thinking = state.thinkingLevel;
    this.options.emit({ type: "agent.effectiveConfig", threadId: worker.id, model: worker.model, reasoningEffort: worker.thinking });
  }

  #emitRequested(worker: PiWorker): void {
    this.options.emit({
      type: "agent.requestedConfig",
      parentThreadId: worker.parentId,
      agentThreadId: worker.id,
      prompt: worker.task,
      model: worker.requestedModel,
      reasoningEffort: worker.requestedThinking,
    });
  }

  async #whileParentDelegates<T>(parentId: string, work: () => Promise<T>): Promise<T> {
    const parent = this.#resolve(parentId);
    this.#setStatus(parent, "waiting");
    this.options.emit({ type: "agent.activity", threadId: parent.id, tool: "subagent · waiting for children", status: "inProgress" });
    this.#release(parent);
    try {
      return await work();
    } finally {
      await this.#acquire(parent);
      this.#setStatus(parent, parent.stopRequested || parent.status === "stopped" ? "stopped" : "working");
    }
  }

  async #acquire(worker: PiWorker): Promise<void> {
    if (worker.hasPermit) return;
    if (this.#activePermits < this.maxConcurrent) {
      this.#activePermits += 1;
      worker.hasPermit = true;
      return;
    }
    await new Promise<void>((resolve) => this.#permitQueue.push({ worker, resolve }));
  }

  #release(worker: PiWorker): void {
    if (!worker.hasPermit) return;
    worker.hasPermit = false;
    this.#activePermits = Math.max(0, this.#activePermits - 1);
    while (this.#permitQueue.length && this.#activePermits < this.maxConcurrent) {
      const next = this.#permitQueue.shift()!;
      if (next.worker.hasPermit) {
        next.resolve();
        continue;
      }
      next.worker.hasPermit = true;
      this.#activePermits += 1;
      next.resolve();
    }
  }

  #setStatus(worker: PiWorker, status: PiWorkerStatus): void {
    worker.status = status;
    this.options.emit({ type: "thread.status", threadId: worker.id, status });
    this.options.onChanged?.();
  }

  #recordBackgroundFailure(worker: PiWorker, error: unknown): void {
    worker.error = error instanceof Error ? error.message : String(error);
    this.#setStatus(worker, "failed");
  }

  #resolve(target: string): PiWorker {
    const needle = target.toLowerCase();
    const matches = [...this.#workers.values()].filter((worker) =>
      worker.id.toLowerCase().startsWith(needle) || worker.name.toLowerCase() === needle,
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`No Pi subagent matches '${target}'.`);
    throw new Error(`Pi subagent '${target}' is ambiguous; use a longer id.`);
  }

  #resolveDescendant(parentId: string, target: string): PiWorker {
    const needle = target.toLowerCase();
    const matches = this.#descendants(parentId).filter((worker) =>
      worker.id.toLowerCase().startsWith(needle) || worker.name.toLowerCase() === needle,
    );
    if (matches.length === 1) return matches[0]!;
    const parent = this.#workers.get(parentId);
    const label = parent?.name ?? parentId.slice(0, 8);
    if (matches.length === 0) throw new Error(`No Pi subagent in ${label}'s delegated subtree matches '${target}'.`);
    throw new Error(`Pi subagent '${target}' is ambiguous within ${label}'s delegated subtree; use a longer id.`);
  }

  #descendants(parentId: string): PiWorker[] {
    return [...this.#workers.values()].filter((worker) => this.#isDescendant(worker, parentId));
  }

  #isDescendant(worker: PiWorker, parentId: string): boolean {
    let current: PiWorker | undefined = worker;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (current.parentId === parentId) return true;
      seen.add(current.id);
      current = this.#workers.get(current.parentId);
    }
    return false;
  }

  #validateTask(parentId: string, input: PiSubagentTask): void {
    if (!input.task.trim()) throw new Error("Every Pi subagent needs a non-empty task.");
    if (input.tools?.length === 0) throw new Error("A Pi worker tool allowlist cannot be empty; omit tools to use Pi's defaults.");
    this.#delegationPolicy(parentId, input);
  }

  #delegationPolicy(parentId: string, input: PiSubagentTask): { allowed: boolean; maxChildren: number; maxDepth: number } {
    const allowed = input.allowDelegation === true;
    const requestedDelegationTool = input.tools?.some((tool) =>
      ["subagent", "watchdog_subagent"].includes(tool.toLowerCase()),
    );
    if (!allowed) {
      if (input.maxChildren !== undefined || input.maxDepth !== undefined || requestedDelegationTool) {
        throw new Error("Pi worker delegation settings require allowDelegation: true.");
      }
      return { allowed: false, maxChildren: 0, maxDepth: 0 };
    }

    const maxChildren = taskLimit(input.maxChildren, 1, "maxChildren");
    const maxDepth = taskLimit(input.maxDepth, 1, "maxDepth");
    if (maxChildren > this.maxWorkers) {
      throw new Error(`Pi worker maxChildren (${maxChildren}) cannot exceed the global worker limit (${this.maxWorkers}).`);
    }

    const childDepth = this.#depth(parentId) + 1;
    const globalDescendantDepth = this.maxDepth - childDepth;
    const parent = this.#workers.get(parentId);
    const inheritedDescendantDepth = parent ? parent.maxDepth - 1 : globalDescendantDepth;
    const availableDepth = Math.min(globalDescendantDepth, inheritedDescendantDepth);
    if (availableDepth < 1) {
      throw new Error("This Pi worker cannot receive delegation permission within its parent/global depth budget.");
    }
    if (maxDepth > availableDepth) {
      throw new Error(`Pi worker maxDepth (${maxDepth}) exceeds its available descendant depth (${availableDepth}).`);
    }
    return { allowed: true, maxChildren, maxDepth };
  }

  #depth(parentId: string): number {
    let depth = 0;
    let current = this.#workers.get(parentId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      depth += 1;
      current = this.#workers.get(current.parentId);
    }
    return depth;
  }

  #agentPath(worker: PiWorker): string {
    const names = [worker.name];
    let parent = this.#workers.get(worker.parentId);
    while (parent) {
      names.unshift(parent.name);
      parent = this.#workers.get(parent.parentId);
    }
    return names.join("/");
  }

  #label(id: string): string {
    return id === this.options.rootId ? "Pi root" : this.#workers.get(id)?.name ?? id.slice(0, 8);
  }
}

function workerView(worker: PiWorker): PiWorkerView {
  return {
    id: worker.id,
    parentId: worker.parentId,
    name: worker.name,
    role: worker.role,
    task: worker.task,
    cwd: worker.cwd,
    status: worker.status,
    model: worker.model,
    thinking: worker.thinking,
    totalTokens: worker.totalTokens,
    outputTokens: worker.outputTokens,
    costUsd: worker.costUsd,
    latestMessage: worker.latestMessage,
    error: worker.error,
    delegation: worker.allowDelegation
      ? {
        maxChildren: worker.maxChildren,
        spawnedChildren: worker.spawnedChildren,
        maxDepth: worker.maxDepth,
      }
      : undefined,
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function emptySnapshot(): RunSnapshot {
  return { startedAt: new Date(0).toISOString(), mode: "live", agents: [], loops: [], executions: [] };
}

function taskLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Pi worker ${name} must be a positive integer.`);
  return value;
}

function uniqueName(seed: string, workers: Map<string, PiWorker>): string {
  const used = new Set([...workers.values()].map((worker) => worker.name.toLowerCase()));
  if (!used.has(seed.toLowerCase())) return seed;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${seed}-${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function messageText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.map((part) => {
    if (typeof part === "string") return part;
    const value = object(part);
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n").trim();
}

function textDelta(event: PiRpcEvent): string | undefined {
  const update = object(event.assistantMessageEvent);
  if (update.type === "text_delta" && typeof update.delta === "string") return update.delta;
  if (typeof update.text === "string" && update.type === "text_delta") return update.text;
  return undefined;
}

const DEFAULT_NAMES = [
  "Ada", "Turing", "Hopper", "Curie", "Kepler", "Locke", "Feynman", "Volta",
  "Lovelace", "Cicero", "Banach", "Noether",
];
