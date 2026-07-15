import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { requestControl } from "../runtime/control.js";
import type { AgentState, RunSnapshot } from "../runtime/state.js";

type Mode = "normal" | "steer" | "retry";

export function WatchdogTui(): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState<RunSnapshot>({ startedAt: "", mode: "live", agents: [], loops: [] });
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("normal");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("Connecting to Watchdog…");

  const agents = useMemo(() => ordered(snapshot.agents), [snapshot]);
  const current = agents[Math.min(selected, Math.max(agents.length - 1, 0))];
  const capabilities = current ? snapshot.capabilities?.[current.threadId] : undefined;
  const columns = stdout.columns ?? 100;
  const controllable = snapshot.mode === "live";

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const next = await requestControl({ action: "snapshot" }) as RunSnapshot;
        if (!alive) return;
        setSnapshot(next);
        setError(undefined);
        setNotice("");
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 500);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useInput((input, key) => {
    if (mode !== "normal") {
      if (key.escape) { setMode("normal"); setDraft(""); return; }
      if (key.return) {
        if (!current || !draft.trim()) return;
        const request = mode === "steer"
          ? { action: "steer" as const, agent: current.threadId, message: draft }
          : { action: "retry" as const, agent: current.threadId, message: draft };
        void requestControl(request).then(() => setNotice(`${mode === "steer" ? "Steered" : "Retried"} ${agentName(current)}`), (reason: Error) => setNotice(`Action failed: ${reason.message}`));
        setMode("normal"); setDraft("");
        return;
      }
      if (key.backspace || key.delete) { setDraft((value) => value.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && input) setDraft((value) => value + input);
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) { exit(); return; }
    if (input === "j" || key.downArrow) { setSelected((value) => Math.min(value + 1, Math.max(agents.length - 1, 0))); return; }
    if (input === "k" || key.upArrow) { setSelected((value) => Math.max(value - 1, 0)); return; }
    if (!controllable && ["s", "r", "x"].includes(input)) { setNotice("Observed JSONL sessions are read-only; relaunch with watchdog codex for controls"); return; }
    if (input === "s" && current && (capabilities?.steer.available ?? (Boolean(current.activeTurnId) && !current.parentThreadId))) { setMode("steer"); return; }
    if (input === "s" && current) { setNotice(capabilities?.steer.reason ?? "This adapter cannot steer the selected agent"); return; }
    if (input === "r" && current && (capabilities?.retry.available ?? !current.parentThreadId)) { setMode("retry"); return; }
    if (input === "r" && current) { setNotice(capabilities?.retry.reason ?? "This adapter cannot retry the selected agent"); return; }
    if (input === "x" && current?.activeTurnId) {
      if (capabilities && !capabilities.interrupt.available) { setNotice(capabilities.interrupt.reason ?? "This adapter cannot stop the selected agent"); return; }
      void requestControl({ action: "interrupt", agent: current.threadId }).then((result) => {
        const parentNotified = Boolean((result as { parentNotified?: boolean }).parentNotified);
        setNotice(parentNotified ? `Stopped ${agentName(current)} · parent notified` : `Stopped ${agentName(current)}`);
      }, (reason: Error) => setNotice(`Interrupt failed: ${reason.message}`));
    }
  });

  if (error) return <Box borderStyle="round" borderColor="red" padding={1}><Text color="red">{error}</Text></Box>;

  return <Box flexDirection="column" paddingX={1} width={columns}>
    <Box justifyContent="space-between"><Text bold color="yellow">WATCHDOG</Text><Text dimColor>loop-first agent control plane</Text></Box>
    <Box marginTop={1} gap={1} flexGrow={1}>
      <Box width="42%" borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
        <Text bold>RUN TREE</Text>
        {agents.length === 0 ? <Text dimColor>Waiting for Codex threads…</Text> : agents.map((agent, index) => <AgentRow key={agent.threadId} agent={agent} depth={agentDepth(agent, snapshot.agents)} selected={index === selected} />)}
      </Box>
      <Box width="58%" borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
        <Text bold>INSPECT</Text>
        {current ? <Inspector agent={current} /> : <Text dimColor>No agent selected.</Text>}
      </Box>
    </Box>
    <LoopSummary snapshot={snapshot} />
    <Box marginTop={1} justifyContent="space-between">
      <Text color={notice.startsWith("Action failed") || notice.startsWith("Interrupt failed") ? "red" : "green"}>{notice}</Text>
      {mode === "normal"
        ? <Text dimColor>{controllable ? "j/k select · s steer root · x stop · r retry root · q quit" : "j/k select · observed JSONL read-only · q quit"}</Text>
        : <Text color="cyan">{mode === "steer" ? "Steer" : "Retry"}: {draft}█  (Enter send, Esc cancel)</Text>}
    </Box>
  </Box>;
}

