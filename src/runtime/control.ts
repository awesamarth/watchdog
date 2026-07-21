import { createServer, createConnection, type Server } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AdapterDescriptor } from "../adapters/types.js";
import type {
  ExecutionGraphDefinition,
  ExecutionPolicy,
  ExecutionStatus,
  NodeActivationStatus,
} from "../execution/types.js";
import type { RunSnapshot } from "./state.js";
import {
  createRunId,
  listRegisteredRuns,
  registerRun,
  runSocketPath,
  unregisterRun,
  type RegistryOptions,
  type RegisteredRun,
} from "./registry.js";

export type ControlRequest =
  | { action: "snapshot" }
  | { action: "steer"; agent: string; message: string }
  | { action: "followUp"; agent: string; message: string }
  | { action: "interrupt"; agent: string }
  | { action: "retry"; agent: string; message: string; model?: string; effort?: string }
  | { action: "loop.configure"; agent: string; objective?: string; verifier?: string; maxTokens?: number; maxIterations?: number }
  | { action: "loop.evidence"; agent: string; summary: string; source?: string }
  | { action: "loop.verify"; agent: string; status: "passed" | "failed"; summary?: string }
  | { action: "execution.declare"; graph: ExecutionGraphDefinition }
  | { action: "execution.update"; executionId: string; nodes?: ExecutionGraphDefinition["nodes"]; edges?: ExecutionGraphDefinition["edges"]; entryNodeIds?: string[]; terminalNodeIds?: string[]; objective?: string; label?: string; policy?: ExecutionPolicy }
  | { action: "execution.iteration.start"; executionId: string; iteration: number; reason?: string }
  | { action: "execution.node.start"; executionId: string; nodeId: string; activationId: string; agent: string; iteration?: number; status?: "running" | "waiting" }
  | { action: "execution.node.complete"; executionId: string; nodeId: string; activationId: string; status: Exclude<NodeActivationStatus, "queued" | "running" | "waiting">; summary?: string }
  | { action: "execution.edge.select"; executionId: string; edgeId: string; traversalId: string; iteration?: number }
  | { action: "execution.evidence"; executionId: string; agent: string; nodeId?: string; summary: string; source?: string }
  | { action: "execution.verify"; executionId: string; status: "passed" | "failed"; summary?: string }
  | { action: "execution.stop"; executionId: string; nodeId?: string; reason?: string }
  | { action: "execution.node.retry"; executionId: string; nodeId: string; message: string; model?: string; effort?: string }
  | { action: "execution.complete"; executionId: string; status: Extract<ExecutionStatus, "completed" | "failed" | "stopped" | "blocked">; reason?: string };

export type ControlHandlers = {
  snapshot(): RunSnapshot;
  steer(agent: string, message: string): Promise<unknown>;
  followUp(agent: string, message: string): Promise<unknown>;
  interrupt(agent: string): Promise<unknown>;
  retry(agent: string, message: string, model?: string, effort?: string): Promise<unknown>;
  configureLoop(agent: string, options: { objective?: string; verifier?: string; maxTokens?: number; maxIterations?: number }): Promise<unknown>;
  addEvidence(agent: string, summary: string, source?: string): Promise<unknown>;
  verifyLoop(agent: string, status: "passed" | "failed", summary?: string): Promise<unknown>;
  declareExecution?(graph: ExecutionGraphDefinition): Promise<unknown>;
  updateExecution?(input: { executionId: string; nodes?: ExecutionGraphDefinition["nodes"]; edges?: ExecutionGraphDefinition["edges"]; entryNodeIds?: string[]; terminalNodeIds?: string[]; objective?: string; label?: string; policy?: ExecutionPolicy }): Promise<unknown>;
  startExecutionIteration?(executionId: string, iteration: number, reason?: string): Promise<unknown>;
  startExecutionNode?(input: { executionId: string; nodeId: string; activationId: string; agent: string; iteration?: number; status?: "running" | "waiting" }): Promise<unknown>;
  completeExecutionNode?(input: { executionId: string; nodeId: string; activationId: string; status: Exclude<NodeActivationStatus, "queued" | "running" | "waiting">; summary?: string }): Promise<unknown>;
  selectExecutionEdge?(input: { executionId: string; edgeId: string; traversalId: string; iteration?: number }): Promise<unknown>;
  addExecutionEvidence?(input: { executionId: string; agent: string; nodeId?: string; summary: string; source?: string }): Promise<unknown>;
  verifyExecution?(executionId: string, status: "passed" | "failed", summary?: string): Promise<unknown>;
  stopExecution?(executionId: string, nodeId?: string, reason?: string): Promise<unknown>;
  retryExecutionNode?(input: { executionId: string; nodeId: string; message: string; model?: string; effort?: string }): Promise<unknown>;
  completeExecution?(executionId: string, status: Extract<ExecutionStatus, "completed" | "failed" | "stopped" | "blocked">, reason?: string): Promise<unknown>;
};

