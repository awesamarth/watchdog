import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { harnessDisplayName, harnessSlug } from "./harness";
import { Reveal } from "./Reveal";
import { YardCanvas } from "./YardCanvas";
import { partitionYardChildren, primaryYardExecution } from "./yardMotion";
import type { AgentCapabilities, AgentState, DashboardState, ExecutionCapabilities, ExecutionGraphState, LoopState, RunSnapshot } from "./types";

type View = "yard" | "operator";
type Light = "day" | "night";
type SelectedNode = { executionId: string; nodeId: string };

const empty: DashboardState = { connected: false, snapshot: { startedAt: new Date().toISOString(), mode: "live", agents: [], loops: [], executions: [] }, runs: [] };
const inspectorStorageKey = "watchdog.inspector-width";
const defaultInspectorWidth = 340;
const minInspectorWidth = 300;
const maxInspectorWidth = 620;
const minStageWidth = 520;
const splitterWidth = 9;

function storedInspectorWidth() {
  try {
    const stored = Number(window.localStorage.getItem(inspectorStorageKey));
    return Number.isFinite(stored) ? clamp(stored, minInspectorWidth, maxInspectorWidth) : defaultInspectorWidth;
  } catch {
    return defaultInspectorWidth;
  }
}

export function App() {
  if (window.location.pathname.replace(/\/+$/, "") === "/reveal") return <Reveal />;
  return <Dashboard />;
}

