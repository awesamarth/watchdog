#!/usr/bin/env node
import { runCodexWithWatchdog } from "./runtime/codex.js";
import { requestControl, type ControlRequest } from "./runtime/control.js";
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
  await runTui();
} else if (command === "dashboard") {
  const { runDashboard } = await import("./server/dashboard.js");
  await runDashboard(args);
} else if (command === "observe") {
  const { runJsonlObserver } = await import("./runtime/observe.js");
  await runJsonlObserver(args);
} else if (command === "ps") {
  printAgents(await snapshot());
} else if (command === "tree") {
  printTree(await snapshot());
} else if (command === "inspect") {
  const agent = resolveFromSnapshot(await snapshot(), required(args[0], "Usage: watchdog inspect <agent>"));
  console.log(JSON.stringify(agent, null, 2));
} else if (command === "steer") {
  const [agent, ...message] = args;
  console.log(JSON.stringify(await requestControl({ action: "steer", agent: required(agent, "Usage: watchdog steer <agent> <message>"), message: required(message.join(" "), "Usage: watchdog steer <agent> <message>") }), null, 2));
} else if (command === "stop") {
  console.log(JSON.stringify(await requestControl({ action: "interrupt", agent: required(args[0], "Usage: watchdog stop <agent>") }), null, 2));
} else if (command === "retry") {
  const retry = parseRetry(args);
  console.log(JSON.stringify(await requestControl({ action: "retry", ...retry }), null, 2));
} else if (command === "loop") {
  await loopCommand(args);
} else {
  console.log(`Watchdog — local operator control plane for agentic loops and subagents

Usage:
  watchdog codex [any normal Codex arguments]
  watchdog tui
  watchdog dashboard [--port <port>]
  watchdog observe [--once] [--session <id>] [--sessions-root <path>]
  watchdog ps | tree | inspect <agent>
  watchdog steer <root|agent> <message>
  watchdog stop <root|agent>
  watchdog retry <root-agent> [--model <model>] [--effort <effort>] <message>
  watchdog loop set <agent> [--goal <text>] [--verifier <text>] [--token-budget <n>] [--max-iterations <n>]
  watchdog loop evidence <agent> <summary>
  watchdog loop verify <agent> <pass|fail> [summary]

Examples:
  watchdog codex
  watchdog codex "Use two subagents to inspect this repository."
  watchdog codex --model gpt-5.6-terra

Run watchdog codex in one terminal, then use watchdog tui or the
operator commands above from another terminal in the same project.`);
  process.exitCode = command ? 1 : 0;
}
}

async function snapshot(): Promise<RunSnapshot> { return await requestControl({ action: "snapshot" }) as RunSnapshot; }
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

async function loopCommand(values: string[]): Promise<void> {
  const subcommand = required(values.shift(), "Usage: watchdog loop <set|evidence|verify> ...");
  const agent = required(values.shift(), `Usage: watchdog loop ${subcommand} <agent> ...`);
  if (subcommand === "evidence") {
    const summary = required(values.join(" "), "Usage: watchdog loop evidence <agent> <summary>");
    console.log(JSON.stringify(await requestControl({ action: "loop.evidence", agent, summary }), null, 2));
    return;
  }
  if (subcommand === "verify") {
    const raw = required(values.shift(), "Usage: watchdog loop verify <agent> <pass|fail> [summary]");
    if (raw !== "pass" && raw !== "fail") throw new Error("Verification status must be pass or fail");
    console.log(JSON.stringify(await requestControl({ action: "loop.verify", agent, status: raw === "pass" ? "passed" : "failed", summary: values.join(" ") || undefined }), null, 2));
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
  console.log(JSON.stringify(await requestControl(request), null, 2));
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}
