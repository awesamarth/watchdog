import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { AgentCapabilities } from "../adapters/types.js";
import { requestControl } from "../runtime/control.js";
import type { ExecutionGraphState } from "../execution/types.js";
import type { AgentState, RunSnapshot } from "../runtime/state.js";

type Mode = "normal" | "steer" | "followUp" | "retry" | "nodeRetry";
type PaneFocus = "tree" | "inspector";
type InspectorLine = { text: string; tone?: "heading" | "section" | "dim" | "live" };

export function WatchdogTui({ runId }: { runId?: string }): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState<RunSnapshot>({ startedAt: "", mode: "live", agents: [], loops: [], executions: [] });
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("normal");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("Connecting to Watchdog…");
  const [paneFocus, setPaneFocus] = useState<PaneFocus>("tree");
  const [inspectorScroll, setInspectorScroll] = useState(0);

  const agents = useMemo(() => ordered(snapshot.agents), [snapshot]);
  const current = agents[Math.min(selected, Math.max(agents.length - 1, 0))];
  const capabilities = current ? snapshot.capabilities?.[current.threadId] : undefined;
  const columns = stdout.columns ?? 100;
  const rows = stdout.rows ?? 30;
  const controllable = snapshot.mode === "live";
  const harness = harnessName(snapshot);
  const contentWidth = Math.max(40, columns - 2);
  const treePanelWidth = Math.max(24, Math.floor((contentWidth - 1) * 0.4));
  const inspectorPanelWidth = Math.max(30, contentWidth - 1 - treePanelWidth);
  const loop = snapshot.loops[0];
  const execution = primaryExecution(snapshot);
  const currentExecution = current ? executionForAgent(snapshot, current) : undefined;
  const executionCapabilities = currentExecution ? snapshot.executionCapabilities?.[currentExecution.id] : undefined;
  const currentNodeId = currentExecution
    ? current?.execution?.executionId === currentExecution.id
      ? current.execution.nodeId
      : currentExecution.activeNodeIds[0] ?? [...currentExecution.activations].reverse()[0]?.nodeId
    : undefined;
  const nodeCapabilities = currentNodeId ? executionCapabilities?.nodes[currentNodeId] : undefined;
  const summaryWarnings = execution?.authority !== "legacy" ? execution?.warnings ?? [] : loop?.warnings ?? [];
  const summaryWarningRows = Math.min(summaryWarnings.length, 2) + (summaryWarnings.length > 2 ? 1 : 0);
  const summaryBlockHeight = execution?.authority !== "legacy"
    ? execution ? 7 + summaryWarningRows : 0
    : loop ? 7 + summaryWarningRows : 0;
  const mainHeight = Math.max(8, rows - 5 - summaryBlockHeight);
  const inspectorHeight = Math.max(4, mainHeight - 3);
  const inspectorWidth = Math.max(20, inspectorPanelWidth - 4);
  const inspectorLines = useMemo(() => current ? buildInspectorLines(current, inspectorWidth) : [], [current, inspectorWidth]);
  const maxInspectorScroll = Math.max(0, inspectorLines.length - inspectorHeight);
  const visibleInspectorScroll = Math.min(inspectorScroll, maxInspectorScroll);
  const pageStep = inspectorPageStep(inspectorHeight);
  const controls = availableControlHints(capabilities);
  if (executionCapabilities?.stop.available) controls.push("X stop execution");
  if (nodeCapabilities?.stop.available) controls.push("d stop node");
  if (nodeCapabilities?.retry.available) controls.push("n retry node");
  const controlHelp = controls.length ? ` · ${controls.join(" · ")}` : "";

  useEffect(() => {
    setInspectorScroll((value) => Math.min(value, maxInspectorScroll));
  }, [maxInspectorScroll]);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const next = await requestControl({ action: "snapshot" }, { runId }) as RunSnapshot;
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
  }, [runId]);

  useInput((input, key) => {
    if (mode !== "normal") {
      if (key.escape) { setMode("normal"); setDraft(""); return; }
      if (key.return) {
        if (!current || !draft.trim()) return;
        const request = mode === "steer"
          ? { action: "steer" as const, agent: current.threadId, message: draft }
          : mode === "followUp"
            ? { action: "followUp" as const, agent: current.threadId, message: draft }
            : mode === "nodeRetry" && currentExecution && currentNodeId
              ? { action: "execution.node.retry" as const, executionId: currentExecution.id, nodeId: currentNodeId, message: draft }
              : { action: "retry" as const, agent: current.threadId, message: draft };
        const verb = mode === "steer" ? "Steered" : mode === "followUp" ? "Queued follow-up for" : mode === "nodeRetry" ? "Retried node for" : "Retried";
        void requestControl(request, { runId }).then(() => setNotice(`${verb} ${agentName(current)}`), (reason: Error) => setNotice(`Action failed: ${reason.message}`));
        setMode("normal"); setDraft("");
        return;
      }
      if (key.backspace || key.delete) { setDraft((value) => value.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && input) setDraft((value) => value + input);
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) { exit(); return; }
    if (key.tab) { setPaneFocus((value) => value === "tree" ? "inspector" : "tree"); return; }
    if (key.rightArrow) { setPaneFocus("inspector"); return; }
    if (key.leftArrow || (key.escape && paneFocus === "inspector")) { setPaneFocus("tree"); return; }
    if (paneFocus === "tree") {
      if (input === "j" || key.downArrow) {
        setSelected((value) => Math.min(value + 1, Math.max(agents.length - 1, 0)));
        setInspectorScroll(0);
        return;
      }
      if (input === "k" || key.upArrow) {
        setSelected((value) => Math.max(value - 1, 0));
        setInspectorScroll(0);
        return;
      }
      if (key.home) { setSelected(0); setInspectorScroll(0); return; }
      if (key.end) { setSelected(Math.max(agents.length - 1, 0)); setInspectorScroll(0); return; }
    } else {
      if (input === "j" || key.downArrow) { setInspectorScroll((value) => Math.min(value + 1, maxInspectorScroll)); return; }
      if (input === "k" || key.upArrow) { setInspectorScroll((value) => Math.max(value - 1, 0)); return; }
      if (key.pageDown) { setInspectorScroll((value) => Math.min(value + pageStep, maxInspectorScroll)); return; }
      if (key.pageUp) { setInspectorScroll((value) => Math.max(value - pageStep, 0)); return; }
      if (key.home) { setInspectorScroll(0); return; }
      if (key.end) { setInspectorScroll(maxInspectorScroll); return; }
    }
    if (!controllable && ["s", "f", "r", "x", "X", "d", "n"].includes(input)) { setNotice("Observed and historical sessions are read-only; relaunch through Watchdog for controls"); return; }
    if (input === "s" && current && (capabilities?.steer.available ?? (Boolean(current.activeTurnId) && !current.parentThreadId))) { setMode("steer"); return; }
    if (input === "s" && current) { setNotice(capabilities?.steer.reason ?? "This adapter cannot steer the selected agent"); return; }
    if (input === "f" && current && capabilities?.followUp.available) { setMode("followUp"); return; }
    if (input === "f" && current) { setNotice(capabilities?.followUp.reason ?? "This adapter cannot queue a follow-up for the selected agent"); return; }
    if (input === "r" && current && (capabilities?.retry.available ?? !current.parentThreadId)) { setMode("retry"); return; }
    if (input === "r" && current) { setNotice(capabilities?.retry.reason ?? "This adapter cannot retry the selected agent"); return; }
    if (input === "n" && current && currentExecution && currentNodeId && nodeCapabilities?.retry.available) { setMode("nodeRetry"); return; }
    if (input === "n" && currentExecution && currentNodeId) { setNotice(nodeCapabilities?.retry.reason ?? "This execution node cannot be retried"); return; }
    if (input === "d" && currentExecution && currentNodeId && nodeCapabilities?.stop.available) {
      void requestControl({ action: "execution.stop", executionId: currentExecution.id, nodeId: currentNodeId, reason: "Node stopped from the Watchdog TUI." }, { runId })
        .then(() => setNotice(`Stopped node ${currentNodeId}`), (reason: Error) => setNotice(`Action failed: ${reason.message}`));
      return;
    }
    if (input === "d" && currentExecution && currentNodeId) { setNotice(nodeCapabilities?.stop.reason ?? "This execution node cannot be stopped"); return; }
    if (input === "X" && currentExecution && executionCapabilities?.stop.available) {
      void requestControl({ action: "execution.stop", executionId: currentExecution.id, reason: "Execution stopped from the Watchdog TUI." }, { runId })
        .then(() => setNotice(`Stopped execution ${currentExecution.label ?? currentExecution.id}`), (reason: Error) => setNotice(`Action failed: ${reason.message}`));
      return;
    }
    if (input === "X" && currentExecution) { setNotice(executionCapabilities?.stop.reason ?? "This execution cannot be stopped"); return; }
    if (input === "x" && current?.activeTurnId) {
      if (capabilities && !capabilities.interrupt.available) { setNotice(capabilities.interrupt.reason ?? "This adapter cannot stop the selected agent"); return; }
      void requestControl({ action: "interrupt", agent: current.threadId }, { runId }).then((result) => {
        const notification = result as { parentNotified?: boolean; rootNotified?: boolean; directParent?: string };
        setNotice(notification.parentNotified
          ? `Stopped ${agentName(current)} · parent notified`
          : notification.rootNotified
            ? `Stopped ${agentName(current)} · root notified; ${notification.directParent ?? "direct parent"} cannot be steered`
            : `Stopped ${agentName(current)}`);
      }, (reason: Error) => setNotice(`Interrupt failed: ${reason.message}`));
    }
  });

  if (error) return <Box borderStyle="round" borderColor="red" padding={1}><Text color="red">{error}</Text></Box>;

  return <Box flexDirection="column" paddingX={1} width={columns} height={rows} overflow="hidden">
    <Box justifyContent="space-between"><Text bold color="yellow">WATCHDOG · {harness}</Text><Text dimColor>SUBAGENTS · LOOPS · EXECUTION GRAPHS</Text></Box>
    <Box marginTop={1} gap={1} height={mainHeight} flexShrink={0}>
      <Box width={treePanelWidth} borderStyle="round" borderColor={paneFocus === "tree" ? "yellow" : "gray"} flexDirection="column" paddingX={1} overflow="hidden">
        <Text bold color={paneFocus === "tree" ? "yellow" : undefined}>RUN TREE</Text>
        {agents.length === 0 ? <Text dimColor>Waiting for {harness} threads…</Text> : agents.map((agent, index) => <AgentRow key={agent.threadId} agent={agent} depth={agentDepth(agent, snapshot.agents)} selected={index === selected} />)}
      </Box>
      <Box width={inspectorPanelWidth} borderStyle="round" borderColor={paneFocus === "inspector" ? "yellow" : "gray"} flexDirection="column" paddingX={1} overflow="hidden">
        <Box justifyContent="space-between">
          <Text bold color={paneFocus === "inspector" ? "yellow" : undefined}>INSPECT</Text>
          {inspectorLines.length > inspectorHeight && <Text dimColor>{visibleInspectorScroll + 1}–{Math.min(visibleInspectorScroll + inspectorHeight, inspectorLines.length)}/{inspectorLines.length}</Text>}
        </Box>
        {current
          ? <Inspector lines={inspectorLines} offset={visibleInspectorScroll} height={inspectorHeight} />
          : <Text dimColor>No agent selected.</Text>}
      </Box>
    </Box>
    <ExecutionSummary snapshot={snapshot} />
    <Box marginTop={1} height={2} flexShrink={0} flexDirection="column" overflow="hidden">
      <Text wrap="truncate-end" color={notice.startsWith("Action failed") || notice.startsWith("Interrupt failed") ? "red" : "green"}>{notice || " "}</Text>
      {mode === "normal"
        ? <Text wrap="truncate-end" dimColor>{paneFocus === "tree"
          ? `TREE · ↑/↓ or j/k select agent · Tab/→ inspect${controllable ? controlHelp : " · read-only"} · q quit`
          : `INSPECT · ↑/↓ or j/k scroll · PgUp/PgDn half-page · Tab/← tree${controllable ? controlHelp : " · read-only"} · q quit`}</Text>
        : <Text wrap="truncate-end" color="cyan">{mode === "steer" ? "Steer" : mode === "followUp" ? "Follow up" : mode === "nodeRetry" ? "Retry node" : "Retry"}: {draft}█  (Enter send, Esc cancel)</Text>}
    </Box>
  </Box>;
}