function Dashboard() {
  const [state, setState] = useState<DashboardState>(empty);
  const [requestedRunId, setRequestedRunId] = useState<string>();
  const [view, setView] = useState<View>("yard");
  const [light, setLight] = useState<Light>(() => new Date().getHours() >= 19 || new Date().getHours() < 7 ? "night" : "day");
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedNode, setSelectedNode] = useState<SelectedNode>();
  const [executionId, setExecutionId] = useState<string>();
  const [petNonce, setPetNonce] = useState(0);
  const [dockOpen, setDockOpen] = useState(false);
  const [notice, setNotice] = useState("Waking the yard…");
  const [inspectorWidth, setInspectorWidth] = useState(storedInspectorWidth);
  const [inspectorMaxWidth, setInspectorMaxWidth] = useState(maxInspectorWidth);
  const [resizingInspector, setResizingInspector] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const inspectorWidthRef = useRef(inspectorWidth);
  const resizingInspectorRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    let socket: WebSocket | undefined;
    let reconnect: number | undefined;
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const query = new URLSearchParams();
      if (requestedRunId) query.set("run", requestedRunId);
      socket = new WebSocket(`${protocol}//${window.location.host}/ws?${query}`);
      socket.onmessage = (event) => {
        if (!mounted) return;
        const parsed = JSON.parse(String(event.data)) as DashboardState;
        const next: DashboardState = {
          ...parsed,
          snapshot: {
            ...parsed.snapshot,
            agents: parsed.snapshot.agents ?? [],
            loops: parsed.snapshot.loops ?? [],
            executions: parsed.snapshot.executions ?? [],
          },
        };
        setState(next);
        setRequestedRunId((current) => next.selectedRunId ?? (current && next.runs.some((run) => run.runId === current) ? current : undefined));
        setSelectedId((current) => current && next.snapshot.agents.some((agent) => agent.threadId === current) ? current : next.snapshot.agents[0]?.threadId);
        setSelectedNode((current) => current
          && next.snapshot.executions.some((execution) =>
            execution.id === current.executionId
            && execution.nodes.some((node) => node.id === current.nodeId))
          ? current
          : undefined);
        setExecutionId((current) =>
          current && next.snapshot.executions.some((execution) => execution.id === current)
            ? current
            : primaryYardExecution(next.snapshot.agents, next.snapshot.executions)?.id,
        );
        setNotice((current) => current === "Waking the yard…"
          || current === "Dashboard bridge reconnecting…"
          || current === "Switching Watchdog run…"
          || current === "No running sessions · Watchdog runtime offline"
          ? connectionLabel(next)
          : current);
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!mounted) return;
        setNotice("Dashboard bridge reconnecting…");
        reconnect = window.setTimeout(connect, 750);
      };
    };
    connect();
    return () => { mounted = false; if (reconnect) window.clearTimeout(reconnect); socket?.close(); };
  }, [requestedRunId]);

  const selected = state.snapshot.agents.find((agent) => agent.threadId === selectedId) ?? state.snapshot.agents[0];
  const roots = state.snapshot.agents.filter((agent) => !agent.parentThreadId);
  const active = state.snapshot.agents.filter((agent) => agent.activeTurnId).length;
  const tokens = state.snapshot.agents.reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0);
  const inputTokens = aggregateTokenSide(state.snapshot.agents, "inputTokens");
  const outputTokens = aggregateTokenSide(state.snapshot.agents, "outputTokens");
  const cost = state.snapshot.agents.reduce((sum, agent) => sum + (agent.costUsd ?? 0), 0);
  const loop = state.snapshot.loops[0];
  const execution = state.snapshot.executions.find((candidate) => candidate.id === executionId)
    ?? primaryYardExecution(state.snapshot.agents, state.snapshot.executions);
  const selectedExecution = executionForAgent(state.snapshot, selected);
  const nodeSelection = selectedNode
    ? state.snapshot.executions.find((candidate) => candidate.id === selectedNode.executionId)
    : undefined;
  const yardRoot = state.snapshot.agents.find((agent) => agent.threadId === execution?.ownerThreadId)
    ?? state.snapshot.agents.find((agent) => !agent.parentThreadId);
  const yardChildren = partitionYardChildren(yardRoot
    ? state.snapshot.agents.filter((agent) => agent.parentThreadId === yardRoot.threadId)
    : state.snapshot.agents.filter((agent) => agent.parentThreadId));
  const loopCount = visibleExecutions(state.snapshot).filter((candidate) => candidate.edges.some((edge) => edge.kind === "loop-back")).length;
  const warnings = [...new Set([
    ...runExecutionWarnings(state.snapshot),
    ...(loop?.warnings ?? []),
  ])];
  const hasRun = state.snapshot.agents.length > 0;
  const controllable = state.connected && state.snapshot.mode === "live";
  const harness = harnessDisplayName(state.snapshot.adapter);

  useEffect(() => {
    if (!hasRun || !workspaceRef.current) return;
    const workspace = workspaceRef.current;
    const syncBounds = () => {
      if (window.matchMedia("(max-width: 980px)").matches) return;
      const bounds = inspectorBounds(workspace.clientWidth);
      setInspectorMaxWidth(bounds.max);
      setInspectorWidth((current) => {
        const next = clamp(current, bounds.min, bounds.max);
        inspectorWidthRef.current = next;
        return next;
      });
    };
    syncBounds();
    const observer = new ResizeObserver(syncBounds);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [hasRun]);

  useEffect(() => () => document.body.classList.remove("resizing-inspector"), []);

  const resizeInspectorAt = (clientX: number) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    const bounds = inspectorBounds(rect.width);
    const next = Math.round(clamp(rect.right - clientX, bounds.min, bounds.max));
    inspectorWidthRef.current = next;
    setInspectorWidth(next);
    setInspectorMaxWidth(bounds.max);
  };

  const persistInspectorWidth = (width = inspectorWidthRef.current) => {
    try {
      window.localStorage.setItem(inspectorStorageKey, String(width));
    } catch {
      // Resizing remains functional when browser storage is unavailable.
    }
  };

  const finishInspectorResize = (event?: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingInspectorRef.current) return;
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    resizingInspectorRef.current = false;
    setResizingInspector(false);
    document.body.classList.remove("resizing-inspector");
    persistInspectorWidth();
  };

  const onInspectorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const bounds = inspectorBounds(workspace.clientWidth);
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = inspectorWidthRef.current + 24;
    if (event.key === "ArrowRight") next = inspectorWidthRef.current - 24;
    if (event.key === "Home") next = bounds.min;
    if (event.key === "End") next = bounds.max;
    if (next === undefined) return;
    event.preventDefault();
    next = Math.round(clamp(next, bounds.min, bounds.max));
    inspectorWidthRef.current = next;
    setInspectorWidth(next);
    setInspectorMaxWidth(bounds.max);
    persistInspectorWidth(next);
  };

  const resetInspectorWidth = () => {
    const bounds = inspectorBounds(workspaceRef.current?.clientWidth ?? 0);
    const next = clamp(defaultInspectorWidth, bounds.min, bounds.max);
    inspectorWidthRef.current = next;
    setInspectorWidth(next);
    setInspectorMaxWidth(bounds.max);
    persistInspectorWidth(next);
  };

  const control = async (body: unknown) => {
    if (!controllable) {
      setNotice(state.snapshot.mode === "observed"
        ? "Observed sessions are read-only · relaunch with watchdog codex"
        : "No live Watchdog runtime is connected");
      return;
    }
    try {
      const query = new URLSearchParams();
      if (state.selectedRunId) query.set("run", state.selectedRunId);
      const response = await fetch(`/api/control?${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { ok: boolean; error?: string; result?: ControlResult };
      if (!response.ok || !result.ok) throw new Error(result.error ?? "Control failed");
      setNotice(controlNotice(body, result.result));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return <main className={`app ${light}`}>
    <header className="topbar">
      <div className="brand">
        <img className="brand-mark" src="/assets/watchdog-logo-64.png" alt="" aria-hidden="true" />
        <div><strong>WATCHDOG</strong><small>LOCAL AGENT CONTROL PLANE</small></div>
      </div>
      <div className="run-summary">
        <Summary label="Loops" value={String(loopCount)} />
        <Summary label="Agents" value={`${active}/${state.snapshot.agents.length}`} accent={active > 0} />
        <Summary label="Tokens" value={compact(tokens)} />
        <Summary label="In" value={compact(inputTokens)} />
        <Summary label="Out" value={compact(outputTokens)} />
        {cost > 0 && <Summary label="Cost" value={`$${cost.toFixed(cost < 0.1 ? 3 : 2)}`} />}
        <Summary label="Iteration" value={execution?.iteration ? `#${execution.iteration}` : loop ? `#${loop.iteration}` : "—"} />
      </div>
      <div className="top-actions">
        {state.runs.length > 0 && <label className="run-picker">
          <span>RUN</span>
          <select value={state.selectedRunId ?? ""} onChange={(event) => {
            setRequestedRunId(event.target.value);
            setSelectedId(undefined);
            setSelectedNode(undefined);
            setExecutionId(undefined);
            setDockOpen(false);
            setNotice("Switching Watchdog run…");
          }} aria-label="Watchdog run">
            {state.runs.map((run) => <option value={run.runId} key={run.runId}>{runOptionLabel(run)}</option>)}
          </select>
        </label>}
        {hasRun && <div className="segmented" aria-label="Dashboard view">
          <button className={view === "yard" ? "active" : ""} onClick={() => setView("yard")}>YARD</button>
        <button className={view === "operator" ? "active" : ""} onClick={() => { setView("operator"); setDockOpen(false); }}>OPERATOR</button>
        </div>}
        <button className="light-toggle" onClick={() => setLight((value) => value === "day" ? "night" : "day")} aria-label="Toggle day and night">{light === "day" ? "☀" : "☾"}</button>
      </div>
    </header>

    <section className="status-strip">
      <span className={`live-dot ${state.connected ? state.snapshot.mode === "observed" ? "observed" : "connected" : ""}`} />
      <span>{notice}</span>
      {state.connected && <span className={`harness-badge harness-${harnessSlug(state.snapshot.adapter)}`}>WATCHING {harness}</span>}
      <span className="objective">{execution?.objective ?? loop?.objective ?? roots[0]?.task ?? state.message ?? "Waiting for task input"}</span>
      {warnings.map((warning) => <span className="warning" key={warning}>⚠ {warning}</span>)}
    </section>

    {hasRun
      ? <div
        className={`workspace ${resizingInspector ? "resizing" : ""}`}
        ref={workspaceRef}
        style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
      >
        <section className={`stage ${view}`}>
          {view === "yard"
            ? <div className="yard-stage">
              {execution && <ExecutionBreadcrumb
                snapshot={state.snapshot}
                execution={execution}
                onHome={() => {
                  setExecutionId(primaryYardExecution(state.snapshot.agents, state.snapshot.executions)?.id);
                  setSelectedNode(undefined);
                  setDockOpen(false);
                }}
                onOpen={(id) => { setExecutionId(id); setSelectedNode(undefined); setDockOpen(false); }}
              />}
              <YardCanvas
                snapshot={state.snapshot}
                selectedId={selectedNode ? undefined : selected?.threadId}
                executionId={execution?.id}
                dockFocused={dockOpen}
                onSelect={(id) => { setSelectedId(id); setSelectedNode(undefined); setDockOpen(false); }}
                onSelectNode={(nodeId) => {
                  if (!execution) return;
                  setSelectedNode({ executionId: execution.id, nodeId });
                  setDockOpen(false);
                }}
                onOpenDock={() => setDockOpen(true)}
                onOpenExecution={(id) => {
                  if (state.snapshot.executions.some((candidate) => candidate.id === id)) {
                    setExecutionId(id);
                    setSelectedNode(undefined);
                    setDockOpen(false);
                  }
                }}
                light={light}
                petNonce={petNonce}
                onPet={() => setPetNonce((value) => value + 1)}
              />
            </div>
            : <Operator
              snapshot={state.snapshot}
              selectedId={selectedNode ? undefined : selected?.threadId}
              selectedNode={selectedNode}
              onSelect={(id) => { setSelectedId(id); setSelectedNode(undefined); }}
              onSelectNode={(selection) => {
                setSelectedNode(selection);
                setExecutionId(selection.executionId);
                setDockOpen(false);
              }}
            />}
        </section>
        <div
          className="workspace-resizer"
          role="separator"
          aria-label="Resize inspector"
          aria-orientation="vertical"
          aria-valuemin={minInspectorWidth}
          aria-valuemax={inspectorMaxWidth}
          aria-valuenow={inspectorWidth}
          tabIndex={0}
          onDoubleClick={resetInspectorWidth}
          onKeyDown={onInspectorKeyDown}
          onPointerDown={(event) => {
            if (event.button !== 0 || window.matchMedia("(max-width: 980px)").matches) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            resizingInspectorRef.current = true;
            setResizingInspector(true);
            document.body.classList.add("resizing-inspector");
          }}
          onPointerMove={(event) => {
            if (resizingInspectorRef.current) resizeInspectorAt(event.clientX);
          }}
          onPointerUp={finishInspectorResize}
          onPointerCancel={finishInspectorResize}
        />
        {dockOpen
          ? <DockInspector agents={yardChildren.docked} onSelect={(id) => { setSelectedId(id); setSelectedNode(undefined); setDockOpen(false); }} />
          : selectedNode && nodeSelection
            ? <NodeInspector
              key={`${selectedNode.executionId}:${selectedNode.nodeId}`}
              snapshot={state.snapshot}
              execution={nodeSelection}
              nodeId={selectedNode.nodeId}
              capabilities={state.snapshot.executionCapabilities?.[nodeSelection.id]?.nodes[selectedNode.nodeId]}
              connected={controllable}
              onControl={control}
              onSelectAgent={(id) => { setSelectedId(id); setSelectedNode(undefined); }}
              onOpenSubgraph={(id) => {
                setExecutionId(id);
                setSelectedNode(undefined);
                setView("yard");
              }}
            />
          : <Inspector
            agent={selected}
            loop={loopForAgent(state.snapshot, selected?.threadId)}
            execution={selectedExecution}
            executionCapabilities={selectedExecution ? state.snapshot.executionCapabilities?.[selectedExecution.id] : undefined}
            connected={controllable}
            capabilities={selected ? state.snapshot.capabilities?.[selected.threadId] : undefined}
            harness={state.snapshot.adapter?.harness}
            onControl={control}
            onOpenExecution={(id) => {
              setExecutionId(id);
              setSelectedNode(undefined);
              setDockOpen(false);
              setView("yard");
            }}
          />}
      </div>
      : <EmptyRun
        connected={state.connected}
        snapshot={state.snapshot}
        light={light}
        petNonce={petNonce}
        onPet={() => setPetNonce((value) => value + 1)}
      />}

    <footer>
      <span>{state.connected ? `${harness} YARD` : "THE YARD"} · LOCALHOST</span>
      <span>{hasRun ? "click dog to pet · trains to inspect · tower for root" : "waiting for a Watchdog-owned run"}</span>
      <span>{light.toUpperCase()} SHIFT</span>
    </footer>
  </main>;
}

function inspectorBounds(workspaceWidth: number) {
  const available = workspaceWidth - minStageWidth - splitterWidth;
  return {
    min: minInspectorWidth,
    max: Math.max(minInspectorWidth, Math.min(maxInspectorWidth, available)),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function ExecutionBreadcrumb({ snapshot, execution, onHome, onOpen }: {
  snapshot: RunSnapshot;
  execution: ExecutionGraphState;
  onHome: () => void;
  onOpen: (id: string) => void;
}) {
  const trail: ExecutionGraphState[] = [];
  const seen = new Set<string>();
  let current: ExecutionGraphState | undefined = execution;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift(current);
    current = current.parentExecutionId
      ? snapshot.executions.find((candidate) => candidate.id === current?.parentExecutionId)
      : undefined;
  }
  const topologyRoot = snapshot.agents.find((agent) => agent.kind === "root" && !agent.parentThreadId)
    ?? snapshot.agents.find((agent) => !agent.parentThreadId);
  const executionOwner = snapshot.agents.find((agent) => agent.threadId === execution.ownerThreadId);
  const ownerTrail = executionOwner && topologyRoot && executionOwner.threadId !== topologyRoot.threadId
    ? agentAncestry(snapshot, executionOwner)
    : [];
  return <nav className="execution-breadcrumb" aria-label="Execution graph location">
    <span><button onClick={onHome}>YARD</button></span>
    {ownerTrail.map((agent) => <span key={agent.threadId}>
      <i>›</i>{agent.threadId === topologyRoot?.threadId
        ? <button onClick={onHome}>{agentName(agent)}</button>
        : <b>{agentName(agent)}</b>}
    </span>)}
    {trail.map((item, index) => <span key={item.id}>
      {(index > 0 || ownerTrail.length > 0 || Boolean(topologyRoot)) && <i>›</i>}
      <button className={item.id === execution.id ? "active" : ""} onClick={() => onOpen(item.id)}>
        {item.label ?? item.id}
      </button>
    </span>)}
    <em>{execution.authority} · {execution.incompleteReason ? "incomplete" : execution.status}</em>
  </nav>;
}

function EmptyRun({ connected, snapshot, light, petNonce, onPet }: {
  connected: boolean;
  snapshot: RunSnapshot;
  light: Light;
  petNonce: number;
  onPet: () => void;
}) {
  return <section className="empty-yard">
    <div className="empty-yard-scene">
      <YardCanvas snapshot={snapshot} onSelect={() => {}} light={light} petNonce={petNonce} onPet={onPet} />
      <div className="empty-yard-card">
        <div className="empty-signal" aria-hidden="true"><i /><i /><i /></div>
        <small>{connected ? "RUNTIME CONNECTED" : "THE YARD IS QUIET"}</small>
        <h1>{connected ? "Waiting for the first session" : "No running sessions"}</h1>
        <p>{connected
          ? "Watchdog is online. Start a harness turn and its task and subagents will roll into the yard."
          : "Launch Codex or Pi through Watchdog to bring the yard online."}</p>
        <div className="empty-commands"><CopyCommand value="watchdog codex" /><CopyCommand value="watchdog pi" /></div>
      </div>
    </div>
  </section>;
}

function CopyCommand({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_300);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopied(true);
  };

  return <div className={`copy-command ${copied ? "copied" : ""}`}>
    <code>{value}</code>
    <button type="button" onClick={() => void copy()} aria-label={copied ? `Copied ${value}` : `Copy ${value}`}>
      {copied
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><rect width="13" height="13" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
    </button>
    {copied && <span role="status">COPIED</span>}
  </div>;
}

function Summary({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return <div className="summary"><small>{label}</small><strong className={accent ? "accent" : ""}>{value}</strong></div>;
}

function MessageMarkdown({ children }: { children: string }) {
  return <div className="message-markdown"><Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown></div>;
}

function Inspector({ agent, loop, execution, connected, capabilities, executionCapabilities, harness, onControl, onOpenExecution }: { agent?: AgentState; loop?: LoopState; execution?: ExecutionGraphState; connected: boolean; capabilities?: AgentCapabilities; executionCapabilities?: ExecutionCapabilities; harness?: string; onControl: (body: unknown) => Promise<void>; onOpenExecution: (id: string) => void }) {
  const [steer, setSteer] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [loopNote, setLoopNote] = useState("");
  const [verifier, setVerifier] = useState("");
  const [retryMessage, setRetryMessage] = useState("");
  const [retryModel, setRetryModel] = useState("");
  const [retryEffort, setRetryEffort] = useState("");
  const [executionNote, setExecutionNote] = useState("");
  const [verificationNote, setVerificationNote] = useState("");
  const [nodeRetryMessage, setNodeRetryMessage] = useState("");
  useEffect(() => {
    setRetryMessage("");
    setRetryModel(agent?.effective?.model ?? "");
    setRetryEffort(agent?.effective?.effort ?? "");
  }, [agent?.threadId]);
  if (!agent) return <aside className="inspector empty"><span>NO TRAIN SELECTED</span></aside>;
  const mismatch = agent.requested?.model && agent.effective?.model && agent.requested.model !== agent.effective.model;
  const isChild = Boolean(agent.parentThreadId);
  const canStop = connected && (capabilities?.interrupt.available ?? Boolean(agent.activeTurnId));
  const canSteer = connected && (capabilities?.steer.available ?? (!isChild && Boolean(agent.activeTurnId)));
  const canFollowUp = connected && Boolean(capabilities?.followUp.available);
  const canRetry = connected && (capabilities?.retry.available ?? !isChild);
  const canOverride = capabilities?.modelOverride.available ?? !isChild;
  const assignment = agent.task ?? agent.requested?.prompt;
  const requestedModel = agent.requested?.model ?? "no override";
  const requestedEffort = agent.requested?.effort ? `${agent.requested.effort} effort` : "default effort";
  const messages = agent.messages?.length
    ? agent.messages
    : agent.latestMessage ? [{ id: "legacy-latest", text: agent.latestMessage, at: agent.lastActivityAt ?? agent.startedAt ?? "" }] : [];
  const messageCount = agent.messageCount ?? messages.length;
  const retainedActivities = agent.activities?.length
    ? agent.activities
    : agent.latestActivity ? [{ id: "legacy-latest-action", ...agent.latestActivity, at: agent.lastActivityAt ?? agent.startedAt ?? "" }] : [];
  const activityCount = agent.activityCount ?? retainedActivities.length;
  const latestActivityId = retainedActivities.at(-1)?.id;
  const latestMessageId = messages.at(-1)?.id;
  const timeline = [
    ...messages.map((message, order) => ({ kind: "message" as const, id: message.id, text: message.text, at: message.at, order })),
    ...retainedActivities.map((activity, order) => ({ kind: "activity" as const, ...activity, order })),
  ].sort((left, right) => {
    const time = Date.parse(right.at) - Date.parse(left.at);
    if (Number.isFinite(time) && time !== 0) return time;
    return left.kind === right.kind ? right.order - left.order : left.kind === "message" ? -1 : 1;
  });
  if (!agent.activeTurnId && latestMessageId) {
    const latestMessageIndex = timeline.findIndex((entry) => entry.kind === "message" && entry.id === latestMessageId);
    if (latestMessageIndex > 0) timeline.unshift(...timeline.splice(latestMessageIndex, 1));
  }
  const timelineCount = messageCount + activityCount;
  const executionNodeId = execution
    ? agent.execution?.executionId === execution.id
      ? agent.execution.nodeId
      : execution.activeNodeIds[0] ?? [...execution.activations].reverse()[0]?.nodeId
    : undefined;
  const nodeCapabilities = executionNodeId ? executionCapabilities?.nodes[executionNodeId] : undefined;
  return <aside className="inspector">
    <div className="inspector-head">
      <div><small>{isChild ? "SUBAGENT CAR" : "ROOT ENGINE"}</small><h2>{agentName(agent)}</h2></div>
      <span className={`status-badge ${agent.activeTurnId ? "working" : agent.status}`}>{agent.activeTurnId ? "WORKING" : agent.status.toUpperCase()}</span>
    </div>
    <div className="thread-id">{agent.threadId}</div>

    {(assignment || isChild) && <section className="task"><label>{isChild ? "ASSIGNMENT" : "TASK"}</label><p>{assignment ?? "Assignment text unavailable from Codex."}</p></section>}

    {(agent.streamingMessage || timeline.length > 0) && <section className="message-history">
      <header><label>TRANSCRIPT</label><span>{timelineCount} events · newest first</span></header>
      {agent.streamingMessage && <article className="message-entry streaming">
        <div><strong>LIVE RESPONSE</strong><time>{formatMessageTime(agent.streamingMessage.updatedAt)}</time></div>
        <div className="stream-content"><MessageMarkdown>{agent.streamingMessage.text}</MessageMarkdown><i aria-hidden="true">▋</i></div>
      </article>}
      {timeline.slice(0, 30).map((entry) => entry.kind === "message"
        ? <article className={`message-entry ${entry.id === latestMessageId ? "latest" : ""}`} key={`message:${entry.id}`}>
          <div><strong>{entry.id === latestMessageId ? "LATEST RESPONSE" : "RESPONSE"}</strong><time>{formatMessageTime(entry.at)}</time></div>
          <MessageMarkdown>{entry.text}</MessageMarkdown>
        </article>
        : <article className="message-entry activity" key={`activity:${entry.id}`}>
          <div>
            <strong>{entry.id === latestActivityId ? entry.status === "inProgress" ? "CURRENT ACTION" : "LAST ACTION" : entry.status}</strong>
            <time>{formatMessageTime(entry.at)}</time>
          </div>
          <p>{entry.tool}</p>
        </article>)}
      {timelineCount > Math.min(timeline.length, 30) && <small className="history-truncated">Showing the latest transcript events; complete history remains in the Watchdog run trace.</small>}
    </section>}

    <div className="meter-row">
      <Metric label="TOKENS" value={compact(agent.totalTokens)} sub={`${compact(agent.inputTokens)} in · ${compact(agent.outputTokens)} out`} />
      <Metric label="ROLE" value={agent.role ?? (isChild ? "worker" : "orchestrator")} sub={agent.kind?.replaceAll("-", " ")} />
      {agent.costUsd !== undefined && <Metric label="COST" value={`$${agent.costUsd.toFixed(agent.costUsd < 0.1 ? 4 : 2)}`} />}
    </div>

    <section className={`config-card ${mismatch ? "mismatch" : ""}`}>
      <div><label>REQUESTED</label><strong>{requestedModel}</strong><span>{requestedEffort}</span></div>
      <div className="config-arrow">→</div>
      <div><label>EFFECTIVE</label><strong>{agent.effective?.model ?? "unknown"}</strong><span>{agent.effective?.effort ?? "default"} effort</span></div>
      {mismatch && <em>MODEL MISMATCH</em>}
    </section>

    {loop && (!execution || execution.authority === "legacy") && <section className={`loop-card ${loop.phase}`}>
      <div>
        <label>{isChild ? "PARENT LOOP" : "LOOP"} · ITERATION {loop.iteration}</label>
        <strong>{loop.phase.toUpperCase()}</strong>
      </div>
      <p>{loop.objective ?? "Objective not captured"}</p>
      <span>Verifier: {loop.verifier ?? "not declared"}</span>
      <span>Evidence: {loop.evidence.length} · Verification: {loop.verification.status}</span>
      <span>Budget: {compact(loop.budget.usedTokens)} / {compact(loop.budget.maxTokens)} tokens · {loop.iteration}/{loop.budget.maxIterations ?? "∞"} iterations</span>
      {loop.budget.maxTokens && <div className="budget-track"><i style={{ width: `${Math.min(100, loop.budget.usedTokens / loop.budget.maxTokens * 100)}%` }} /></div>}
      {loop.evidence.slice(-2).map((item) => <q key={item.id}>{item.summary}</q>)}
      {loop.warnings.map((warning) => <span className="loop-warning" key={warning}>⚠ {warning}</span>)}
    </section>}

    {execution && <section className={`execution-card ${execution.incompleteReason ? "incomplete" : execution.status}`}>
      <div><label>{execution.parentExecutionId ? "NESTED EXECUTION" : "EXECUTION"} · ITERATION {execution.iteration || "—"}</label><strong>{execution.incompleteReason ? "INCOMPLETE" : execution.status.toUpperCase()}</strong></div>
      <p>{execution.label ?? execution.objective ?? execution.id}</p>
      <span>Node: {executionNodeId ? execution.nodes.find((node) => node.id === executionNodeId)?.label ?? executionNodeId : "not currently assigned"}</span>
      <span>Source: {execution.source.label ?? execution.source.kind} · {execution.authority}</span>
      <span>{execution.nodes.length} nodes · {execution.edges.length} edges · {execution.traversals.length} traversals</span>
      {(execution.policy?.verifier || execution.nodes.some((node) => node.kind === "verifier")) && <span>Verifier: {execution.policy?.verifier ?? "defined by verifier node"} · {execution.verification?.status ?? "not-run"}</span>}
      {(execution.policy?.maxTokens || execution.policy?.maxIterations) && <span>Budget: {compact(execution.usedTokens)} / {compact(execution.policy.maxTokens)} tokens · {execution.iteration}/{execution.policy.maxIterations ?? "∞"} iterations</span>}
      {(execution.evidence?.length ?? 0) > 0 && <span>Evidence: {execution.evidence.length}</span>}
      {execution.evidence?.slice(-2).map((item) => <q key={item.id}>{item.summary}</q>)}
      {execution.stopReason && <span className="execution-stop-reason">{execution.stopReason}</span>}
      {execution.warnings.map((warning) => <span className="loop-warning" key={warning}>⚠ {warning}</span>)}
      <button className="open-execution" onClick={() => onOpenExecution(execution.id)}>OPEN EXECUTION IN YARD →</button>
    </section>}

    <section className="controls">
      <label>CAPABILITIES</label>
      {capabilities && <div className="capability-grid">
        {Object.entries(capabilities).map(([name, capability]) => <span className={capability.available ? "available" : "unavailable"} title={capability.reason} key={name}>{capability.available ? "●" : "○"} {capabilityLabel(name)}</span>)}
      </div>}
      {canStop && <button className="stop" onClick={() => void onControl({ action: "interrupt", agent: agent.threadId })}>■ STOP {isChild ? "CAR" : "ENGINE"}</button>}
      {canSteer && <form onSubmit={(event) => { event.preventDefault(); if (steer.trim()) void onControl({ action: "steer", agent: agent.threadId, message: steer.trim() }); setSteer(""); }}>
        <input value={steer} onChange={(event) => setSteer(event.target.value)} placeholder={isChild ? "Steer this subagent…" : "Steer the root engine…"} />
        <button type="submit" disabled={!steer.trim()}>SEND</button>
      </form>}
      {capabilities?.followUp.available && <form onSubmit={(event) => { event.preventDefault(); if (followUp.trim()) void onControl({ action: "followUp", agent: agent.threadId, message: followUp.trim() }); setFollowUp(""); }}>
        <input value={followUp} onChange={(event) => setFollowUp(event.target.value)} placeholder="Queue a follow-up after current work…" disabled={!canFollowUp} title={capabilities.followUp.reason} />
        <button type="submit" disabled={!canFollowUp || !followUp.trim()}>FOLLOW UP</button>
      </form>}
      {isChild && !capabilities?.steer.available && <p className="capability-note">{capabilities?.steer.reason ?? "This adapter cannot steer the selected subagent."}</p>}
      {canRetry && <div className="retry-controls">
        <label>{isChild ? "RETRY SUBAGENT" : agent.activeTurnId ? "INTERRUPT + RETRY ROOT" : "START NEXT ROOT TURN"}</label>
        <form className="retry-form" onSubmit={(event) => {
          event.preventDefault();
          if (!retryMessage.trim()) return;
          void onControl({ action: "retry", agent: agent.threadId, message: retryMessage.trim(), model: retryModel.trim() || undefined, effort: retryEffort || undefined });
          setRetryMessage("");
        }}>
          <input className="retry-message" value={retryMessage} onChange={(event) => setRetryMessage(event.target.value)} placeholder="What should the next turn do?" />
          <input value={retryModel} onChange={(event) => setRetryModel(event.target.value)} placeholder="Model override (optional)" disabled={!canOverride} />
          <select value={retryEffort} onChange={(event) => setRetryEffort(event.target.value)} disabled={!canOverride} aria-label="Reasoning effort override">
            <option value="">Default effort</option>{harness === "pi" && <option value="off">Off</option>}<option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option>{harness === "pi" && <option value="max">Maximum</option>}
          </select>
          <button type="submit" disabled={!retryMessage.trim()}>↻ RETRY TURN</button>
        </form>
        {!canRetry && <p className="capability-note">{capabilities?.retry.reason}</p>}
      </div>}
      {execution && execution.authority !== "legacy" && <div className="execution-controls">
        <label>EXECUTION CONTROLS</label>
        {executionCapabilities?.stop.available && <button className="stop" onClick={() => void onControl({
          action: "execution.stop",
          executionId: execution.id,
          reason: "Stopped from the Watchdog dashboard.",
        })}>■ STOP WHOLE EXECUTION</button>}
        {executionNodeId && nodeCapabilities?.stop.available && <button className="stop node-stop" onClick={() => void onControl({
          action: "execution.stop",
          executionId: execution.id,
          nodeId: executionNodeId,
          reason: "Node stopped from the Watchdog dashboard.",
        })}>■ STOP NODE · {execution.nodes.find((node) => node.id === executionNodeId)?.label ?? executionNodeId}</button>}
        {executionNodeId && nodeCapabilities?.retry.available && <form onSubmit={(event) => {
          event.preventDefault();
          if (!nodeRetryMessage.trim()) return;
          void onControl({
            action: "execution.node.retry",
            executionId: execution.id,
            nodeId: executionNodeId,
            message: nodeRetryMessage.trim(),
          });
          setNodeRetryMessage("");
        }}>
          <input value={nodeRetryMessage} onChange={(event) => setNodeRetryMessage(event.target.value)} placeholder="Retry this node with retained context…" />
          <button type="submit" disabled={!nodeRetryMessage.trim()}>↻ RETRY NODE</button>
        </form>}
        {!execution.policy?.verifier && <form onSubmit={(event) => {
          event.preventDefault();
          if (!verifier.trim()) return;
          void onControl({ action: "execution.update", executionId: execution.id, policy: { verifier: verifier.trim() } });
          setVerifier("");
        }}>
          <input value={verifier} onChange={(event) => setVerifier(event.target.value)} placeholder="Declare the exit verifier…" disabled={!connected} />
          <button type="submit" disabled={!connected || !verifier.trim()}>SET VERIFIER</button>
        </form>}
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!executionNote.trim()) return;
          void onControl({
            action: "execution.evidence",
            executionId: execution.id,
            agent: agent.threadId,
            nodeId: executionNodeId,
            summary: executionNote.trim(),
            source: "dashboard operator",
          });
          setExecutionNote("");
        }}>
          <input value={executionNote} onChange={(event) => setExecutionNote(event.target.value)} placeholder="Record execution evidence…" disabled={!connected} />
          <button type="submit" disabled={!connected || !executionNote.trim()}>ADD EVIDENCE</button>
        </form>
        <input value={verificationNote} onChange={(event) => setVerificationNote(event.target.value)} placeholder="Verification result (optional)…" disabled={!connected} />
        <div className="verify-actions">
          <button disabled={!connected} onClick={() => {
            void onControl({ action: "execution.verify", executionId: execution.id, status: "passed", summary: verificationNote.trim() || undefined });
            setVerificationNote("");
          }}>✓ VERIFIER PASS</button>
          <button className="fail" disabled={!connected} onClick={() => {
            void onControl({ action: "execution.verify", executionId: execution.id, status: "failed", summary: verificationNote.trim() || undefined });
            setVerificationNote("");
          }}>× VERIFIER FAIL</button>
        </div>
      </div>}
      {loop && (!execution || execution.authority === "legacy") && <div className="loop-controls">
        {!loop.verifier && <form onSubmit={(event) => { event.preventDefault(); if (verifier.trim()) void onControl({ action: "loop.configure", agent: loop.threadId, verifier: verifier.trim() }); setVerifier(""); }}>
          <input value={verifier} onChange={(event) => setVerifier(event.target.value)} placeholder="Declare the exit verifier…" disabled={!connected} />
          <button type="submit" disabled={!connected || !verifier.trim()}>SET</button>
        </form>}
        <form onSubmit={(event) => { event.preventDefault(); if (loopNote.trim()) void onControl({ action: "loop.evidence", agent: loop.threadId, summary: loopNote.trim(), source: "dashboard operator" }); setLoopNote(""); }}>
          <input value={loopNote} onChange={(event) => setLoopNote(event.target.value)} placeholder="Record evidence or verification note…" disabled={!connected} />
          <button type="submit" disabled={!connected || !loopNote.trim()}>ADD</button>
        </form>
        <div className="verify-actions">
          <button disabled={!connected} onClick={() => void onControl({ action: "loop.verify", agent: loop.threadId, status: "passed", summary: loopNote.trim() || undefined })}>✓ VERIFIER PASS</button>
          <button className="fail" disabled={!connected} onClick={() => void onControl({ action: "loop.verify", agent: loop.threadId, status: "failed", summary: loopNote.trim() || undefined })}>× VERIFIER FAIL</button>
        </div>
      </div>}
    </section>
  </aside>;
}

function NodeInspector({
  snapshot,
  execution,
  nodeId,
  capabilities,
  connected,
  onControl,
  onSelectAgent,
  onOpenSubgraph,
}: {
  snapshot: RunSnapshot;
  execution: ExecutionGraphState;
  nodeId: string;
  capabilities?: ExecutionCapabilities["nodes"][string];
  connected: boolean;
  onControl: (body: unknown) => Promise<void>;
  onSelectAgent: (threadId: string) => void;
  onOpenSubgraph: (executionId: string) => void;
}) {
  const [retryMessage, setRetryMessage] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const node = execution.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return <aside className="inspector empty">Selected execution node is no longer available.</aside>;

  const attempts = execution.activations.filter((activation) => activation.nodeId === nodeId);
  const latest = attempts.at(-1);
  const threadIds = [...new Set(attempts.flatMap((attempt) => attempt.threadIds))];
  const agents = threadIds
    .map((threadId) => snapshot.agents.find((agent) => agent.threadId === threadId))
    .filter((agent): agent is AgentState => Boolean(agent));
  const edges = execution.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId);
  const evidence = execution.evidence.filter((item) => item.nodeId === nodeId);
  const traversals = execution.traversals.filter((traversal) => traversal.from === nodeId || traversal.to === nodeId);
  const latestStatus = execution.incompleteReason && latest && ["queued", "running"].includes(latest.status)
    ? "incomplete"
    : latest?.status ?? "pending";
  const assignedTokens = agents.reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0);
  const latestActivity = nodeAttemptActivity(agents, latest);
  const controlAgent = latest?.threadIds[0] ?? execution.ownerThreadId;

  return <aside className="inspector node-inspector">
    <div className="inspector-head">
      <div><small>EXECUTION NODE · {node.kind}</small><h2>{node.label}</h2></div>
      <span className={`status-badge ${latestStatus}`}>{latestStatus.toUpperCase()}</span>
    </div>
    <div className="thread-id">{execution.id} / {node.id}</div>

    {(node.description || execution.objective) && <section className="task">
      <label>{node.description ? "NODE PURPOSE" : "EXECUTION OBJECTIVE"}</label>
      <p>{node.description ?? execution.objective}</p>
    </section>}

    <div className="meter-row">
      <Metric label="ATTEMPTS" value={String(attempts.length)} sub={latest ? `latest · iteration ${latest.iteration}` : "not started"} />
      <Metric label="AGENTS" value={String(agents.length)} sub="explicitly assigned" />
      <Metric label="TOKENS" value={compact(assignedTokens || undefined)} sub="assigned agent totals" />
    </div>

    <section className="node-section">
      <header><label>ATTEMPT HISTORY</label><span>{attempts.length} recorded</span></header>
      {attempts.length === 0
        ? <p className="node-empty">This node is declared but has no recorded attempt.</p>
        : [...attempts].reverse().map((attempt) => <article className={`node-attempt ${attempt.status}`} key={attempt.id}>
          <div>
            <strong>ITERATION {attempt.iteration} · {attempt.status.toUpperCase()}</strong>
            <time>{attemptDuration(attempt.startedAt, attempt.completedAt)}</time>
          </div>
          <span>{formatMessageTime(attempt.startedAt)}{attempt.completedAt ? ` → ${formatMessageTime(attempt.completedAt)}` : ""}</span>
          {attempt.summary && <p>{attempt.summary}</p>}
          <div className="node-agent-links">
            {attempt.threadIds.map((threadId) => {
              const agent = snapshot.agents.find((candidate) => candidate.threadId === threadId);
              return <button key={threadId} onClick={() => onSelectAgent(threadId)}>
                {agent ? agentName(agent) : threadId.slice(0, 8)} ↗
              </button>;
            })}
          </div>
        </article>)}
    </section>

    <section className="node-section">
      <header><label>EDGES + TRAVERSALS</label><span>{traversals.length} taken</span></header>
      {edges.length === 0
        ? <p className="node-empty">No edges touch this node.</p>
        : <div className="node-edge-list">{edges.map((edge) => {
          const count = execution.traversals.filter((traversal) => traversal.edgeId === edge.id).length;
          return <div className={edge.kind} key={edge.id}>
            <strong>{edge.from} {edge.kind === "loop-back" ? "↩" : "→"} {edge.to}</strong>
            <span>{edge.condition ?? edge.kind} · traversed {count}×</span>
          </div>;
        })}</div>}
    </section>

    {(latestActivity.length > 0 || agents.length > 0) && <section className="node-section">
      <header><label>ASSIGNED AGENT ACTIVITY</label><span>latest attempt window</span></header>
      <p className="node-correlation-note">Messages and tools are correlated by assigned agent and attempt time; use the agent link for its complete transcript.</p>
      {latestActivity.map((entry) => <article className="node-activity" key={`${entry.kind}:${entry.agent.threadId}:${entry.id}`}>
        <div><strong>{agentName(entry.agent)} · {entry.kind === "message" ? "RESPONSE" : entry.status.toUpperCase()}</strong><time>{formatMessageTime(entry.at)}</time></div>
        {entry.kind === "message" ? <MessageMarkdown>{entry.text}</MessageMarkdown> : <p>{entry.tool}</p>}
      </article>)}
    </section>}

    {evidence.length > 0 && <section className="node-section">
      <header><label>EVIDENCE</label><span>{evidence.length} items</span></header>
      {evidence.map((item) => <q key={item.id}>{item.summary}<small>{item.source} · iteration {item.iteration}</small></q>)}
    </section>}

    {execution.incompleteReason && <section className="node-incomplete">
      <strong>INSTRUMENTATION INCOMPLETE</strong>
      <p>{execution.incompleteReason}</p>
      <span>Watchdog has not fabricated a completion event.</span>
    </section>}

    <section className="controls node-controls">
      <label>NODE CONTROLS</label>
      {node.subgraphId && <button onClick={() => onOpenSubgraph(node.subgraphId!)}>OPEN NESTED GRAPH →</button>}
      {capabilities && <div className="capability-grid">
        {Object.entries(capabilities).map(([name, capability]) => <span className={capability.available ? "available" : "unavailable"} title={capability.reason} key={name}>{capability.available ? "●" : "○"} {capabilityLabel(name)}</span>)}
      </div>}
      {connected && capabilities?.stop.available && <button className="stop" onClick={() => void onControl({
        action: "execution.stop",
        executionId: execution.id,
        nodeId,
        reason: "Node stopped from the Watchdog dashboard.",
      })}>■ STOP NODE</button>}
      {capabilities?.retry.available && <form onSubmit={(event) => {
        event.preventDefault();
        if (!retryMessage.trim()) return;
        void onControl({ action: "execution.node.retry", executionId: execution.id, nodeId, message: retryMessage.trim() });
        setRetryMessage("");
      }}>
        <input value={retryMessage} onChange={(event) => setRetryMessage(event.target.value)} placeholder="Retry this node with retained context…" />
        <button type="submit" disabled={!retryMessage.trim()}>↻ RETRY NODE</button>
      </form>}
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!evidenceNote.trim()) return;
        void onControl({
          action: "execution.evidence",
          executionId: execution.id,
          agent: controlAgent,
          nodeId,
          summary: evidenceNote.trim(),
          source: "dashboard operator",
        });
        setEvidenceNote("");
      }}>
        <input value={evidenceNote} onChange={(event) => setEvidenceNote(event.target.value)} placeholder="Record evidence for this node…" disabled={!connected} />
        <button type="submit" disabled={!connected || !evidenceNote.trim()}>ADD EVIDENCE</button>
      </form>
      {!capabilities?.stop.available && capabilities?.stop.reason && <p className="capability-note">{capabilities.stop.reason}</p>}
      {!capabilities?.retry.available && capabilities?.retry.reason && <p className="capability-note">{capabilities.retry.reason}</p>}
    </section>
  </aside>;
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="metric"><label>{label}</label><strong>{value}</strong>{sub && <span>{sub}</span>}</div>;
}

