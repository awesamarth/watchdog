import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { WatchdogEvent } from "../adapters/events.js";
import type { ExecutionEdgeDefinition, ExecutionNodeDefinition } from "../execution/types.js";
import { createRuntimeControlHandlers } from "../runtime/adapter.js";
import { startRunControlServer, controlSocketPath } from "../runtime/control.js";
import { createRunLogs } from "../runtime/codex.js";
import { createRunId } from "../runtime/registry.js";
import { RuntimeState } from "../runtime/state.js";
import { PiExtensionAdapter } from "./adapter.js";
import { requestPiCoordinator, startPiCoordinator, type PiCoordinator } from "./coordinator.js";
import { executePiExecutionOperation, type PiExecutionOperation } from "./execution.js";
import {
  PiWorkerManager,
  type PiSubagentOperation,
  type PiSubagentTask,
} from "./manager.js";
import type { PiThinkingLevel } from "./rpc.js";

const GLOBAL_KEY = Symbol.for("watchdog.pi.extension.loaded");
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EXECUTION_NODE_KINDS = ["stage", "action", "verifier", "wait", "subgraph", "terminal"] as const;
const EXECUTION_EDGE_KINDS = ["normal", "success", "failure", "loop-back"] as const;
const EXECUTION_END_STATUSES = ["completed", "failed", "stopped", "blocked"] as const;
const NODE_END_STATUSES = ["passed", "failed", "stopped"] as const;

const TaskSchema = Type.Object({
  task: Type.String({ minLength: 1, description: "A complete, bounded assignment for the subagent." }),
  name: Type.Optional(Type.String({ description: "Short human-readable name. Watchdog assigns one when omitted." })),
  role: Type.Optional(Type.String({ description: "Role such as investigator, implementer, or verifier." })),
  model: Type.Optional(Type.String({ description: "Pi model id or provider/model override." })),
  thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
  tools: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Non-empty Pi tool allowlist for this worker." })),
  cwd: Type.Optional(Type.String({ description: "Working directory override. Defaults to the parent project." })),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 10, maximum: 3600 })),
  allowDelegation: Type.Optional(Type.Boolean({
    description: "Allow this worker to spawn children. Defaults to false; enable only when its assignment explicitly requires nested delegation.",
  })),
  maxChildren: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Lifetime child budget for this worker. Requires allowDelegation; defaults to 1.",
  })),
  maxDepth: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Maximum descendant generations below this worker (1 = direct children only). Requires allowDelegation; defaults to 1.",
  })),
});

const ToolParameters = Type.Object({
  action: Type.Union([
    Type.Literal("spawn"),
    Type.Literal("list"),
    Type.Literal("steer"),
    Type.Literal("follow_up"),
    Type.Literal("stop"),
    Type.Literal("retry"),
  ]),
  tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: 8 })),
  agent: Type.Optional(Type.String({ description: "Worker name or unique id prefix." })),
  message: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
});

type ToolParameters = Static<typeof ToolParameters>;

const ExecutionNodeSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  kind: Type.Optional(Type.Union(EXECUTION_NODE_KINDS.map((kind) => Type.Literal(kind)))),
  description: Type.Optional(Type.String()),
  subgraphId: Type.Optional(Type.String()),
});

const ExecutionEdgeSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  kind: Type.Optional(Type.Union(EXECUTION_EDGE_KINDS.map((kind) => Type.Literal(kind)))),
  condition: Type.Optional(Type.String()),
});

