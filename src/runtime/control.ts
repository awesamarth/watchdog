import { createServer, createConnection, type Server } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunSnapshot } from "./state.js";

export type ControlRequest =
  | { action: "snapshot" }
  | { action: "steer"; agent: string; message: string }
  | { action: "interrupt"; agent: string }
  | { action: "retry"; agent: string; message: string; model?: string; effort?: string }
  | { action: "loop.configure"; agent: string; objective?: string; verifier?: string; maxTokens?: number; maxIterations?: number }
  | { action: "loop.evidence"; agent: string; summary: string; source?: string }
  | { action: "loop.verify"; agent: string; status: "passed" | "failed"; summary?: string };

export type ControlHandlers = {
  snapshot(): RunSnapshot;
  steer(agent: string, message: string): Promise<unknown>;
  interrupt(agent: string): Promise<unknown>;
  retry(agent: string, message: string, model?: string, effort?: string): Promise<unknown>;
  configureLoop(agent: string, options: { objective?: string; verifier?: string; maxTokens?: number; maxIterations?: number }): Promise<unknown>;
  addEvidence(agent: string, summary: string, source?: string): Promise<unknown>;
  verifyLoop(agent: string, status: "passed" | "failed", summary?: string): Promise<unknown>;
};

export function controlSocketPath(cwd = process.cwd()): string {
  return join(cwd, ".watchdog", "control.sock");
}

export async function startControlServer(handlers: ControlHandlers, cwd = process.cwd()): Promise<{ path: string; close(): Promise<void> }> {
  const path = controlSocketPath(cwd);
  await mkdir(dirname(path), { recursive: true });
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
  return { path, close: () => closeControlServer(server, path) };
}

export async function requestControl(request: ControlRequest, cwd = process.cwd()): Promise<unknown> {
  const path = controlSocketPath(cwd);
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let response = "";
    socket.once("error", () => reject(new Error("No Watchdog run is active here. Start one with `watchdog codex`.")));
    socket.on("data", (chunk) => response += chunk.toString());
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.once("end", () => {
      try {
        const parsed = JSON.parse(response) as { ok: boolean; result?: unknown; error?: string };
        parsed.ok ? resolve(parsed.result) : reject(new Error(parsed.error));
      } catch { reject(new Error("Watchdog control server returned invalid data")); }
    });
  });
}

async function dispatch(line: string, handlers: ControlHandlers): Promise<unknown> {
  const request = JSON.parse(line) as ControlRequest;
  switch (request.action) {
    case "snapshot": return handlers.snapshot();
    case "steer": return await handlers.steer(request.agent, request.message);
    case "interrupt": return await handlers.interrupt(request.agent);
    case "retry": return await handlers.retry(request.agent, request.message, request.model, request.effort);
    case "loop.configure": return await handlers.configureLoop(request.agent, request);
    case "loop.evidence": return await handlers.addEvidence(request.agent, request.summary, request.source);
    case "loop.verify": return await handlers.verifyLoop(request.agent, request.status, request.summary);
  }
}

async function closeControlServer(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(path, { force: true });
}
