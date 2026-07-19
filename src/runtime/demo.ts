import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WatchdogDemoAdapter } from "../demo/adapter.js";
import type { WatchdogEvent } from "../adapters/events.js";
import { runDashboard } from "../server/dashboard.js";
import { createRuntimeControlHandlers } from "./adapter.js";
import { startRunControlServer } from "./control.js";
import { RuntimeState } from "./state.js";

export async function runDeterministicDemo(args: string[], options: { openBrowser?: boolean } = {}): Promise<void> {
  const state = new RuntimeState();
  const adapter = new WatchdogDemoAdapter(state);
  const eventLog = await createEventLog();
  const record = (event: WatchdogEvent) => {
    state.apply(event);
    if (event.type === "agent.message.delta") return;
    void appendFile(eventLog, `${JSON.stringify({ at: new Date().toISOString(), mode: "simulation", ...event })}\n`);
  };
  adapter.onEvent(record);
  await adapter.start();
  const control = await startRunControlServer(createRuntimeControlHandlers(adapter, state, record), adapter.descriptor, { startedAt: state.startedAt });
  console.log("[watchdog] SIMULATION: deterministic rehearsal data; no Codex process is running");
  console.log(`[watchdog] demo run id: ${control.runId}`);
  console.log(`[watchdog] demo trace: ${eventLog}`);
  try {
    await runDashboard(args, { preferredView: "demo", openBrowser: options.openBrowser });
  } finally {
    await adapter.stop();
    await control.close();
  }
}

async function createEventLog(): Promise<string> {
  const directory = join(process.cwd(), ".watchdog", "runs");
  await mkdir(directory, { recursive: true });
  return join(directory, `demo-${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
}