const ExecutionToolParameters = Type.Object({
  action: Type.Union([
    Type.Literal("declare"),
    Type.Literal("update"),
    Type.Literal("list"),
    Type.Literal("start_iteration"),
    Type.Literal("start_node"),
    Type.Literal("complete_node"),
    Type.Literal("select_edge"),
    Type.Literal("evidence"),
    Type.Literal("verify"),
    Type.Literal("complete"),
  ]),
  executionId: Type.Optional(Type.String({ minLength: 1 })),
  label: Type.Optional(Type.String()),
  objective: Type.Optional(Type.String()),
  verifier: Type.Optional(Type.String()),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
  parentExecutionId: Type.Optional(Type.String()),
  parentNodeId: Type.Optional(Type.String()),
  nodes: Type.Optional(Type.Array(ExecutionNodeSchema, { minItems: 1 })),
  edges: Type.Optional(Type.Array(ExecutionEdgeSchema)),
  entryNodeIds: Type.Optional(Type.Array(Type.String())),
  terminalNodeIds: Type.Optional(Type.Array(Type.String())),
  nodeId: Type.Optional(Type.String()),
  activationId: Type.Optional(Type.String()),
  edgeId: Type.Optional(Type.String()),
  traversalId: Type.Optional(Type.String()),
  iteration: Type.Optional(Type.Integer({ minimum: 1 })),
  status: Type.Optional(Type.Union([
    ...NODE_END_STATUSES.map((status) => Type.Literal(status)),
    ...EXECUTION_END_STATUSES.map((status) => Type.Literal(status)),
    Type.Literal("running"),
    Type.Literal("waiting"),
  ])),
  reason: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
});

type ExecutionToolParameters = Static<typeof ExecutionToolParameters>;

type RootRuntime = {
  rootId: string;
  runId: string;
  state: RuntimeState;
  adapter: PiExtensionAdapter;
  manager: PiWorkerManager;
  coordinator: PiCoordinator;
  control: Awaited<ReturnType<typeof startRunControlServer>>;
  logs: Awaited<ReturnType<typeof createRunLogs>>;
  close(): Promise<void>;
};

type ExtensionSingleton = {
  runtime?: RootRuntime;
  latestContext?: ExtensionContext;
  toolName?: string;
  toolRegistered: boolean;
  executionToolRegistered: boolean;
  workerMode: boolean;
  workerCanDelegate: boolean;
};

export default function watchdogPiExtension(pi: ExtensionAPI): void {
  const globals = globalThis as typeof globalThis & { [GLOBAL_KEY]?: ExtensionSingleton };
  if (globals[GLOBAL_KEY]) return;
  const singleton: ExtensionSingleton = {
    toolRegistered: false,
    executionToolRegistered: false,
    workerMode: Boolean(process.env.WATCHDOG_PI_COORDINATOR_TOKEN),
    workerCanDelegate: process.env.WATCHDOG_PI_ALLOW_DELEGATION === "1",
  };
  globals[GLOBAL_KEY] = singleton;

  pi.on("session_start", async (_event, ctx) => {
    singleton.latestContext = ctx;
    if (!singleton.workerMode || singleton.workerCanDelegate) registerSubagentTool(pi, singleton, ctx);
    registerExecutionTool(pi, singleton);
    if (singleton.workerMode) return;
    await stopRootRuntime(singleton);
    singleton.runtime = await startRootRuntime(pi, singleton, ctx);
    updateFooter(singleton, ctx);
  });

  pi.on("session_shutdown", async () => {
    await stopRootRuntime(singleton);
    delete globals[GLOBAL_KEY];
  });

  if (!singleton.workerMode) {
    registerCommands(pi, singleton);
    registerRootEventHandlers(pi, singleton);
  }
}

