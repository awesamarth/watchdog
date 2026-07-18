#!/usr/bin/env node
import { runCodexWithWatchdog } from "./runtime/codex.js";
import { requestControl, type ControlRequest } from "./runtime/control.js";
import { listRegisteredRuns, unregisterRun } from "./runtime/registry.js";
import type { AgentState, RunSnapshot } from "./runtime/state.js";

const [, , command, ...args] = process.argv;

await main().catch((error: unknown) => {
  console.error(`[watchdog] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
if (command === "codex") {
  process.exitCode = await runCodexWithWatchdog(args);
} else if (command === "tui") {
  const { runTui } = await import("./tui/run.js");
  await runTui(takeRunId(args));
} else if (command === "dashboard") {
  const { runDashboard } = await import("./server/dashboard.js");
  await runDashboard(args);
} else if (command === "demo") {
  const { runDeterministicDemo } = await import("./runtime/demo.js");
  await runDeterministicDemo(args);
} else if (command === "doctor") {
  const { runDoctor } = await import("./runtime/doctor.js");
  await runDoctor();
} else if (command === "observe") {
  const { runJsonlObserver } = await import("./runtime/observe.js");
  await runJsonlObserver(args);
} else if (command === "runs") {
  await printRuns();
} else if (command === "ps") {
  printAgents(await snapshot(takeRunId(args)));
} else if (command === "tree") {
  printTree(await snapshot(takeRunId(args)));
} else if (command === "inspect") {
  const runId = takeRunId(args);
  const agent = resolveFromSnapshot(await snapshot(runId), required(args[0], "Usage: watchdog inspect <agent> [--run <id>]"));
  console.log(JSON.stringify(agent, null, 2));
} else if (command === "steer") {
  const runId = takeRunId(args);
  const [agent, ...message] = args;
  console.log(JSON.stringify(await requestControl({ action: "steer", agent: required(agent, "Usage: watchdog steer <agent> <message> [--run <id>]"), message: required(message.join(" "), "Usage: watchdog steer <agent> <message> [--run <id>]") }, { runId }), null, 2));
} else if (command === "stop") {
  const runId = takeRunId(args);
  console.log(JSON.stringify(await requestControl({ action: "interrupt", agent: required(args[0], "Usage: watchdog stop <agent> [--run <id>]") }, { runId }), null, 2));
} else if (command === "retry") {
  const runId = takeRunId(args);
  const retry = parseRetry(args);
  console.log(JSON.stringify(await requestControl({ action: "retry", ...retry }, { runId }), null, 2));
} else if (command === "loop") {
  await loopCommand(args, takeRunId(args));
} else {
  console.log(`Watchdog — local operator control plane for agentic loops and subagents

Usage:
  watchdog codex [any normal Codex arguments]
  watchdog tui [--run <id>]
  watchdog dashboard [--port <port>]
  watchdog demo [--port <port>]
  watchdog doctor
  watchdog runs
  watchdog observe [--once] [--session <id>] [--sessions-root <path>]
  watchdog ps | tree | inspect <agent> [--run <id>]
  watchdog steer <root|agent> <message> [--run <id>]
  watchdog stop <root|agent> [--run <id>]
  watchdog retry <root-agent> [--model <model>] [--effort <effort>] <message> [--run <id>]
  watchdog loop set <agent> [options] [--run <id>]
  watchdog loop evidence <agent> <summary> [--run <id>]
  watchdog loop verify <agent> <pass|fail> [summary] [--run <id>]

Examples:
  watchdog codex
  watchdog demo
  watchdog doctor
  watchdog codex "Use two subagents to inspect this repository."
  watchdog codex --model gpt-5.6-terra

Run watchdog codex in one terminal, then use watchdog tui or the
operator commands above from another terminal in the same project.
watchdog demo is a clearly labeled local simulation for rehearsals.`);
  process.exitCode = command ? 1 : 0;
}
}

async function snapshot(runId?: string): Promise<RunSnapshot> { return await requestControl({ action: "snapshot" }, { runId }) as RunSnapshot; }
function required(value: string | undefined, message: string): string { if (!value) throw new Error(message); return value; }
function resolveFromSnapshot(snapshot: RunSnapshot, target: string): AgentState {
  const needle = target.toLowerCase();
  const matches = snapshot.agents.filter((agent) => agent.threadId.toLowerCase().startsWith(needle) || agent.nickname?.toLowerCase() === needle || agent.agentPath?.toLowerCase() === needle);
  if (matches.length === 1) return matches[0]!;
  throw new Error(matches.length ? `Agent '${target}' is ambiguous` : `No agent matches '${target}'`);
}
function printAgents(snapshot: RunSnapshot): void {
  for (const agent of snapshot.agents) console.log(`${agent.threadId.slice(0, 8)}  ${(agent.nickname ?? agent.agentPath ?? "root").padEnd(14)} ${(agent.activeTurnId ? "working" : agent.status).padEnd(10)} ${agent.totalTokens ?? "—"} tokens`);
}
function printTree(snapshot: RunSnapshot): void {
  const byParent = new Map<string | undefined, AgentState[]>();
  for (const agent of snapshot.agents) byParent.set(agent.parentThreadId, [...(byParent.get(agent.parentThreadId) ?? []), agent]);
  const print = (parent: string | undefined, depth: number) => {
    for (const agent of byParent.get(parent) ?? []) {
      console.log(`${"  ".repeat(depth)}${depth ? "└─ " : ""}${agent.nickname ?? agent.agentPath ?? agent.threadId.slice(0, 8)} (${agent.activeTurnId ? "working" : agent.status})`);
      print(agent.threadId, depth + 1);
    }
  };
  print(undefined, 0);
}
async function printRuns(): Promise<void> {
  const records = await listRegisteredRuns();
  const active = [];
  for (const record of records) {
    try {
      const snapshot = await requestControl({ action: "snapshot" }, { socketPath: record.socketPath }) as RunSnapshot;
      active.push({ record, snapshot });
    } catch {
      await unregisterRun(record.runId);
    }
  }
  if (active.length === 0) {
    console.log("No active Watchdog runs.");
    return;
  }
  for (const { record, snapshot } of active) {
    const adapter = snapshot.adapter ?? record.adapter;
    const activeAgents = snapshot.agents.filter((agent) => agent.activeTurnId).length;
    console.log(`${record.runId}  ${adapter.harness.padEnd(13)} ${record.projectName.padEnd(18)} ${activeAgents}/${snapshot.agents.length} agents  ${record.cwd}`);
  }
}
function takeRunId(values: string[]): string | undefined {
  const index = values.indexOf("--run");
  if (index < 0) return undefined;
  const value = required(values[index + 1], "--run needs an id");
  values.splice(index, 2);
  return value;
}
function parseRetry(values: string[]): { agent: string; message: string; model?: string; effort?: string } {
  const agent = required(values.shift(), "Usage: watchdog retry <agent> [--model <model>] [--effort <effort>] <message>");
  let model: string | undefined;
  let effort: string | undefined;
  while (values[0]?.startsWith("--")) {
    const flag = values.shift();
    const value = required(values.shift(), `${flag} needs a value`);
    if (flag === "--model") model = value;
    else if (flag === "--effort") effort = value;
    else throw new Error(`Unknown retry flag ${flag}`);
  }
  return { agent, model, effort, message: required(values.join(" "), "A retry message is required") };
}

async function loopCommand(values: string[], runId?: string): Promise<void> {
  const subcommand = required(values.shift(), "Usage: watchdog loop <set|evidence|verify> ...");
  const agent = required(values.shift(), `Usage: watchdog loop ${subcommand} <agent> ...`);
  if (subcommand === "evidence") {
    const summary = required(values.join(" "), "Usage: watchdog loop evidence <agent> <summary>");
    console.log(JSON.stringify(await requestControl({ action: "loop.evidence", agent, summary }, { runId }), null, 2));
    return;
  }
  if (subcommand === "verify") {
    const raw = required(values.shift(), "Usage: watchdog loop verify <agent> <pass|fail> [summary]");
    if (raw !== "pass" && raw !== "fail") throw new Error("Verification status must be pass or fail");
    console.log(JSON.stringify(await requestControl({ action: "loop.verify", agent, status: raw === "pass" ? "passed" : "failed", summary: values.join(" ") || undefined }, { runId }), null, 2));
    return;
  }
  if (subcommand !== "set") throw new Error(`Unknown loop command '${subcommand}'`);
  const request: Extract<ControlRequest, { action: "loop.configure" }> = { action: "loop.configure", agent };
  while (values.length) {
    const flag = required(values.shift(), "Loop option expected");
    const value = required(values.shift(), `${flag} needs a value`);
    if (flag === "--goal") request.objective = value;
    else if (flag === "--verifier") request.verifier = value;
    else if (flag === "--token-budget") request.maxTokens = positiveInteger(value, flag);
    else if (flag === "--max-iterations") request.maxIterations = positiveInteger(value, flag);
    else throw new Error(`Unknown loop option ${flag}`);
  }
  console.log(JSON.stringify(await requestControl(request, { runId }), null, 2));
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}