function LoopSummary({ snapshot }: { snapshot: RunSnapshot }): React.JSX.Element | null {
  const loop = snapshot.loops[0];
  if (!loop) return null;
  return <Box marginTop={1} borderStyle="round" borderColor={loop.warnings.length ? "yellow" : "gray"} paddingX={1} flexDirection="column">
    <Text bold>LOOP · iteration {loop.iteration} · {loop.activeTurnId ? "running" : "idle"}</Text>
    <Text>Goal: {loop.objective ?? "waiting for the first user turn"}</Text>
    <Text dimColor>Phase: {loop.phase} · Verifier: {loop.verifier ?? "not declared"} · Verification: {loop.verification.status}</Text>
    <Text dimColor>Evidence: {loop.evidence.length} · Budget: {formatTokens(loop.budget.usedTokens)}/{formatTokens(loop.budget.maxTokens)} tokens · {loop.iteration}/{loop.budget.maxIterations ?? "∞"} iterations</Text>
    {loop.warnings.map((warning) => <Text key={warning} color="yellow">⚠ {warning}</Text>)}
  </Box>;
}

function AgentRow({ agent, depth, selected }: { agent: AgentState; depth: number; selected: boolean }): React.JSX.Element {
  const prefix = depth ? `${"  ".repeat(Math.max(0, depth - 1))}└─` : "●";
  const state = agent.activeTurnId ? "working" : agent.status;
  return <Text inverse={selected} color={agent.activeTurnId ? "green" : undefined}>{prefix} {agentName(agent)} <Text dimColor> {state} · {formatTokens(agent.totalTokens)}</Text></Text>;
}

function Inspector({ agent }: { agent: AgentState }): React.JSX.Element {
  return <Box flexDirection="column">
    <Text bold color="cyan">{agentName(agent)}</Text>
    <Text dimColor>{agent.threadId}</Text>
    <Text>Status: {agent.activeTurnId ? "working" : agent.status}</Text>
    <Text>Tokens: {formatTokens(agent.totalTokens)} total · {formatTokens(agent.outputTokens)} output</Text>
    <Box marginTop={1} flexDirection="column"><Text bold>Requested</Text><Text>{config(agent.requested)}</Text></Box>
    <Box marginTop={1} flexDirection="column"><Text bold>Effective</Text><Text>{config(agent.effective)}</Text></Box>
    {agent.latestActivity && <Box marginTop={1}><Text>Latest: {agent.latestActivity.tool} · {agent.latestActivity.status}</Text></Box>}
    {agent.requested?.prompt && <Box marginTop={1} flexDirection="column"><Text bold>Task</Text><Text wrap="wrap">{agent.requested.prompt}</Text></Box>}
  </Box>;
}

function ordered(agents: AgentState[]): AgentState[] {
  const byParent = new Map<string | undefined, AgentState[]>();
  for (const agent of agents) byParent.set(agent.parentThreadId, [...(byParent.get(agent.parentThreadId) ?? []), agent]);
  const output: AgentState[] = [];
  const seen = new Set<string>();
  const visit = (agent: AgentState) => {
    if (seen.has(agent.threadId)) return;
    seen.add(agent.threadId); output.push(agent);
    for (const child of byParent.get(agent.threadId) ?? []) visit(child);
  };
  for (const root of byParent.get(undefined) ?? []) visit(root);
  for (const agent of agents) visit(agent);
  return output;
}
function agentDepth(agent: AgentState, agents: AgentState[]): number {
  let depth = 0, parent = agent.parentThreadId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) { seen.add(parent); depth += 1; parent = agents.find((candidate) => candidate.threadId === parent)?.parentThreadId; }
  return depth;
}
function agentName(agent: AgentState): string { return agent.nickname ?? agent.agentPath ?? agent.threadId.slice(0, 8); }
function formatTokens(value?: number): string { return value === undefined ? "—" : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value); }
function config(value?: { model?: string; effort?: string }): string { return `${value?.model ?? "unknown model"} · ${value?.effort ?? "default effort"}`; }