function registerExecutionTool(pi: ExtensionAPI, singleton: ExtensionSingleton): void {
  if (singleton.executionToolRegistered) return;
  singleton.executionToolRegistered = true;
  pi.registerTool({
    name: "watchdog_execution",
    label: "Watchdog Execution",
    description: "Declare and instrument an explicit workflow, loop, or execution graph. It records semantic boundaries for Watchdog; it does not execute the work itself.",
    promptSnippet: "Instrument real multi-step workflows and loops in Watchdog",
    promptGuidelines: [
      "Use watchdog_execution only when the task is genuinely an explicit workflow, graph, or repeat-until loop. Do not turn an ordinary single turn into a graph.",
      "Declare the complete known graph before work starts. Node labels must describe real semantic stages, never generic invented phases.",
      "Use update only when the real workflow discovers or adds nodes and edges at runtime; do not rewrite history or manufacture detail.",
      "Call start_node and complete_node at actual stage boundaries, and select_edge for the transition taken. Reuse one activationId for that node attempt.",
      "A cycle is a loop. Increment iteration when another pass begins. Use a subgraph node plus parentExecutionId/parentNodeId when a stage owns a nested workflow.",
      "Declare verifier and token/iteration budgets when they are real, then record explicit evidence and verification outcomes instead of treating commentary as proof.",
      "If the internal shape is unknown, declare one honest opaque action node instead of guessing hidden steps.",
      "Before returning the final response, complete every started node and then complete the execution; close failure and stop paths explicitly too.",
    ],
    parameters: ExecutionToolParameters,
    async execute(_toolCallId, params) {
      const operation = normalizeExecutionOperation(params);
      const result = singleton.workerMode
        ? await executeExecutionThroughCoordinator(operation)
        : executeExecutionOnRoot(singleton, operation);
      return {
        content: [{ type: "text", text: formatExecutionResult(operation, result) }],
        details: result,
      };
    },
  });
}

function registerSubagentTool(pi: ExtensionAPI, singleton: ExtensionSingleton, ctx: ExtensionContext): void {
  if (singleton.toolRegistered) return;
  const collision = pi.getAllTools().some((tool) => tool.name === "subagent");
  const toolName = collision ? "watchdog_subagent" : "subagent";
  singleton.toolName = toolName;
  singleton.toolRegistered = true;
  pi.registerTool({
    name: toolName,
    label: "Watchdog Subagents",
    description: "Spawn and control persistent Pi subagents. Supports parallel tasks, live steering, follow-ups, stop, retry, per-worker model/thinking/tool/cwd overrides, and nested delegation.",
    promptSnippet: "Spawn or control observable, steerable Pi subagents through Watchdog",
    promptGuidelines: [
      `Use ${toolName} when independent work benefits from a separate context. Give every spawned worker one bounded task and an explicit role.`,
      `Use ${toolName} list before spawning replacements; prefer steering, following up, or retrying an existing worker when it already owns the relevant context.`,
      "Nested delegation is denied by default. Set allowDelegation only when a worker's assignment explicitly requires children, with the smallest maxChildren and maxDepth that can complete it.",
      `Do not claim a requested model or thinking level was used; Watchdog records requested and effective configuration separately.`,
    ],
    parameters: ToolParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate) {
      const operation = normalizeOperation(params);
      const progress = setInterval(() => {
        const workers = singleton.runtime?.manager.list() ?? [];
        const active = workers.filter((worker) => ["queued", "starting", "working", "waiting"].includes(worker.status));
        onUpdate?.({
          content: [{ type: "text", text: active.length ? formatWorkers(active) : "Watchdog is preparing the subagent operation…" }],
          details: { workers },
        });
      }, 750);
      progress.unref();
      try {
        const result = singleton.workerMode
          ? await executeThroughCoordinator(operation, signal)
          : await executeOnRoot(singleton, operation, signal);
        return {
          content: [{ type: "text", text: formatOperationResult(result) }],
          details: result,
        };
      } finally {
        clearInterval(progress);
      }
    },
  });
  if (collision && ctx.hasUI) {
    ctx.ui.notify("Watchdog found another `subagent` tool, so its controllable worker tool is `watchdog_subagent`.", "warning");
  }
}

