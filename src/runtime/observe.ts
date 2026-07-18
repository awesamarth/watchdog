import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexJsonlAdapter } from "../codex/adapters.js";
import type { WatchdogEvent } from "../codex/normalizer.js";
import { adapterSnapshot, createRuntimeControlHandlers } from "./adapter.js";
import { startRunControlServer } from "./control.js";
import { RuntimeState } from "./state.js";

export async function runJsonlObserver(args: string[]): Promise<void> {
  const once = args.includes("--once");
  const rootIndex = args.indexOf("--sessions-root");
  const sessionsRoot = rootIndex >= 0 ? required(args[rootIndex + 1], "--sessions-root needs a path") : join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  const sessionIndex = args.indexOf("--session");
  const sessionId = sessionIndex >= 0 ? required(args[sessionIndex + 1], "--session needs an id") : undefined;

  const state = new RuntimeState("observed");
  const logPath = await eventLog();
  const adapter = new CodexJsonlAdapter({ sessionsRoot, cwd: process.cwd(), intervalMs: 500, sessionId });
  const record = (event: WatchdogEvent) => {
    state.apply(event);
    if (event.type === "agent.message.delta") return;
    void appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), mode: "jsonl-readonly", ...event })}\n`);
  };
  adapter.onEvent(record);
  await adapter.start();

  if (once) {
    await adapter.stop();
    console.log(JSON.stringify(adapterSnapshot(adapter, state), null, 2));
    return;
  }

  const control = await startRunControlServer(createRuntimeControlHandlers(adapter, state, record), adapter.descriptor, { startedAt: state.startedAt });
  console.log(`[watchdog] observing external Codex JSONL read-only: ${sessionsRoot}`);
  console.log(`[watchdog] run id: ${control.runId}`);
  console.log(`[watchdog] control snapshot: ${control.path}`);
  console.log(`[watchdog] normalized trace: ${logPath}`);

  await new Promise<void>((resolve) => {
    const close = () => resolve();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  await adapter.stop();
  await control.close();
}

async function eventLog(): Promise<string> {
  const directory = join(process.cwd(), ".watchdog", "runs");
  await mkdir(directory, { recursive: true });
  return join(directory, `observe-${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
}

function required(value: string | undefined, message: string): string { if (!value) throw new Error(message); return value; }
