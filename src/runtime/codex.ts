import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { CodexAppServerAdapter } from "../codex/adapters.js";
import type { WatchdogEvent } from "../codex/normalizer.js";
import { CodexAppServerClient } from "../codex/protocol.js";
import { createRuntimeControlHandlers } from "./adapter.js";
import { startRunControlServer } from "./control.js";
import { RuntimeState } from "./state.js";

const CODEX_BIN = process.env.WATCHDOG_CODEX_BIN ?? "codex";

export async function runCodexWithWatchdog(codexArgs: string[]): Promise<number> {
  const port = await freePort();
  const remoteAddress = `ws://127.0.0.1:${port}`;
  let appServer: ChildProcess | undefined;
  let codex: ChildProcess | undefined;
  let client: CodexAppServerClient | undefined;
  let adapter: CodexAppServerAdapter | undefined;
  let control: Awaited<ReturnType<typeof startRunControlServer>> | undefined;
  const logs = await createRunLogs();
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
    appServer.on("error", (error) => logs.diagnostic("app-server", `could not start: ${error.message}`));
    appServer.stderr?.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line) logs.diagnostic("app-server", line);
    });

    await waitForReady(port);
    client = await connectWithRetry(remoteAddress);
    client.on("connectionError", (error: Error) => logs.diagnostic("connection", error.message));
    adapter = new CodexAppServerAdapter(client, state);
    const recordEvent = (event: WatchdogEvent) => {
      state.apply(event);
      if (event.type === "agent.message.delta") return;
      logs.event(event);
    };
    adapter.onEvent(recordEvent);
    await adapter.start();
    control = await startRunControlServer(createRuntimeControlHandlers(adapter, state, recordEvent), adapter.descriptor, { startedAt: state.startedAt });
    console.error("[watchdog] live control attached over a loopback-only WebSocket");
    console.error(`[watchdog] run id: ${control.runId}`);
    console.error(`[watchdog] event trace: ${logs.eventPath}`);
    console.error(`[watchdog] diagnostics: ${logs.diagnosticPath}`);
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
    await logs.flush();
  }
}

type RunLogs = {
  eventPath: string;
  diagnosticPath: string;
  event(event: WatchdogEvent): void;
  diagnostic(scope: string, message: string): void;
  flush(): Promise<void>;
};

export async function createRunLogs(directory = join(process.cwd(), ".watchdog", "runs")): Promise<RunLogs> {
  await mkdir(directory, { recursive: true });
  const basename = new Date().toISOString().replaceAll(":", "-");
  const eventPath = join(directory, `${basename}.jsonl`);
  const diagnosticPath = join(directory, `${basename}.diagnostics.log`);
  let pending = Promise.resolve();
  const append = (path: string, line: string) => {
    pending = pending.then(() => appendFile(path, line)).catch(() => undefined);
  };
  return {
    eventPath,
    diagnosticPath,
    event: (event) => append(eventPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`),
    diagnostic: (scope, message) => append(diagnosticPath, `${new Date().toISOString()} [${scope}] ${message}\n`),
    flush: async () => { await pending; },
  };
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