function DockInspector({ agents, onSelect }: { agents: AgentState[]; onSelect: (id: string) => void }) {
  return <aside className="inspector dock-inspector">
    <div className="inspector-head">
      <div><small>COMPLETED CAR DOCK</small><h2>Dock</h2></div>
      <span className="status-badge">{agents.length} STORED</span>
    </div>
    <p className="dock-intro">Older completed cars move here once the Yard has more than nine subagents. Their full history stays inspectable.</p>
    <div className="dock-list">
      {agents.length === 0
        ? <p className="dock-empty">All completed cars are still visible in the Yard.</p>
        : agents.map((agent) => <button key={agent.threadId} onClick={() => onSelect(agent.threadId)}>
          <span>
            <small>{agent.role ?? "subagent"}</small>
            <strong>{agentName(agent)}</strong>
          </span>
          <em>{agent.status}</em>
          <b>{compact(agent.totalTokens)} tok</b>
        </button>)}
    </div>
  </aside>;
}

function Operator({
  snapshot,
  selectedId,
  selectedNode,
  onSelect,
  onSelectNode,
}: {
  snapshot: RunSnapshot;
  selectedId?: string;
  selectedNode?: SelectedNode;
  onSelect: (id: string) => void;
  onSelectNode: (selection: SelectedNode) => void;
}) {
  const roots = snapshot.agents.filter((agent) => !agent.parentThreadId);
  const byParent = new Map<string | undefined, AgentState[]>();
  for (const agent of snapshot.agents) byParent.set(agent.parentThreadId, [...(byParent.get(agent.parentThreadId) ?? []), agent]);
  const loops = new Map(snapshot.loops.map((loop) => [loop.threadId, loop]));
  const executions = visibleExecutions(snapshot);
  const loopCount = executions.filter((execution) => execution.edges.some((edge) => edge.kind === "loop-back")).length;
  return <div className="operator-view">
    <div className="operator-title"><div><small>{harnessDisplayName(snapshot.adapter)} · NORMALIZED RUNTIME</small><h1>Execution + subagents</h1></div><span>{executions.length} graphs · {loopCount} loops · {snapshot.agents.length} agents</span></div>
    <div className="graph">
      {executions.length > 0 && <div className="execution-map">
        <header><strong>SEMANTIC EXECUTIONS</strong><span>declared nodes and exact edges</span></header>
        {executions.map((execution) => <ExecutionMap
          key={execution.id}
          execution={execution}
          selectedNodeId={selectedNode?.executionId === execution.id ? selectedNode.nodeId : undefined}
          onSelectNode={(nodeId) => onSelectNode({ executionId: execution.id, nodeId })}
          onSelectOwner={() => onSelect(execution.ownerThreadId)}
        />)}
      </div>}
      <header className="agent-map-title"><strong>SUBAGENT TOPOLOGY</strong><span>parent / child ownership</span></header>
      <div className="graph-forest">{roots.map((root) => <GraphBranch key={root.threadId} agent={root} byParent={byParent} loops={loops} selectedId={selectedId} onSelect={onSelect} seen={new Set()} />)}</div>
    </div>
    <div className="timeline">
      <header><strong>ACTIVITY</strong><span>live normalized state</span></header>
      {snapshot.agents.map((agent) => <button key={agent.threadId} onClick={() => onSelect(agent.threadId)}><span className={agent.activeTurnId ? "pulse" : ""} /><strong>{agentName(agent)}</strong><em>{agent.latestActivity?.tool ?? agent.status}</em><time>{compact(agent.totalTokens)} tok</time></button>)}
    </div>
  </div>;
}