export type ControlTarget = {
  runId?: string;
  cwd?: string;
  socketPath?: string;
  home?: string;
};

export type RunControlServer = {
  runId: string;
  path: string;
  registration: RegisteredRun;
  close(): Promise<void>;
};

export type ReachableRun = {
  registration: RegisteredRun;
  snapshot: RunSnapshot;
};

class RunUnavailableError extends Error {
  constructor(message = "The selected Watchdog run is no longer reachable.") {
    super(message);
    this.name = "RunUnavailableError";
  }
}

export class ControlRequestTimeoutError extends Error {
  constructor(action: ControlRequest["action"], timeoutMs: number) {
    super(`Watchdog control request '${action}' timed out after ${timeoutMs}ms.`);
    this.name = "ControlRequestTimeoutError";
  }
}

export function controlSocketPath(runId: string, home?: string): string {
  return runSocketPath(runId, home);
}

async function startControlServer(handlers: ControlHandlers, options: { runId?: string; home?: string } = {}): Promise<{ runId: string; path: string; close(): Promise<void> }> {
  const runId = options.runId ?? createRunId("run");
  const path = controlSocketPath(runId, options.home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rm(path, { force: true });
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      void dispatch(line, handlers).then((result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`), (error: Error) => socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`));
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(path, () => resolve()).once("error", reject));
  return { runId, path, close: () => closeControlServer(server, path) };
}

export async function startRunControlServer(
  handlers: ControlHandlers,
  adapter: AdapterDescriptor,
  options: { runId?: string; cwd?: string; home?: string; startedAt?: string } = {},
): Promise<RunControlServer> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const control = await startControlServer(handlers, { runId: options.runId ?? createRunId(adapter.harness), home: options.home });
  let registration: RegisteredRun;
  try {
    registration = await registerRun({
      runId: control.runId,
      cwd,
      socketPath: control.path,
      pid: process.pid,
      startedAt: options.startedAt ?? new Date().toISOString(),
      adapter,
    }, { home: options.home });
  } catch (error) {
    await control.close();
    throw error;
  }
  let closed = false;
  return {
    ...control,
    registration,
    close: async () => {
      if (closed) return;
      closed = true;
      await unregisterRun(control.runId, { home: options.home });
      await control.close();
    },
  };
}

export async function requestControl(request: ControlRequest, target: ControlTarget = {}): Promise<unknown> {
  if (target.socketPath) return await requestControlAt(target.socketPath, request);
  const registration = await resolveRegisteredRun(target);
  try {
    return await requestControlAt(registration.socketPath, request);
  } catch (error) {
    if (error instanceof RunUnavailableError) {
      await unregisterRun(registration.runId, { home: target.home });
    }
    throw error;
  }
}

export async function listReachableRuns(
  options: RegistryOptions & { timeoutMs?: number } = {},
): Promise<ReachableRun[]> {
  const { timeoutMs = 5_000, ...registryOptions } = options;
  const registrations = await listRegisteredRuns(registryOptions);
  const runs = await Promise.all(registrations.map(async (registration) => {
    try {
      return {
        registration,
        snapshot: await requestControlAt(
          registration.socketPath,
          { action: "snapshot" },
          timeoutMs,
        ) as RunSnapshot,
      };
    } catch (error) {
      if (error instanceof RunUnavailableError) {
        await unregisterRun(registration.runId, { home: options.home });
      }
      return undefined;
    }
  }));
  return runs.filter((run): run is ReachableRun => Boolean(run));
}