function LoopSummary({ snapshot }: { snapshot: RunSnapshot }): React.JSX.Element | null {
  const loop = snapshot.loops[0];
  if (!loop) return null;
  const warnings = loop.warnings.slice(0, 2);
  return <Box marginTop={1} borderStyle="round" borderColor={loop.warnings.length ? "yellow" : "gray"} paddingX={1} flexDirection="column" flexShrink={0}>
    <Text wrap="truncate-end" bold>LOOP · iteration {loop.iteration} · {loop.activeTurnId ? "running" : "idle"}</Text>
    <Text wrap="truncate-end">Goal: {loop.objective ?? "waiting for the first user turn"}</Text>
    <Text wrap="truncate-end" dimColor>Phase: {loop.phase} · Verifier: {loop.verifier ?? "not declared"} · Verification: {loop.verification.status}</Text>
    <Text wrap="truncate-end" dimColor>Evidence: {loop.evidence.length} · Budget: {formatTokens(loop.budget.usedTokens)}/{formatTokens(loop.budget.maxTokens)} tokens · {loop.iteration}/{loop.budget.maxIterations ?? "∞"} iterations</Text>
    {warnings.map((warning) => <Text wrap="truncate-end" key={warning} color="yellow">⚠ {warning}</Text>)}
    {loop.warnings.length > warnings.length && <Text wrap="truncate-end" color="yellow">⚠ +{loop.warnings.length - warnings.length} more warnings</Text>}
  </Box>;
}