function registerCommands(pi: ExtensionAPI, singleton: ExtensionSingleton): void {
  pi.registerCommand("watchdog-start", {
    description: "Start Watchdog for this Pi session",
    handler: async (_args, ctx) => {
      singleton.latestContext = ctx;
      if (singleton.runtime) return ctx.ui.notify(`Watchdog is already active (${singleton.runtime.runId}).`, "info");
      singleton.runtime = await startRootRuntime(pi, singleton, ctx);
      updateFooter(singleton, ctx);
      ctx.ui.notify(`Watchdog started · ${singleton.runtime.runId}`, "info");
    },
  });
  pi.registerCommand("watchdog-stop", {
    description: "Stop Watchdog and its Pi subagents",
    handler: async (_args, ctx) => {
      await stopRootRuntime(singleton);
      ctx.ui.setStatus("watchdog", undefined);
      ctx.ui.notify("Watchdog stopped. Pi itself is still running.", "info");
    },
  });
  pi.registerCommand("watchdog-status", {
    description: "Show the current Watchdog Pi runtime status",
    handler: async (_args, ctx) => {
      const runtime = singleton.runtime;
      if (!runtime) return ctx.ui.notify("Watchdog is not active. Run /watchdog-start.", "warning");
      const workers = runtime.manager.list();
      const active = workers.filter((worker) => ["queued", "starting", "working", "waiting"].includes(worker.status)).length;
      ctx.ui.notify(`Watchdog ${runtime.runId} · ${active} active / ${workers.length} subagents · dashboard sees this run automatically`, "info");
    },
  });
  pi.registerCommand("watchdog-agents", {
    description: "List Watchdog Pi subagents",
    handler: async (_args, ctx) => {
      const workers = singleton.runtime?.manager.list() ?? [];
      ctx.ui.notify(workers.length ? formatWorkers(workers) : "No Watchdog Pi subagents yet.", "info");
    },
  });
  pi.registerCommand("watchdog-open", {
    description: "Open the Watchdog dashboard",
    handler: async (_args, ctx) => {
      const opened = openDashboardProcess();
      ctx.ui.notify(opened ? "Opening the Watchdog dashboard…" : "Could not locate the Watchdog CLI. Run `watchdog dashboard` in another terminal.", opened ? "info" : "warning");
    },
  });
}

function registerRootEventHandlers(pi: ExtensionAPI, singleton: ExtensionSingleton): void {
  let turnSequence = 0;
  let messageSequence = 0;
  let activeTurnId: string | undefined;
  let activeMessageId: string | undefined;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  const ingest = (event: WatchdogEvent) => singleton.runtime?.adapter.ingest(event);
  const remember = (ctx: ExtensionContext) => {
    singleton.latestContext = ctx;
    updateFooter(singleton, ctx);
  };

  pi.on("before_agent_start", (event, ctx) => {
    remember(ctx);
    const runtime = singleton.runtime;
    if (!runtime) return;
    activeTurnId = `${runtime.rootId}:turn:${++turnSequence}`;
    ingest({ type: "turn.input", threadId: runtime.rootId, turnId: activeTurnId, input: event.prompt });
  });
  pi.on("agent_start", (_event, ctx) => {
    remember(ctx);
    const runtime = singleton.runtime;
    if (!runtime) return;
    activeTurnId ??= `${runtime.rootId}:turn:${++turnSequence}`;
    ingest({ type: "turn.started", threadId: runtime.rootId, turnId: activeTurnId });
    ingest({ type: "thread.status", threadId: runtime.rootId, status: "active" });
    ingestEffective(runtime, ctx, pi);
  });
  pi.on("message_start", (event, ctx) => {
    remember(ctx);
    if (object(event.message).role === "assistant" && singleton.runtime) {
      activeMessageId = `${singleton.runtime.rootId}:message:${++messageSequence}`;
    }
  });
  pi.on("message_update", (event, ctx) => {
    remember(ctx);
    const runtime = singleton.runtime;
    const delta = rootTextDelta(event.assistantMessageEvent);
    if (runtime && delta) ingest({
      type: "agent.message.delta",
      threadId: runtime.rootId,
      itemId: activeMessageId ?? `${runtime.rootId}:message:${messageSequence || 1}`,
      delta,
      at: new Date().toISOString(),
    });
  });
  pi.on("message_end", (event, ctx) => {
    remember(ctx);
    const runtime = singleton.runtime;
    const message = object(event.message);
    if (!runtime || message.role !== "assistant") return;
    const text = messageText(message);
    const itemId = activeMessageId ?? `${runtime.rootId}:message:${++messageSequence}`;
    if (text) ingest({ type: "agent.message", threadId: runtime.rootId, itemId, message: text, at: new Date().toISOString() });
    const usage = object(message.usage);
    const input = numeric(usage.input) + numeric(usage.cacheRead) + numeric(usage.cacheWrite);
    const output = numeric(usage.output);
    totalTokens += input + output;
    inputTokens += input;
    outputTokens += output;
    costUsd += numeric(object(usage.cost).total);
    ingest({ type: "tokens.updated", threadId: runtime.rootId, totalTokens, inputTokens, outputTokens, costUsd });
    activeMessageId = undefined;
  });
  pi.on("tool_execution_start", (event, ctx) => {
    remember(ctx);
    if (singleton.runtime) ingest({ type: "agent.activity", threadId: singleton.runtime.rootId, tool: event.toolName, status: "inProgress" });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    remember(ctx);
    if (singleton.runtime) ingest({ type: "agent.activity", threadId: singleton.runtime.rootId, tool: event.toolName, status: event.isError ? "failed" : "completed" });
  });
  pi.on("agent_settled", (_event, ctx) => {
    remember(ctx);
    const runtime = singleton.runtime;
    if (!runtime) return;
    if (activeTurnId) ingest({ type: "turn.completed", threadId: runtime.rootId, turnId: activeTurnId });
    ingest({ type: "thread.status", threadId: runtime.rootId, status: "idle" });
    activeTurnId = undefined;
  });
  pi.on("model_select", (_event, ctx) => {
    remember(ctx);
    if (singleton.runtime) ingestEffective(singleton.runtime, ctx, pi);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    remember(ctx);
    if (singleton.runtime) ingestEffective(singleton.runtime, ctx, pi);
  });
}

