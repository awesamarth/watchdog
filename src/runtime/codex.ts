import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { CodexAppServerAdapter } from "../codex/adapters.js";
import type { WatchdogEvent } from "../codex/normalizer.js";
import { CodexAppServerClient } from "../codex/protocol.js";
import { createRuntimeControlHandlers } from "./adapter.js";
import { startControlServer } from "./control.js";
import { RuntimeState } from "./state.js";

const CODEX_BIN = process.env.WATCHDOG_CODEX_BIN ?? "codex";

export async function runCodexWithWatchdog(codexArgs: string[]): Promise<number> {
  const port = await freePort();
  const remoteAddress = `ws://127.0.0.1:${port}`;
  let appServer: ChildProcess | undefined;
  let codex: ChildProcess | undefined;
  let client: CodexAppServerClient | undefined;
  let adapter: CodexAppServerAdapter | undefined;
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  const eventLog = await createEventLog();
  const state = new RuntimeState();

  const cleanup = async () => {
    client?.close();
    if (codex && !codex.killed) codex.kill("SIGTERM");
    if (appServer && !appServer.killed) appServer.kill("SIGTERM");
  };
  const forward = (signal: NodeJS.Signals) => codex?.kill(signal);
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));

  try {
    appServer = spawn(CODEX_BIN, ["app-server", "--listen", remoteAddress], { stdio: ["ignore", "pipe", "pipe"] });
    appServer.on("error", (error) => console.error(`[watchdog] could not start Codex App Server: ${error.message}`));
    appServer.stderr?.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line) console.error(`[watchdog:app-server] ${line}`);
    });

    await waitForReady(port);
    client = await connectWithRetry(remoteAddress);
    client.on("connectionError", (error: Error) => console.error(`[watchdog] App Server connection error: ${error.message}`));
    adapter = new CodexAppServerAdapter(client, state);
    const recordEvent = (event: WatchdogEvent) => {
      state.apply(event);
      console.error(formatEvent(event));
      void appendFile(eventLog, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    };
    adapter.onEvent(recordEvent);
    await adapter.start();
    control = await startControlServer(createRuntimeControlHandlers(adapter, state, recordEvent));
    console.error("[watchdog] live control attached over a loopback-only WebSocket");
    console.error(`[watchdog] event trace: ${eventLog}`);
    console.error(`[watchdog] terminal controls ready: ${control.path}`);

    codex = spawn(CODEX_BIN, ["--remote", remoteAddress, ...codexArgs], { cwd: process.cwd(), stdio: "inherit" });
    return await new Promise<number>((resolve, reject) => {
      codex?.once("error", reject);
      codex?.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    await control?.close();
    await adapter?.stop();
    await cleanup();
  }
}

async function createEventLog(): Promise<string> {
  const directory = join(process.cwd(), ".watchdog", "runs");
  await mkdir(directory, { recursive: true });
  return join(directory, `${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
}

async function waitForReady(port: number, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) return;
    } catch {
      // Server has not bound the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Codex App Server did not become ready within ${timeoutMs}ms`);
}

async function connectWithRetry(endpoint: string, timeoutMs = 8_000): Promise<CodexAppServerClient> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt <= timeoutMs) {
    const client = new CodexAppServerClient(endpoint);
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Could not connect to Codex App Server: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not reserve a loopback port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function formatEvent(event: WatchdogEvent): string {
  const id = "threadId" in event ? short(event.threadId) : short(event.agentThreadId);
  switch (event.type) {
    case "thread.started": return `[watchdog] thread ${id} started${event.parentThreadId ? ` (child of ${short(event.parentThreadId)})` : ""}${label(event.nickname, event.role)}`;
    case "thread.status": return `[watchdog] ${id} is ${event.status}`;
    case "turn.started": return `[watchdog] ${id} turn started`;
    case "turn.completed": return `[watchdog] ${id} turn completed`;
    case "loop.objective": return `[watchdog] ${id} loop objective captured`;
    case "agent.spawned": return `[watchdog] ${short(event.parentThreadId)} spawned ${short(event.agentThreadId)}${event.agentPath ? ` as ${event.agentPath}` : ""}`;
    case "agent.identity": return `[watchdog] ${id} identity${label(event.nickname, event.role) || " unavailable"}`;
    case "agent.activity": return `[watchdog] ${id} ${event.tool} ${event.status}${event.model ? ` (${event.model}${event.reasoningEffort ? `/${event.reasoningEffort}` : ""})` : ""}`;
    case "agent.requestedConfig": return `[watchdog] ${short(event.parentThreadId)} requested ${short(event.agentThreadId)} ${event.model ?? "default"}/${event.reasoningEffort ?? "default"}`;
    case "agent.effectiveConfig": return `[watchdog] ${id} effective ${event.model ?? "unknown"}/${event.reasoningEffort ?? "default"}`;
    case "tokens.updated": return `[watchdog] ${id} tokens ${event.totalTokens ?? "?"} total / ${event.outputTokens ?? "?"} output`;
    case "loop.configured": return `[watchdog] ${id} loop configured`;
    case "evidence.collected": return `[watchdog] ${id} evidence collected (${event.source})`;
    case "loop.verified": return `[watchdog] ${id} verifier ${event.status}`;
  }
}

function short(id: string): string { return id.slice(0, 8); }
function label(nickname?: string, role?: string): string {
  const values = [nickname, role].filter(Boolean);
  return values.length ? ` [${values.join(" · ")}]` : "";
}