function ExecutionSummary({ snapshot }: { snapshot: RunSnapshot }): React.JSX.Element | null {
  const execution = primaryExecution(snapshot);
  if (!execution) return <LoopSummary snapshot={snapshot} />;
  if (execution.authority === "legacy") return <LoopSummary snapshot={snapshot} />;
  const warnings = execution.warnings.slice(0, 2);
  const nodes = execution.nodes.map((node) => {
    const active = execution.activeNodeIds.includes(node.id);
    return active ? `[${node.label}]` : node.label;
  }).join(" → ");
  return <Box marginTop={1} borderStyle="round" borderColor={execution.warnings.length || ["failed", "blocked"].includes(execution.status) ? "yellow" : "gray"} paddingX={1} flexDirection="column" flexShrink={0}>
    <Text wrap="truncate-end" bold>EXECUTION · {execution.label ?? execution.id} · iteration {execution.iteration || "—"} · {execution.incompleteReason ? "incomplete" : execution.status}</Text>
    <Text wrap="truncate-end">Goal: {execution.objective ?? "not declared"}</Text>
    <Text wrap="truncate-end" dimColor>Nodes: {nodes}</Text>
    <Text wrap="truncate-end" dimColor>Source: {execution.source.label ?? execution.source.kind} · {execution.authority} · {execution.traversals.length} transitions</Text>
    <Text wrap="truncate-end" dimColor>Verifier: {execution.policy?.verifier ?? (execution.nodes.some((node) => node.kind === "verifier") ? "graph node" : "not declared")} · {execution.verification.status} · Evidence: {execution.evidence.length} · Budget: {formatTokens(execution.usedTokens)}/{formatTokens(execution.policy?.maxTokens)} tokens</Text>
    {warnings.map((warning) => <Text wrap="truncate-end" key={warning} color="yellow">⚠ {warning}</Text>)}
    {execution.warnings.length > warnings.length && <Text wrap="truncate-end" color="yellow">⚠ +{execution.warnings.length - warnings.length} more warnings</Text>}
  </Box>;
}