async function startRootRuntime(pi: ExtensionAPI, singleton: ExtensionSingleton, ctx: ExtensionContext): Promise<RootRuntime> {
  const runId = createRunId("pi");
  const rootId = `pi-root-${ctx.sessionManager.getSessionId()}`;
  const state = new RuntimeState();
  const logs = await createRunLogs();
  const coordinatorPath = controlSocketPath(`${runId}-coord`);
  let adapter: PiExtensionAdapter;
  const manager = new PiWorkerManager({
    rootId,
    cwd: ctx.cwd,
    extensionPath: fileURLToPath(import.meta.url),
    coordinatorSocket: coordinatorPath,
    emit: (event) => adapter.ingest(event),
    onChanged: () => {
      if (singleton.latestContext) updateFooter(singleton, singleton.latestContext);
    },
    snapshot: () => state.snapshot(),
    maxWorkers: environmentLimit("WATCHDOG_PI_MAX_WORKERS"),
    maxConcurrent: environmentLimit("WATCHDOG_PI_MAX_CONCURRENT"),
    maxDepth: environmentLimit("WATCHDOG_PI_MAX_DEPTH"),
  });
  adapter = new PiExtensionAdapter(rootId, {
    steer: (message) => pi.sendMessage({
      customType: "watchdog-control",
      content: `Watchdog operator intervention: ${message}`,
      display: true,
      details: { source: "watchdog" },
    }, { triggerTurn: true, deliverAs: "steer" }),
    followUp: (message) => pi.sendMessage({
      customType: "watchdog-control",
      content: `Watchdog operator follow-up: ${message}`,
      display: true,
      details: { source: "watchdog" },
    }, { triggerTurn: true, deliverAs: "followUp" }),
    interrupt: () => singleton.latestContext?.abort(),
  }, manager);
  const record = (event: WatchdogEvent) => {
    state.apply(event);
    if (event.type !== "agent.message.delta") logs.event(event);
  };
  adapter.onEvent(record);
  await adapter.start();
  const coordinator = await startPiCoordinator(coordinatorPath, manager);
  const control = await startRunControlServer(
    createRuntimeControlHandlers(adapter, state, record),
    adapter.descriptor,
    { runId, cwd: ctx.cwd, startedAt: state.startedAt },
  );
  let closed = false;
  const runtime: RootRuntime = {
    rootId,
    runId,
    state,
    adapter,
    manager,
    coordinator,
    control,
    logs,
    close: async () => {
      if (closed) return;
      closed = true;
      await control.close();
      await coordinator.close();
      await adapter.stop();
      await logs.flush();
    },
  };
  adapter.ingest({ type: "thread.started", threadId: rootId, nickname: "Pi root", role: "orchestrator", kind: "root" });
  adapter.ingest({ type: "thread.status", threadId: rootId, status: ctx.isIdle() ? "idle" : "active" });
  ingestEffective(runtime, ctx, pi);
  return runtime;
}

