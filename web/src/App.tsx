import { useEffect, useState } from "react";
import { harnessDisplayName, harnessSlug } from "./harness";
import { Reveal } from "./Reveal";
import { YardCanvas } from "./YardCanvas";
import type { AgentCapabilities, AgentState, DashboardState, LoopState, RunSnapshot } from "./types";

type View = "yard" | "operator";
type Light = "day" | "night";

const empty: DashboardState = { connected: false, snapshot: { startedAt: new Date().toISOString(), mode: "live", agents: [], loops: [] }, runs: [] };

export function App() {
  if (window.location.pathname.replace(/\/+$/, "") === "/reveal") return <Reveal />;
  return <Dashboard />;
}

function Dashboard() {
  const demoPage = window.location.pathname.replace(/\/+$/, "") === "/demo";
  const pageView = demoPage ? "demo" : "live";
  const [state, setState] = useState<DashboardState>(empty);
  const [requestedRunId, setRequestedRunId] = useState<string>();
  const [view, setView] = useState<View>("yard");
  const [light, setLight] = useState<Light>(() => new Date().getHours() >= 19 || new Date().getHours() < 7 ? "night" : "day");
  const [selectedId, setSelectedId] = useState<string>();
  const [petNonce, setPetNonce] = useState(0);
  const [notice, setNotice] = useState("Waking the yard…");

  useEffect(() => {
    let mounted = true;
    let socket: WebSocket | undefined;
    let reconnect: number | undefined;
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const query = new URLSearchParams({ view: pageView });
      if (requestedRunId) query.set("run", requestedRunId);
      socket = new WebSocket(`${protocol}//${window.location.host}/ws?${query}`);
      socket.onmessage = (event) => {
        if (!mounted) return;
        const next = JSON.parse(String(event.data)) as DashboardState;
        setState(next);
        setRequestedRunId((current) => next.selectedRunId ?? (current && next.runs.some((run) => run.runId === current) ? current : undefined));
        setSelectedId((current) => current && next.snapshot.agents.some((agent) => agent.threadId === current) ? current : next.snapshot.agents[0]?.threadId);
        setNotice((current) => current === "Waking the yard…" || current === "Dashboard bridge reconnecting…" || current === "Switching Watchdog run…" ? connectionLabel(next, demoPage) : current);
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
  }, [demoPage, pageView, requestedRunId]);

  const selected = state.snapshot.agents.find((agent) => agent.threadId === selectedId) ?? state.snapshot.agents[0];
  const roots = state.snapshot.agents.filter((agent) => !agent.parentThreadId);
  const active = state.snapshot.agents.filter((agent) => agent.activeTurnId).length;
  const tokens = state.snapshot.agents.reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0);
  const loop = state.snapshot.loops[0];
  const hasRun = state.snapshot.agents.length > 0;
  const controllable = state.connected && state.snapshot.mode === "live";
  const simulated = state.snapshot.adapter?.transport === "simulation";
  const harness = harnessDisplayName(state.snapshot.adapter);

  const control = async (body: unknown) => {
    if (!controllable) {
      setNotice(state.snapshot.mode === "observed"
        ? "Observed sessions are read-only · relaunch with watchdog codex"
        : demoPage ? "Demo preview is read-only · run watchdog demo for controls" : "No live Watchdog runtime is connected");
      return;
    }
    try {
      const query = new URLSearchParams({ view: pageView });
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
        <Summary label="Loops" value={String(state.snapshot.loops.length)} />
        <Summary label="Agents" value={`${active}/${state.snapshot.agents.length}`} accent={active > 0} />
        <Summary label="Tokens" value={compact(tokens)} />
        <Summary label="Iteration" value={loop ? `#${loop.iteration}` : "—"} />
      </div>
      <div className="top-actions">
        {state.runs.length > 0 && <label className="run-picker">
          <span>RUN</span>
          <select value={state.selectedRunId ?? ""} onChange={(event) => {
            setRequestedRunId(event.target.value);
            setSelectedId(undefined);
            setNotice("Switching Watchdog run…");
          }} aria-label="Watchdog run">
            {state.runs.map((run) => <option value={run.runId} key={run.runId}>{runOptionLabel(run)}</option>)}
          </select>
        </label>}
        <a className="page-switch" href={demoPage ? "/" : "/demo"}>{demoPage ? "LIVE" : "DEMO"}</a>
        {hasRun && <div className="segmented" aria-label="Dashboard view">
          <button className={view === "yard" ? "active" : ""} onClick={() => setView("yard")}>YARD</button>
          <button className={view === "operator" ? "active" : ""} onClick={() => setView("operator")}>OPERATOR</button>
        </div>}
        <button className="light-toggle" onClick={() => setLight((value) => value === "day" ? "night" : "day")} aria-label="Toggle day and night">{light === "day" ? "☀" : "☾"}</button>
      </div>
    </header>

    <section className="status-strip">
      <span className={`live-dot ${demoPage || simulated ? "demo" : state.connected ? state.snapshot.mode === "observed" ? "observed" : "connected" : ""}`} />
      <span>{notice}</span>
      {state.connected && <span className={`harness-badge harness-${harnessSlug(state.snapshot.adapter)}`}>WATCHING {harness}</span>}
      <span className="objective">{loop?.objective ?? roots[0]?.task ?? state.message ?? "Waiting for task input"}</span>
      {loop?.warnings.map((warning) => <span className="warning" key={warning}>⚠ {warning}</span>)}
    </section>

    {hasRun
      ? <div className="workspace">
        <section className={`stage ${view}`}>
          {view === "yard"
            ? <YardCanvas snapshot={state.snapshot} selectedId={selected?.threadId} onSelect={setSelectedId} light={light} petNonce={petNonce} onPet={() => setPetNonce((value) => value + 1)} />
            : <Operator snapshot={state.snapshot} selectedId={selected?.threadId} onSelect={setSelectedId} />}
        </section>
        <Inspector agent={selected} loop={loopForAgent(state.snapshot, selected?.threadId)} connected={controllable} capabilities={selected ? state.snapshot.capabilities?.[selected.threadId] : undefined} onControl={control} />
      </div>
      : <EmptyRun
        connected={state.connected}
        snapshot={state.snapshot}
        light={light}
        petNonce={petNonce}
        onPet={() => setPetNonce((value) => value + 1)}
      />}

    <footer>
      <span>{demoPage ? "DEMO YARD" : state.connected ? `${harness} YARD` : "THE YARD"} · LOCALHOST</span>
      <span>{hasRun ? "click dog to pet · trains to inspect · tower for root" : "waiting for a Watchdog-owned run"}</span>
      <span>{light.toUpperCase()} SHIFT</span>
    </footer>
  </main>;
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
          ? "Watchdog is online. Start a Codex turn and its task and subagents will roll into the yard."
          : "Launch Codex through Watchdog to bring the yard online."}</p>
        <CopyCommand value="watchdog codex" />
        <a href="/demo">Explore the demo yard →</a>
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

function Inspector({ agent, loop, connected, capabilities, onControl }: { agent?: AgentState; loop?: LoopState; connected: boolean; capabilities?: AgentCapabilities; onControl: (body: unknown) => Promise<void> }) {
  const [steer, setSteer] = useState("");
  const [loopNote, setLoopNote] = useState("");
  const [verifier, setVerifier] = useState("");
  const [retryMessage, setRetryMessage] = useState("");
  const [retryModel, setRetryModel] = useState("");
  const [retryEffort, setRetryEffort] = useState("");
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
  const canRetry = connected && (capabilities?.retry.available ?? !isChild);
  const canOverride = capabilities?.modelOverride.available ?? !isChild;
  const assignment = agent.requested?.prompt ?? agent.task;
  const requestedModel = agent.requested?.model ?? "no override";
  const requestedEffort = agent.requested?.effort ? `${agent.requested.effort} effort` : "default effort";
  const messages = agent.messages?.length
    ? agent.messages
    : agent.latestMessage ? [{ id: "legacy-latest", text: agent.latestMessage, at: agent.lastActivityAt ?? agent.startedAt ?? "" }] : [];
  const messageCount = agent.messageCount ?? messages.length;
  return <aside className="inspector">
    <div className="inspector-head">
      <div><small>{isChild ? "SUBAGENT CAR" : "ROOT ENGINE"}</small><h2>{agentName(agent)}</h2></div>
      <span className={`status-badge ${agent.activeTurnId ? "working" : agent.status}`}>{agent.activeTurnId ? "WORKING" : agent.status.toUpperCase()}</span>
    </div>
    <div className="thread-id">{agent.threadId}</div>

    {assignment && <section className="task"><label>{isChild ? "ASSIGNMENT" : "TASK"}</label><p>{assignment}</p></section>}

    <section className="panel-block"><label>CURRENT ACTION</label><strong>{agent.latestActivity?.tool ?? (agent.activeTurnId ? "Working" : "No active turn")}</strong><span>{agent.latestActivity?.status ?? (agent.activeTurnId ? "Awaiting the next activity event" : agent.status)}</span></section>

    {(agent.streamingMessage || messages.length > 0) && <section className="message-history">
      <header><label>MESSAGE HISTORY</label><span>{messageCount} saved · newest first</span></header>
      {agent.streamingMessage && <article className="message-entry streaming">
        <div><strong>LIVE RESPONSE</strong><time>{formatMessageTime(agent.streamingMessage.updatedAt)}</time></div>
        <p>{agent.streamingMessage.text}<i aria-hidden="true">▋</i></p>
      </article>}
      {[...messages].reverse().map((message, index) => <article className={`message-entry ${index === 0 ? "latest" : ""}`} key={message.id}>
        <div><strong>{index === 0 ? "LATEST" : "MESSAGE"}</strong><time>{formatMessageTime(message.at)}</time></div>
        <p>{message.text}</p>
      </article>)}
      {messageCount > messages.length && <small className="history-truncated">Showing the latest {messages.length}; complete history remains in the Watchdog run trace.</small>}
    </section>}

    <div className="meter-row">
      <Metric label="TOKENS" value={compact(agent.totalTokens)} sub={`${compact(agent.outputTokens)} out`} />
      <Metric label="ROLE" value={agent.role ?? (isChild ? "worker" : "orchestrator")} />
    </div>

    <section className={`config-card ${mismatch ? "mismatch" : ""}`}>
      <div><label>REQUESTED</label><strong>{requestedModel}</strong><span>{requestedEffort}</span></div>
      <div className="config-arrow">→</div>
      <div><label>EFFECTIVE</label><strong>{agent.effective?.model ?? "unknown"}</strong><span>{agent.effective?.effort ?? "default"} effort</span></div>
      {mismatch && <em>MODEL MISMATCH</em>}
    </section>

    {loop && <section className={`loop-card ${loop.phase}`}>
      <div><label>{isChild ? "PARENT LOOP" : "LOOP"} · ITERATION {loop.iteration}</label><strong>{loop.phase.toUpperCase()}</strong></div>
      <p>{loop.objective ?? "Objective not captured"}</p>
      <span>Verifier: {loop.verifier ?? "not declared"}</span>
      <span>Evidence: {loop.evidence.length} · Verification: {loop.verification.status}</span>
      <span>Budget: {compact(loop.budget.usedTokens)} / {compact(loop.budget.maxTokens)} tokens · {loop.iteration}/{loop.budget.maxIterations ?? "∞"} iterations</span>
      {loop.budget.maxTokens && <div className="budget-track"><i style={{ width: `${Math.min(100, loop.budget.usedTokens / loop.budget.maxTokens * 100)}%` }} /></div>}
      {loop.evidence.slice(-2).map((item) => <q key={item.id}>{item.summary}</q>)}
      {loop.warnings.map((warning) => <span className="loop-warning" key={warning}>⚠ {warning}</span>)}
    </section>}

    <section className="controls">
      <label>CAPABILITIES</label>
      {capabilities && <div className="capability-grid">
        {Object.entries(capabilities).map(([name, capability]) => <span className={capability.available ? "available" : "unavailable"} title={capability.reason} key={name}>{capability.available ? "●" : "○"} {capabilityLabel(name)}</span>)}
      </div>}
      {agent.activeTurnId && <button className="stop" disabled={!canStop} title={capabilities?.interrupt.reason} onClick={() => void onControl({ action: "interrupt", agent: agent.threadId })}>■ STOP {isChild ? "CAR" : "ENGINE"}</button>}
      {!isChild && agent.activeTurnId && <form onSubmit={(event) => { event.preventDefault(); if (steer.trim()) void onControl({ action: "steer", agent: agent.threadId, message: steer.trim() }); setSteer(""); }}>
        <input value={steer} onChange={(event) => setSteer(event.target.value)} placeholder="Steer the root engine…" disabled={!canSteer} title={capabilities?.steer.reason} />
        <button type="submit" disabled={!canSteer || !steer.trim()}>SEND</button>
      </form>}
      {isChild && <p className="capability-note">{capabilities?.steer.reason ?? "Native Codex child: inspect + stop. Steering routes through its parent."}</p>}
      {!isChild && <div className="retry-controls">
        <label>{agent.activeTurnId ? "INTERRUPT + RETRY ROOT" : "START NEXT ROOT TURN"}</label>
        <form className="retry-form" onSubmit={(event) => {
          event.preventDefault();
          if (!retryMessage.trim()) return;
          void onControl({ action: "retry", agent: agent.threadId, message: retryMessage.trim(), model: retryModel.trim() || undefined, effort: retryEffort || undefined });
          setRetryMessage("");
        }}>
          <input className="retry-message" value={retryMessage} onChange={(event) => setRetryMessage(event.target.value)} placeholder="What should the next turn do?" disabled={!canRetry} />
          <input value={retryModel} onChange={(event) => setRetryModel(event.target.value)} placeholder="Model override (optional)" disabled={!canRetry || !canOverride} />
          <select value={retryEffort} onChange={(event) => setRetryEffort(event.target.value)} disabled={!canRetry || !canOverride} aria-label="Reasoning effort override">
            <option value="">Default effort</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option>
          </select>
          <button type="submit" disabled={!canRetry || !retryMessage.trim()}>↻ RETRY TURN</button>
        </form>
        {!canRetry && <p className="capability-note">{capabilities?.retry.reason}</p>}
      </div>}
      {loop && <div className="loop-controls">
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

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="metric"><label>{label}</label><strong>{value}</strong>{sub && <span>{sub}</span>}</div>;
}

function Operator({ snapshot, selectedId, onSelect }: { snapshot: RunSnapshot; selectedId?: string; onSelect: (id: string) => void }) {
  const roots = snapshot.agents.filter((agent) => !agent.parentThreadId);
  const byParent = new Map<string | undefined, AgentState[]>();
  for (const agent of snapshot.agents) byParent.set(agent.parentThreadId, [...(byParent.get(agent.parentThreadId) ?? []), agent]);
  const loops = new Map(snapshot.loops.map((loop) => [loop.threadId, loop]));
  return <div className="operator-view">
    <div className="operator-title"><div><small>{harnessDisplayName(snapshot.adapter)} · RUN TOPOLOGY</small><h1>Execution graph</h1></div><span>{snapshot.agents.length} nodes · {snapshot.loops.length} loops</span></div>
    <div className="graph">
      <div className="graph-forest">{roots.map((root) => <GraphBranch key={root.threadId} agent={root} byParent={byParent} loops={loops} selectedId={selectedId} onSelect={onSelect} seen={new Set()} />)}</div>
    </div>
    <div className="timeline">
      <header><strong>ACTIVITY</strong><span>live normalized state</span></header>
      {snapshot.agents.map((agent) => <button key={agent.threadId} onClick={() => onSelect(agent.threadId)}><span className={agent.activeTurnId ? "pulse" : ""} /><strong>{agentName(agent)}</strong><em>{agent.latestActivity?.tool ?? agent.status}</em><time>{compact(agent.totalTokens)} tok</time></button>)}
    </div>
  </div>;
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
    <div><small>{loop ? `loop · ${loop.phase}` : agent.parentThreadId ? agent.role ?? "subagent" : "root engine"}</small><strong>{agentName(agent)}</strong><span>{agent.effective?.model ?? "model unknown"}</span></div>
    <b>{compact(agent.totalTokens)}</b>
  </button>;
}

function agentName(agent: AgentState) { return agent.nickname ?? agent.agentPath ?? (agent.parentThreadId ? agent.threadId.slice(0, 8) : "Root"); }
function compact(value?: number) { if (value === undefined) return "—"; return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value); }
function formatMessageTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function runOptionLabel(run: DashboardState["runs"][number]): string {
  return `${harnessDisplayName(run.adapter)} · ${run.projectName} · ${run.runId.slice(-8)} · ${run.activeAgents}/${run.agents}`;
}
function capabilityLabel(value: string): string { return value === "modelOverride" ? "MODEL OVERRIDE" : value.toUpperCase(); }
function connectionLabel(state: DashboardState, demoPage: boolean): string {
  if (!state.connected) return demoPage ? "DEMO YARD · read-only preview" : "No running sessions · Watchdog runtime offline";
  if (state.snapshot.adapter?.transport === "simulation") return "SIMULATED DEMO · deterministic rehearsal · controls enabled";
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
  if (action === "steer") return "Steering delivered to active root";
  if (action === "retry") return `Retry started${result?.model ? ` · ${result.model}` : ""}${result?.effort ? ` · ${result.effort} effort` : ""}`;
  if (action === "loop.evidence") return "Evidence recorded";
  if (action === "loop.verify") return "Verification result recorded";
  if (action === "loop.configure") return "Loop configuration updated";
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