async function resolveRegisteredRun(target: ControlTarget = {}): Promise<RegisteredRun> {
  const records = await listRegisteredRuns({ home: target.home });
  const matches = target.runId
    ? records.filter((record) => record.runId === target.runId || record.runId.startsWith(target.runId!))
    : records.filter((record) => resolve(record.cwd) === resolve(target.cwd ?? process.cwd()));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new Error(target.runId
      ? `No active Watchdog run matches '${target.runId}'. Use \`watchdog runs\` to list active runs.`
      : "No Watchdog run matches this directory. Launch a harness (Codex, Pi) through Watchdog, or use `watchdog runs` and select one with `--run <id>`.");
  }
  throw new Error(`Multiple Watchdog runs match${target.runId ? ` '${target.runId}'` : " this project"}. Use \`--run <id>\`: ${matches.map((record) => record.runId).join(", ")}`);
}

export async function requestControlAt(path: string, request: ControlRequest, timeoutMs = defaultControlTimeout(request.action)): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let response = "";
    let settled = false;
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      complete();
    };
    const timer = setTimeout(() => {
      settle(() => {
        socket.destroy();
        reject(new ControlRequestTimeoutError(request.action, timeoutMs));
      });
    }, Math.max(1, timeoutMs));
    timer.unref();
    socket.once("error", () => settle(() => reject(new RunUnavailableError())));
    socket.on("data", (chunk) => response += chunk.toString());
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.once("end", () => {
      settle(() => {
        try {
          const parsed = JSON.parse(response) as { ok: boolean; result?: unknown; error?: string };
          parsed.ok ? resolve(parsed.result) : reject(new Error(parsed.error));
        } catch { reject(new Error("Watchdog control server returned invalid data")); }
      });
    });
    socket.once("close", () => settle(() => reject(new RunUnavailableError("The selected Watchdog run closed the control connection before responding."))));
  });
}

function defaultControlTimeout(action: ControlRequest["action"]): number {
  if (action === "snapshot") return 5_000;
  if (action === "retry" || action === "execution.node.retry") return 35_000;
  return 25_000;
}

async function dispatch(line: string, handlers: ControlHandlers): Promise<unknown> {
  const request = JSON.parse(line) as ControlRequest;
  switch (request.action) {
    case "snapshot": return handlers.snapshot();
    case "steer": return await handlers.steer(request.agent, request.message);
    case "followUp": return await handlers.followUp(request.agent, request.message);
    case "interrupt": return await handlers.interrupt(request.agent);
    case "retry": return await handlers.retry(request.agent, request.message, request.model, request.effort);
    case "loop.configure": return await handlers.configureLoop(request.agent, request);
    case "loop.evidence": return await handlers.addEvidence(request.agent, request.summary, request.source);
    case "loop.verify": return await handlers.verifyLoop(request.agent, request.status, request.summary);
    case "execution.declare": return await requiredExecutionHandler(handlers.declareExecution, request.action)(request.graph);
    case "execution.update": return await requiredExecutionHandler(handlers.updateExecution, request.action)(request);
    case "execution.iteration.start": return await requiredExecutionHandler(handlers.startExecutionIteration, request.action)(request.executionId, request.iteration, request.reason);
    case "execution.node.start": return await requiredExecutionHandler(handlers.startExecutionNode, request.action)(request);
    case "execution.node.complete": return await requiredExecutionHandler(handlers.completeExecutionNode, request.action)(request);
    case "execution.edge.select": return await requiredExecutionHandler(handlers.selectExecutionEdge, request.action)(request);
    case "execution.evidence": return await requiredExecutionHandler(handlers.addExecutionEvidence, request.action)(request);
    case "execution.verify": return await requiredExecutionHandler(handlers.verifyExecution, request.action)(request.executionId, request.status, request.summary);
    case "execution.stop": return await requiredExecutionHandler(handlers.stopExecution, request.action)(request.executionId, request.nodeId, request.reason);
    case "execution.node.retry": return await requiredExecutionHandler(handlers.retryExecutionNode, request.action)(request);
    case "execution.complete": return await requiredExecutionHandler(handlers.completeExecution, request.action)(request.executionId, request.status, request.reason);
  }
}

function requiredExecutionHandler<T extends (...args: never[]) => Promise<unknown>>(handler: T | undefined, action: string): T {
  if (!handler) throw new Error(`This Watchdog runtime does not support '${action}'.`);
  return handler;
}

async function closeControlServer(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(path, { force: true });
}