function AgentRow({ agent, depth, selected }: { agent: AgentState; depth: number; selected: boolean }): React.JSX.Element {
  const prefix = depth ? `${"  ".repeat(Math.max(0, depth - 1))}└─` : "●";
  const state = agent.activeTurnId ? "working" : agent.status;
  return <Text inverse={selected} color={agent.activeTurnId ? "green" : undefined}>{prefix} {agentName(agent)} <Text dimColor> {state} · {formatTokens(agent.totalTokens)}</Text></Text>;
}

function Inspector({ lines, offset, height }: { lines: InspectorLine[]; offset: number; height: number }): React.JSX.Element {
  return <Box flexDirection="column" height={height} overflow="hidden">
    {lines.slice(offset, offset + height).map((line, index) => <InspectorText key={`${offset + index}:${line.text}`} line={line} />)}
  </Box>;
}

function InspectorText({ line }: { line: InspectorLine }): React.JSX.Element {
  if (line.tone === "heading") return <Text bold color="cyan">{line.text || " "}</Text>;
  if (line.tone === "section") return <Text bold>{line.text || " "}</Text>;
  if (line.tone === "live") return <Text color="yellow">{line.text || " "}</Text>;
  if (line.tone === "dim") return <Text dimColor>{line.text || " "}</Text>;
  return <Text>{line.text || " "}</Text>;
}