function ExecutionMap({
  execution,
  selectedNodeId,
  onSelectNode,
  onSelectOwner,
}: {
  execution: ExecutionGraphState;
  selectedNodeId?: string;
  onSelectNode: (nodeId: string) => void;
  onSelectOwner: () => void;
}) {
  const latestByNode = new Map<string, ExecutionGraphState["activations"][number]>();
  for (const activation of execution.activations) latestByNode.set(activation.nodeId, activation);
  return <section className="execution-map-card">
    <button className="execution-map-head" onClick={onSelectOwner}>
      <span>
        <strong>{execution.label ?? execution.id}</strong>
        <small>{execution.authority} · {execution.source.label ?? execution.source.kind}</small>
        {execution.policy?.verifier && <small>Verifier: {execution.policy.verifier}</small>}
      </span>
      <em className={execution.incompleteReason ? "incomplete" : execution.status}>{execution.incompleteReason ? "incomplete" : execution.status}</em>
    </button>
    <div className="execution-node-list">
      {execution.nodes.map((node) => {
        const activation = latestByNode.get(node.id);
        const incomplete = Boolean(execution.incompleteReason
          && activation
          && ["queued", "running"].includes(activation.status));
        return <button
          className={`execution-node ${selectedNodeId === node.id ? "selected" : ""} ${incomplete ? "incomplete" : execution.activeNodeIds.includes(node.id) ? "active" : activation?.status ?? "pending"}`}
          key={node.id}
          onClick={() => onSelectNode(node.id)}
        >
          <small>{node.kind}{node.subgraphId ? " · subgraph" : ""}</small>
          <strong>{node.label}</strong>
          <em>{incomplete ? "incomplete" : activation?.status ?? "pending"}</em>
        </button>;
      })}
    </div>
    <div className="execution-edge-list">
      {execution.edges.map((edge) => <span className={edge.kind} key={edge.id}>
        <b>{edge.from}</b><i>{edge.kind === "loop-back" ? "↩" : "→"}</i><b>{edge.to}</b>
        <em>{edge.condition ?? edge.kind}</em>
        <small>{execution.traversals.filter((traversal) => traversal.edgeId === edge.id).length}×</small>
      </span>)}
    </div>
  </section>;
}

