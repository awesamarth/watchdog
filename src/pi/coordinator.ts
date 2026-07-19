import { createConnection, createServer, type Server } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { PiExecutionOperation } from "./execution.js";
import type { PiSubagentOperation, PiWorkerManager } from "./manager.js";

export type PiCoordinator = {
  path: string;
  close(): Promise<void>;
};

export type CoordinatorRequest =
  | { token: string; operation: PiSubagentOperation }
  | { token: string; execution: PiExecutionOperation };

export async function startPiCoordinator(path: string, manager: PiWorkerManager): Promise<PiCoordinator> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rm(path, { force: true });
  const server = createServer((socket) => {
    let buffer = "";
    const controller = new AbortController();
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      void dispatchCoordinator(line, manager, controller.signal).then(
        (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
        (error: unknown) => socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`),
      );
    });
    socket.once("close", () => controller.abort());
  });
  await new Promise<void>((resolve, reject) => server.listen(path, resolve).once("error", reject));
  let closed = false;
  return {
    path,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
      await rm(path, { force: true });
    },
  };
}

export async function requestPiCoordinator(
  path: string,
  request: CoordinatorRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection({ path });
    let response = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error("Pi subagent delegation was cancelled."));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => finish(new Error(`Watchdog Pi coordinator is unavailable: ${error.message}`)));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => response += chunk.toString());
    socket.once("end", () => {
      try {
        const parsed = JSON.parse(response) as { ok?: boolean; result?: unknown; error?: string };
        parsed.ok ? finish(undefined, parsed.result) : finish(new Error(parsed.error ?? "Watchdog Pi coordinator rejected the request."));
      } catch {
        finish(new Error("Watchdog Pi coordinator returned invalid data."));
      }
    });
  });
}

async function dispatchCoordinator(line: string, manager: PiWorkerManager, signal: AbortSignal): Promise<unknown> {
  const request = JSON.parse(line) as Partial<CoordinatorRequest>;
  if (!request || typeof request.token !== "string") {
    throw new Error("Invalid Watchdog Pi coordinator request.");
  }
  if ("operation" in request && request.operation && typeof request.operation === "object") {
    return await manager.executeDelegated(request.token, request.operation as PiSubagentOperation, signal);
  }
  if ("execution" in request && request.execution && typeof request.execution === "object") {
    return manager.executeDelegatedExecution(request.token, request.execution as PiExecutionOperation);
  }
  throw new Error("Invalid Watchdog Pi coordinator operation.");
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