async function stopRootRuntime(singleton: ExtensionSingleton): Promise<void> {
  const runtime = singleton.runtime;
  singleton.runtime = undefined;
  if (runtime) await runtime.close();
}

function ingestEffective(runtime: RootRuntime, ctx: ExtensionContext, pi: ExtensionAPI): void {
  const model = [ctx.model?.provider, ctx.model?.id].filter(Boolean).join("/") || ctx.model?.id;
  runtime.adapter.ingest({
    type: "agent.effectiveConfig",
    threadId: runtime.rootId,
    model,
    reasoningEffort: pi.getThinkingLevel(),
  });
}

async function executeOnRoot(singleton: ExtensionSingleton, operation: PiSubagentOperation, signal?: AbortSignal): Promise<unknown> {
  const runtime = singleton.runtime;
  if (!runtime) throw new Error("Watchdog is not active. Run /watchdog-start.");
  return await runtime.manager.execute(runtime.rootId, operation, signal);
}

async function executeThroughCoordinator(operation: PiSubagentOperation, signal?: AbortSignal): Promise<unknown> {
  const path = process.env.WATCHDOG_PI_COORDINATOR_SOCKET;
  const token = process.env.WATCHDOG_PI_COORDINATOR_TOKEN;
  if (!path || !token) throw new Error("This Pi worker is missing its Watchdog delegation credential.");
  return await requestPiCoordinator(path, { token, operation }, signal);
}

function executeExecutionOnRoot(singleton: ExtensionSingleton, operation: PiExecutionOperation): unknown {
  const runtime = singleton.runtime;
  if (!runtime) throw new Error("Watchdog is not active. Run /watchdog-start.");
  return executePiExecutionOperation(
    runtime.rootId,
    operation,
    (event) => runtime.adapter.ingest(event),
    () => runtime.state.snapshot(),
  );
}

async function executeExecutionThroughCoordinator(operation: PiExecutionOperation): Promise<unknown> {
  const path = process.env.WATCHDOG_PI_COORDINATOR_SOCKET;
  const token = process.env.WATCHDOG_PI_COORDINATOR_TOKEN;
  if (!path || !token) throw new Error("This Pi worker is missing its Watchdog instrumentation credential.");
  return await requestPiCoordinator(path, { token, execution: operation });
}

function normalizeOperation(params: ToolParameters): PiSubagentOperation {
  if (params.action === "list") return { action: "list" };
  if (params.action === "spawn") {
    if (!params.tasks?.length) throw new Error("spawn requires a non-empty tasks array.");
    return { action: "spawn", tasks: params.tasks as PiSubagentTask[] };
  }
  const agent = params.agent?.trim();
  if (!agent) throw new Error(`${params.action} requires an agent name or id.`);
  if (params.action === "stop") return { action: "stop", agent };
  if (params.action === "retry") return {
    action: "retry",
    agent,
    message: params.message?.trim() || undefined,
    model: params.model?.trim() || undefined,
    thinking: params.thinking as PiThinkingLevel | undefined,
  };
  const message = params.message?.trim();
  if (!message) throw new Error(`${params.action} requires a message.`);
  return { action: params.action, agent, message };
}