function GraphBranch({ agent, byParent, loops, selectedId, onSelect, seen }: { agent: AgentState; byParent: Map<string | undefined, AgentState[]>; loops: Map<string, LoopState>; selectedId?: string; onSelect: (id: string) => void; seen: Set<string> }) {
  if (seen.has(agent.threadId)) return null;
  const nextSeen = new Set(seen).add(agent.threadId);
  const children = byParent.get(agent.threadId) ?? [];
  return <div className="graph-branch">
    <AgentCard agent={agent} loop={loops.get(agent.threadId)} selected={selectedId === agent.threadId} onClick={() => onSelect(agent.threadId)} />
    {children.length > 0 && <div className="graph-children">{children.map((child) => <GraphBranch key={child.threadId} agent={child} byParent={byParent} loops={loops} selectedId={selectedId} onSelect={onSelect} seen={nextSeen} />)}</div>}
  </div>;
}

function AgentCard({ agent, loop, selected, onClick }: { agent: AgentState; loop?: LoopState; selected: boolean; onClick: () => void }) {
  return <button className={`agent-card ${selected ? "selected" : ""}`} onClick={onClick}>
    <span className={`node-light ${agent.activeTurnId ? "working" : agent.status}`} />
    <div><small>{loop ? `loop · ${loop.phase}` : agent.kind ? agent.kind.replace("-", " ") : agent.parentThreadId ? agent.role ?? "subagent" : "root engine"}</small><strong>{agentName(agent)}</strong><span>{agent.effective?.model ?? "model unknown"}</span></div>
    <b>{compact(agent.totalTokens)}</b>
  </button>;
}