export function buildInspectorLines(agent: AgentState, width: number): InspectorLine[] {
  const lines: InspectorLine[] = [];
  const add = (text: string, tone?: InspectorLine["tone"]) => {
    for (const line of wrapInspectorText(text, width)) lines.push({ text: line, tone });
  };
  const section = (title: string, text: string, tone?: InspectorLine["tone"]) => {
    if (lines.length) lines.push({ text: "" });
    add(title, tone ?? "section");
    add(text, tone === "live" ? "live" : undefined);
  };

  add(agentName(agent), "heading");
  add(agent.threadId, "dim");
  add(`Status: ${agent.activeTurnId ? "working" : agent.status}`);
  if (agent.kind) add(`Type: ${agent.kind}`);
  add(`Tokens: ${formatTokens(agent.totalTokens)} total · ${formatTokens(agent.inputTokens)} input · ${formatTokens(agent.outputTokens)} output`);
  if (agent.costUsd !== undefined) add(`Cost: $${agent.costUsd.toFixed(4)}`);
  const assignment = agent.task ?? agent.requested?.prompt;
  if (assignment) section(agent.parentThreadId ? "Assignment" : "Task", assignment);
  else if (agent.parentThreadId) section("Assignment", "Assignment text unavailable from the harness.", "dim");
  section("Requested", config(agent.requested));
  section("Effective", config(agent.effective));
  if (agent.latestActivity) section("Latest activity", `${agent.latestActivity.tool} · ${agent.latestActivity.status}`);
  const recentActivities = [...(agent.activities ?? [])].reverse().slice(1, 5);
  if (recentActivities.length) section("Recent activity", recentActivities.map((activity) => `• ${activity.tool} · ${activity.status}`).join("\n"));
  if (agent.execution) section("Execution", `${agent.execution.executionId} · node ${agent.execution.nodeId} · activation ${agent.execution.activationId}`);
  if (agent.streamingMessage) section("Live response", `${agent.streamingMessage.text}▋`, "live");

  const messages = [...(agent.messages ?? [])].reverse();
  if (messages.length) {
    if (lines.length) lines.push({ text: "" });
    const total = agent.messageCount ?? messages.length;
    const retained = total > messages.length ? ` · ${messages.length} retained` : "";
    add(`Messages (${total} total${retained} · newest first)`, "section");
    for (const message of messages) add(`• ${message.text}`, "dim");
  }
  return lines;
}

export function wrapInspectorText(text: string, width: number): string[] {
  const lineWidth = Math.max(1, Math.floor(width));
  const output: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    if (!paragraph) {
      output.push("");
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > lineWidth) {
      let splitAt = remaining.lastIndexOf(" ", lineWidth);
      if (splitAt < 1) splitAt = lineWidth;
      output.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }
    output.push(remaining);
  }
  return output;
}

export function inspectorPageStep(viewportHeight: number): number {
  return Math.max(1, Math.floor(viewportHeight / 2));
}

export function availableControlHints(capabilities?: AgentCapabilities): string[] {
  if (!capabilities) return [];
  const hints: string[] = [];
  if (capabilities.steer.available) hints.push("s steer");
  if (capabilities.followUp.available) hints.push("f follow-up");
  if (capabilities.interrupt.available) hints.push("x stop");
  if (capabilities.retry.available) hints.push("r retry");
  return hints;
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
function harnessName(snapshot: RunSnapshot): string {
  const harness = snapshot.adapter?.harness;
  if (!harness) return "CONNECTING";
  return harness.replace(/[-_]+/g, " ").toUpperCase();
}

function primaryExecution(snapshot: RunSnapshot): ExecutionGraphState | undefined {
  const rank = { suspected: 0, legacy: 1, declared: 2, authoritative: 3 };
  return snapshot.executions
    .filter((execution) => !execution.parentExecutionId)
    .sort((left, right) => {
      const activeDifference = Number(["running", "waiting", "blocked"].includes(right.status))
        - Number(["running", "waiting", "blocked"].includes(left.status));
      return activeDifference || rank[right.authority] - rank[left.authority];
    })[0];
}

function executionForAgent(snapshot: RunSnapshot, agent: AgentState): ExecutionGraphState | undefined {
  if (agent.execution) return snapshot.executions.find((execution) => execution.id === agent.execution?.executionId);
  return [...snapshot.executions].reverse().find((execution) =>
    execution.ownerThreadId === agent.threadId
    || execution.activations.some((activation) => activation.threadIds.includes(agent.threadId)),
  );
}