function normalizeExecutionOperation(params: ExecutionToolParameters): PiExecutionOperation {
  if (params.action === "list") return { action: "list" };
  if (params.action === "declare" || params.action === "update") {
    if (params.action === "declare" && !params.nodes?.length) throw new Error("declare requires a non-empty nodes array.");
    const nodes: ExecutionNodeDefinition[] | undefined = params.nodes?.map((node) => ({
      id: node.id.trim(),
      label: node.label.trim(),
      kind: (node.kind ?? "stage") as ExecutionNodeDefinition["kind"],
      description: node.description?.trim() || undefined,
      subgraphId: node.subgraphId?.trim() || undefined,
    }));
    const edges: ExecutionEdgeDefinition[] | undefined = params.edges?.map((edge) => ({
      id: edge.id.trim(),
      from: edge.from.trim(),
      to: edge.to.trim(),
      kind: (edge.kind ?? "normal") as ExecutionEdgeDefinition["kind"],
      condition: edge.condition?.trim() || undefined,
    }));
    const common = {
      action: params.action,
      executionId: params.executionId?.trim() || (params.action === "declare" ? `pi-execution-${randomUUID()}` : ""),
      label: params.label?.trim() || undefined,
      objective: params.objective?.trim() || undefined,
      policy: executionPolicy(params),
      nodes,
      edges,
      entryNodeIds: params.entryNodeIds,
      terminalNodeIds: params.terminalNodeIds,
    } as const;
    if (params.action === "update") {
      return {
        ...common,
        action: "update",
        executionId: requiredParameter(params.executionId, "update requires executionId."),
      };
    }
    return {
      ...common,
      action: "declare",
      parentExecutionId: params.parentExecutionId?.trim() || undefined,
      parentNodeId: params.parentNodeId?.trim() || undefined,
      nodes: common.nodes!,
      edges: common.edges ?? [],
    };
  }
  const executionId = requiredParameter(params.executionId, `${params.action} requires executionId.`);
  if (params.action === "start_iteration") {
    if (!params.iteration) throw new Error("start_iteration requires a positive iteration.");
    return { action: "start_iteration", executionId, iteration: params.iteration, reason: params.reason?.trim() || undefined };
  }
  if (params.action === "start_node") {
    return {
      action: "start_node",
      executionId,
      nodeId: requiredParameter(params.nodeId, "start_node requires nodeId."),
      activationId: params.activationId?.trim() || randomUUID(),
      iteration: params.iteration,
      status: params.status === "waiting" ? "waiting" : "running",
    };
  }
  if (params.action === "complete_node") {
    if (!params.status || !NODE_END_STATUSES.includes(params.status as typeof NODE_END_STATUSES[number])) {
      throw new Error("complete_node status must be passed, failed, or stopped.");
    }
    return {
      action: "complete_node",
      executionId,
      nodeId: requiredParameter(params.nodeId, "complete_node requires nodeId."),
      activationId: requiredParameter(params.activationId, "complete_node requires the activationId returned by start_node."),
      status: params.status as typeof NODE_END_STATUSES[number],
      summary: params.summary?.trim() || undefined,
    };
  }
  if (params.action === "select_edge") {
    return {
      action: "select_edge",
      executionId,
      edgeId: requiredParameter(params.edgeId, "select_edge requires edgeId."),
      traversalId: params.traversalId?.trim() || randomUUID(),
      iteration: params.iteration,
    };
  }
  if (params.action === "evidence") {
    return {
      action: "evidence",
      executionId,
      nodeId: params.nodeId?.trim() || undefined,
      summary: requiredParameter(params.summary, "evidence requires summary."),
    };
  }
  if (params.action === "verify") {
    if (params.status !== "passed" && params.status !== "failed") {
      throw new Error("verify status must be passed or failed.");
    }
    return {
      action: "verify",
      executionId,
      status: params.status,
      summary: params.summary?.trim() || undefined,
    };
  }
  if (!params.status || !EXECUTION_END_STATUSES.includes(params.status as typeof EXECUTION_END_STATUSES[number])) {
    throw new Error("complete status must be completed, failed, stopped, or blocked.");
  }
  return {
    action: "complete",
    executionId,
    status: params.status as typeof EXECUTION_END_STATUSES[number],
    reason: params.reason?.trim() || undefined,
  };
}

