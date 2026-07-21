import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  unavailable,
  type AdapterEventListener,
  type AdapterTarget,
  type HarnessAdapter,
  type RetryOptions,
} from "../adapters/types.js";
import type { WatchdogEvent } from "../adapters/events.js";
import { createReadOnlyControlHandlers } from "./adapter.js";
import { startRunControlServer } from "./control.js";
import { RuntimeState } from "./state.js";

type TraceEntry = { path: string; name: string; bytes: number; modifiedAt: string };

export async function listRunTraces(cwd = process.cwd()): Promise<TraceEntry[]> {
  const directory = join(resolve(cwd), ".watchdog", "runs");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const entries = await Promise.all(names
    .filter((name) => name.endsWith(".jsonl"))
    .map(async (name) => {
      const path = join(directory, name);
      const metadata = await stat(path);
      return { path, name, bytes: metadata.size, modifiedAt: metadata.mtime.toISOString() };
    }));
  return entries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

export async function runTraceReplay(args: string[]): Promise<void> {
  const harness = takeOption(args, "--harness");
  const requested = args.find((value) => !value.startsWith("--"));
  const path = requested && requested !== "latest"
    ? resolve(requested)
    : (await listRunTraces())[0]?.path;
  if (!path) throw new Error("No Watchdog traces found in .watchdog/runs.");

  const { state, inferredHarness, count } = await loadRunTrace(path);
  const adapter = new TraceReplayAdapter(harness ?? inferredHarness);
  const control = await startRunControlServer(
    createReadOnlyControlHandlers(adapter, state),
    adapter.descriptor,
    { startedAt: state.startedAt },
  );
  console.log(`[watchdog] replaying ${basename(path)} · ${count} events · read-only`);
  console.log(`[watchdog] run id: ${control.runId}`);
  console.log("[watchdog] open `watchdog dashboard` or target this run with `watchdog tui --run <id>`");
  await new Promise<void>((resolveDone) => {
    const close = () => resolveDone();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  await control.close();
}

export async function printRunTraces(limit?: number): Promise<void> {
  const traces = await listRunTraces();
  if (!traces.length) {
    console.log("No Watchdog traces found in .watchdog/runs.");
    return;
  }
  for (const trace of limit ? traces.slice(0, limit) : traces) {
    console.log(`${trace.modifiedAt}  ${formatBytes(trace.bytes).padStart(8)}  ${trace.name}`);
  }
  if (limit && traces.length > limit) {
    console.log(`… ${traces.length - limit} older traces; use \`watchdog traces --all\` to show everything.`);
  }
}

export async function loadRunTrace(path: string): Promise<{ state: RuntimeState; inferredHarness: string; count: number }> {
  const state = new RuntimeState("observed");
  const declaredExecutions = new Set<string>();
  const pendingExecutions = new Map<string, WatchdogEvent[]>();
  let inferredHarness = "codex";
  let count = 0;
  let index = 0;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    index += 1;
    if (!line.trim()) continue;
    let event: WatchdogEvent & { mode?: string };
    try {
      event = JSON.parse(line) as WatchdogEvent & { mode?: string };
      if (!event || typeof event !== "object" || typeof event.type !== "string") continue;
      const dependency = executionDependency(event);
      if (dependency && !declaredExecutions.has(dependency)) {
        const pending = [...(pendingExecutions.get(dependency) ?? []), event];
        if (pending.length > MAX_PENDING_EXECUTION_EVENTS) {
          throw new Error(`too many events arrived before execution '${dependency}' was declared`);
        }
        pendingExecutions.set(dependency, pending);
      } else {
        state.apply(event);
        if (event.type === "execution.declared") {
          declaredExecutions.add(event.graph.id);
          for (const pending of pendingExecutions.get(event.graph.id) ?? []) state.apply(pending);
          pendingExecutions.delete(event.graph.id);
        }
      }
      count += 1;
      inferredHarness = inferHarness(event, inferredHarness);
    } catch (error) {
      throw new Error(`Could not replay ${basename(path)} line ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!count) throw new Error(`Trace '${path}' contains no Watchdog events.`);
  if (pendingExecutions.size) {
    throw new Error(`Trace '${path}' references undeclared execution${pendingExecutions.size === 1 ? "" : "s"}: ${[...pendingExecutions.keys()].join(", ")}.`);
  }
  return { state, inferredHarness, count };
}

class TraceReplayAdapter implements HarnessAdapter {
  readonly descriptor;

  constructor(harness: string) {
    this.descriptor = {
      harness,
      transport: "trace-replay",
      mode: "observed" as const,
      label: `${harness} trace replay`,
    };
  }

  onEvent(_listener: AdapterEventListener): () => void { return () => undefined; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  capabilities(_target: AdapterTarget) {
    const readOnly = unavailable("Historical Watchdog traces are read-only.");
    return {
      observe: { available: true },
      steer: readOnly,
      followUp: readOnly,
      interrupt: readOnly,
      retry: readOnly,
      modelOverride: readOnly,
    };
  }
  async steer(): Promise<unknown> { throw new Error("Historical Watchdog traces are read-only."); }
  async followUp(): Promise<unknown> { throw new Error("Historical Watchdog traces are read-only."); }
  async interrupt(): Promise<unknown> { throw new Error("Historical Watchdog traces are read-only."); }
  async retry(_target: AdapterTarget, _options: RetryOptions): Promise<unknown> { throw new Error("Historical Watchdog traces are read-only."); }
}

function inferHarness(event: WatchdogEvent & { mode?: string }, fallback: string): string {
  const serialized = JSON.stringify(event);
  if (/pi-root-|Pi execution|pi-worker-/i.test(serialized)) return "pi";
  return fallback;
}

function executionDependency(event: WatchdogEvent): string | undefined {
  if (event.type === "execution.declared") return undefined;
  return "executionId" in event && typeof event.executionId === "string"
    ? event.executionId
    : undefined;
}

function takeOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} needs a value`);
  args.splice(index, 2);
  return value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const MAX_PENDING_EXECUTION_EVENTS = 10_000;