function agentName(agent: AgentState) { return agent.nickname ?? agent.agentPath ?? (agent.parentThreadId ? agent.threadId.slice(0, 8) : "Root"); }
function compact(value?: number) { if (value === undefined) return "—"; return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value); }
function aggregateTokenSide(agents: AgentState[], side: "inputTokens" | "outputTokens"): number | undefined {
  const counted = agents.filter((agent) => agent.totalTokens !== undefined);
  if (counted.length === 0 || counted.some((agent) => agent[side] === undefined)) return undefined;
  return counted.reduce((sum, agent) => sum + agent[side]!, 0);
}
function visibleExecutions(snapshot: RunSnapshot): ExecutionGraphState[] {
  const strongerOwners = new Set(snapshot.executions
    .filter((execution) => execution.authority !== "legacy")
    .map((execution) => execution.ownerThreadId));
  return snapshot.executions.filter((execution) =>
    execution.authority !== "legacy" || !strongerOwners.has(execution.ownerThreadId),
  );
}
function formatMessageTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function attemptDuration(startedAt: string, completedAt?: string): string {
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return completedAt ? "duration unavailable" : "in progress";
  const seconds = Math.max(0, Math.round((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
function nodeAttemptActivity(
  agents: AgentState[],
  attempt?: ExecutionGraphState["activations"][number],
) {
  if (!attempt) return [];
  const start = Date.parse(attempt.startedAt);
  const end = attempt.completedAt ? Date.parse(attempt.completedAt) : Number.POSITIVE_INFINITY;
  const insideAttempt = (at: string) => {
    const value = Date.parse(at);
    return !Number.isFinite(value) || (value >= start && value <= end);
  };
  return agents.flatMap((agent) => [
    ...(agent.messages ?? [])
      .filter((message) => insideAttempt(message.at))
      .map((message) => ({ kind: "message" as const, agent, ...message })),
    ...(agent.activities ?? [])
      .filter((activity) => insideAttempt(activity.at))
      .map((activity) => ({ kind: "activity" as const, agent, ...activity })),
  ]).sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, 12);
}
function runOptionLabel(run: DashboardState["runs"][number]): string {
  return `${harnessDisplayName(run.adapter)} · ${run.projectName} · ${run.runId.slice(-8)} · ${run.activeAgents}/${run.agents}`;
}
function capabilityLabel(value: string): string {
  if (value === "modelOverride") return "MODEL OVERRIDE";
  if (value === "followUp") return "FOLLOW-UP";
  return value.toUpperCase();
}
function connectionLabel(state: DashboardState): string {
  if (!state.connected) return "No running sessions · Watchdog runtime offline";
  if (state.snapshot.mode === "observed") return `External ${harnessDisplayName(state.snapshot.adapter)} · near-live · read-only`;
  return `Live ${harnessDisplayName(state.snapshot.adapter)} runtime attached · WebSocket`;
}
type ControlResult = { parentNotified?: boolean; rootNotified?: boolean; directParent?: string; model?: string; effort?: string };

function controlNotice(body: unknown, result?: ControlResult): string {
  const action = body && typeof body === "object" && "action" in body ? String((body as { action: unknown }).action) : "";
  if (action === "interrupt") {
    if (result?.parentNotified) return "Agent stopped · parent automatically notified";
    if (result?.rootNotified) return `Agent stopped · root notified; direct parent ${result.directParent ?? "subagent"} cannot be steered`;
    return "Agent stopped";
  }
  if (action === "steer") return "Steering delivered to the active agent";
  if (action === "followUp") return "Follow-up queued";
  if (action === "retry") return `Retry started${result?.model ? ` · ${result.model}` : ""}${result?.effort ? ` · ${result.effort} effort` : ""}`;
  if (action === "loop.evidence") return "Evidence recorded";
  if (action === "loop.verify") return "Verification result recorded";
  if (action === "loop.configure") return "Loop configuration updated";
  if (action === "execution.stop") return "Execution control applied · affected agents were interrupted";
  if (action === "execution.node.retry") return "Execution node retry started with retained agent context";
  if (action === "execution.evidence") return "Execution evidence recorded";
  if (action === "execution.verify") return "Execution verification recorded";
  if (action === "execution.update") return "Execution policy updated";
  return "Control delivered";
}
function loopForAgent(snapshot: RunSnapshot, threadId?: string): LoopState | undefined {
  let current = threadId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const loop = snapshot.loops.find((candidate) => candidate.threadId === current);
    if (loop) return loop;
    current = snapshot.agents.find((agent) => agent.threadId === current)?.parentThreadId;
  }
  return undefined;
}

function executionForAgent(snapshot: RunSnapshot, agent?: AgentState): ExecutionGraphState | undefined {
  if (!agent) return undefined;
  if (agent.execution) return snapshot.executions.find((execution) => execution.id === agent.execution?.executionId);
  return [...snapshot.executions].reverse().find((execution) =>
    execution.ownerThreadId === agent.threadId
    || execution.activations.some((activation) => activation.threadIds.includes(agent.threadId)),
  );
}

function agentAncestry(snapshot: RunSnapshot, agent: AgentState): AgentState[] {
  const trail: AgentState[] = [];
  const seen = new Set<string>();
  let current: AgentState | undefined = agent;
  while (current && !seen.has(current.threadId)) {
    seen.add(current.threadId);
    trail.unshift(current);
    current = current.parentThreadId
      ? snapshot.agents.find((candidate) => candidate.threadId === current?.parentThreadId)
      : undefined;
  }
  return trail;
}

function runExecutionWarnings(snapshot: RunSnapshot): string[] {
  return visibleExecutions(snapshot).flatMap((execution) => {
    const owner = snapshot.agents.find((agent) => agent.threadId === execution.ownerThreadId);
    const prefix = owner ? `${agentName(owner)} · ` : "";
    return execution.warnings.map((warning) => `${prefix}${warning}`);
  });
}