function requiredParameter(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function executionPolicy(params: ExecutionToolParameters) {
  const policy = {
    verifier: params.verifier?.trim() || undefined,
    maxTokens: params.maxTokens,
    maxIterations: params.maxIterations,
  };
  return Object.values(policy).some((value) => value !== undefined) ? policy : undefined;
}

function updateFooter(singleton: ExtensionSingleton, ctx: ExtensionContext): void {
  const runtime = singleton.runtime;
  if (!runtime) return ctx.ui.setStatus("watchdog", undefined);
  const workers = runtime.manager.list();
  const active = workers.filter((worker) => ["queued", "starting", "working", "waiting"].includes(worker.status)).length;
  ctx.ui.setStatus("watchdog", `watchdog: active · ${active}/${workers.length} subagents`);
}

function formatWorkers(workers: Array<{
  name: string;
  status: string;
  role?: string;
  model?: string;
  thinking?: string;
  latestMessage?: string;
  error?: string;
  delegation?: { maxChildren: number; spawnedChildren: number; maxDepth: number };
}>): string {
  return workers.map((worker) => {
    const config = [worker.model, worker.thinking].filter(Boolean).join(" · ");
    const delegation = worker.delegation
      ? ` · children ${worker.delegation.spawnedChildren}/${worker.delegation.maxChildren} · depth ${worker.delegation.maxDepth}`
      : "";
    const note = worker.error ?? worker.latestMessage;
    return `${worker.name} · ${worker.status}${worker.role ? ` · ${worker.role}` : ""}${config ? ` · ${config}` : ""}${delegation}${note ? `\n  ${truncate(note, 180)}` : ""}`;
  }).join("\n");
}

function formatOperationResult(result: unknown): string {
  const value = object(result);
  if (Array.isArray(value.agents)) return formatWorkers(value.agents as Parameters<typeof formatWorkers>[0]);
  if (typeof value.steered === "string") return `Steered ${value.steered}.`;
  if (typeof value.stopped === "string") return `Stopped ${value.stopped}; its parent was notified through the waiting tool result.`;
  return JSON.stringify(result);
}

function formatExecutionResult(operation: PiExecutionOperation, result: unknown): string {
  if (operation.action === "list") {
    const count = Array.isArray(object(result).executions) ? (object(result).executions as unknown[]).length : 0;
    return count ? `${count} Watchdog execution ${count === 1 ? "graph" : "graphs"} available.` : "No explicit Watchdog execution graphs are active here.";
  }
  if (operation.action === "declare") return `Declared execution graph ${operation.executionId}.`;
  if (operation.action === "update") return `Updated execution graph ${operation.executionId}.`;
  if (operation.action === "start_node") return `Started ${operation.nodeId} (${operation.activationId}).`;
  if (operation.action === "complete_node") return `Marked ${operation.nodeId} ${operation.status}.`;
  if (operation.action === "select_edge") return `Recorded transition ${operation.edgeId}.`;
  if (operation.action === "start_iteration") return `Started iteration ${operation.iteration}.`;
  if (operation.action === "evidence") return `Recorded evidence for execution ${operation.executionId}.`;
  if (operation.action === "verify") return `Marked execution ${operation.executionId} verification ${operation.status}.`;
  return `Marked execution ${operation.executionId} ${operation.status}.`;
}

function openDashboardProcess(): boolean {
  const encoded = process.env.WATCHDOG_CLI_SPAWN;
  let command: string | undefined;
  let args: string[] = [];
  if (encoded) {
    try {
      const parsed = JSON.parse(encoded) as { command?: string; args?: string[] };
      command = parsed.command;
      args = parsed.args ?? [];
    } catch {
      // Fall through to the installed-package path.
    }
  }
  if (!command) {
    const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
    if (existsSync(cli)) {
      command = process.execPath;
      args = [cli];
    }
  }
  if (!command) return false;
  const child = spawn(command, [...args, "dashboard"], { cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env });
  child.unref();
  return true;
}

function environmentLimit(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
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

function rootTextDelta(event: unknown): string | undefined {
  const value = object(event);
  if (value.type === "text_delta" && typeof value.delta === "string") return value.delta;
  return undefined;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
