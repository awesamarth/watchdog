import { useEffect, useMemo, useState } from "react";
import { YardCanvas } from "./YardCanvas";
import type { AgentCapabilities, AgentState, DashboardState, LoopState, RunSnapshot } from "./types";

type View = "yard" | "operator";
type Light = "day" | "night";

const empty: DashboardState = { connected: false, snapshot: { startedAt: new Date().toISOString(), mode: "live", agents: [], loops: [] } };

export function App() {
  const [state, setState] = useState<DashboardState>(empty);
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
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.onmessage = (event) => {
        if (!mounted) return;
        const next = JSON.parse(String(event.data)) as DashboardState;
        setState(next);
        setSelectedId((current) => current && next.snapshot.agents.some((agent) => agent.threadId === current) ? current : next.snapshot.agents[0]?.threadId);
        setNotice(!next.connected ? "Demo yard · no live controls" : next.snapshot.mode === "observed" ? "External Codex · near-live JSONL · read-only" : "Live runtime attached · WebSocket");
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
  }, []);

  const selected = state.snapshot.agents.find((agent) => agent.threadId === selectedId) ?? state.snapshot.agents[0];
  const roots = state.snapshot.agents.filter((agent) => !agent.parentThreadId);
  const active = state.snapshot.agents.filter((agent) => agent.activeTurnId).length;
  const tokens = state.snapshot.agents.reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0);
  const loop = state.snapshot.loops[0];
  const controllable = state.connected && state.snapshot.mode === "live";

  const control = async (body: unknown) => {
    if (!controllable) { setNotice(state.snapshot.mode === "observed" ? "Observed sessions are read-only · relaunch with watchdog codex" : "Demo yard is read-only · start watchdog codex"); return; }
    try {
      const response = await fetch("/api/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { ok: boolean; error?: string; result?: { parentNotified?: boolean } };
      if (!response.ok || !result.ok) throw new Error(result.error ?? "Control failed");
      setNotice(result.result?.parentNotified ? "Agent stopped · parent notified" : "Control delivered");
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
        <Summary label="Loops" value={String(Math.max(state.snapshot.loops.length, roots.length))} />
        <Summary label="Agents" value={`${active}/${state.snapshot.agents.length}`} accent={active > 0} />
        <Summary label="Tokens" value={compact(tokens)} />
        <Summary label="Iteration" value={loop ? `#${loop.iteration}` : "—"} />
      </div>
      <div className="top-actions">
        <div className="segmented" aria-label="Dashboard view">
          <button className={view === "yard" ? "active" : ""} onClick={() => setView("yard")}>YARD</button>
          <button className={view === "operator" ? "active" : ""} onClick={() => setView("operator")}>OPERATOR</button>
        </div>
        <button className="light-toggle" onClick={() => setLight((value) => value === "day" ? "night" : "day")} aria-label="Toggle day and night">{light === "day" ? "☀" : "☾"}</button>
      </div>
    </header>

    <section className="status-strip">
      <span className={`live-dot ${!state.connected ? "demo" : state.snapshot.mode === "observed" ? "observed" : "connected"}`} />
      <span>{notice}</span>
      <span className="objective">{loop?.objective ?? "Waiting for a loop objective"}</span>
      {loop?.warnings.map((warning) => <span className="warning" key={warning}>⚠ {warning}</span>)}
    </section>

    <div className="workspace">
      <section className="stage">
        {view === "yard"
          ? <YardCanvas snapshot={state.snapshot} selectedId={selected?.threadId} onSelect={setSelectedId} light={light} petNonce={petNonce} onPet={() => setPetNonce((value) => value + 1)} />
          : <Operator snapshot={state.snapshot} selectedId={selected?.threadId} onSelect={setSelectedId} />}
      </section>
      <Inspector agent={selected} loop={loopForAgent(state.snapshot, selected?.threadId)} connected={controllable} capabilities={selected ? state.snapshot.capabilities?.[selected.threadId] : undefined} onControl={control} />
    </div>

    <footer>
      <span>THE YARD · LOCALHOST</span><span>click dog to pet · trains to inspect · tower for root</span><span>{light.toUpperCase()} SHIFT</span>
    </footer>
  </main>;
}

function Summary({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return <div className="summary"><small>{label}</small><strong className={accent ? "accent" : ""}>{value}</strong></div>;
}

function Inspector({ agent, loop, connected, capabilities, onControl }: { agent?: AgentState; loop?: LoopState; connected: boolean; capabilities?: AgentCapabilities; onControl: (body: unknown) => Promise<void> }) {
  const [steer, setSteer] = useState("");
  const [loopNote, setLoopNote] = useState("");
  const [verifier, setVerifier] = useState("");
  if (!agent) return <aside className="inspector empty"><span>NO TRAIN SELECTED</span></aside>;
  const mismatch = agent.requested?.model && agent.effective?.model && agent.requested.model !== agent.effective.model;
  const isChild = Boolean(agent.parentThreadId);
  const canStop = connected && (capabilities?.interrupt.available ?? Boolean(agent.activeTurnId));
  const canSteer = connected && (capabilities?.steer.available ?? (!isChild && Boolean(agent.activeTurnId)));
  return <aside className="inspector">
    <div className="inspector-head">
      <div><small>{isChild ? "SUBAGENT CAR" : "ROOT ENGINE"}</small><h2>{agentName(agent)}</h2></div>
      <span className={`status-badge ${agent.activeTurnId ? "working" : agent.status}`}>{agent.activeTurnId ? "WORKING" : agent.status.toUpperCase()}</span>
    </div>
    <div className="thread-id">{agent.threadId}</div>

    {loop && <section className={`loop-card ${loop.phase}`}>
      <div><label>LOOP · ITERATION {loop.iteration}</label><strong>{loop.phase.toUpperCase()}</strong></div>
      <p>{loop.objective ?? "Objective not captured"}</p>
      <span>Verifier: {loop.verifier ?? "not declared"}</span>
      <span>Evidence: {loop.evidence.length} · Verification: {loop.verification.status}</span>
      <span>Budget: {compact(loop.budget.usedTokens)} / {compact(loop.budget.maxTokens)} tokens · {loop.iteration}/{loop.budget.maxIterations ?? "∞"} iterations</span>
      {loop.budget.maxTokens && <div className="budget-track"><i style={{ width: `${Math.min(100, loop.budget.usedTokens / loop.budget.maxTokens * 100)}%` }} /></div>}
      {loop.evidence.slice(-2).map((item) => <q key={item.id}>{item.summary}</q>)}
    </section>}

    <section className="panel-block"><label>CURRENT ACTION</label><strong>{agent.latestActivity?.tool ?? "Awaiting activity"}</strong><span>{agent.latestActivity?.status ?? "No recent tool event"}</span></section>

    <div className="meter-row">
      <Metric label="TOKENS" value={compact(agent.totalTokens)} sub={`${compact(agent.outputTokens)} out`} />
      <Metric label="ROLE" value={agent.role ?? (isChild ? "worker" : "orchestrator")} />
    </div>

    <section className={`config-card ${mismatch ? "mismatch" : ""}`}>
      <div><label>REQUESTED</label><strong>{agent.requested?.model ?? "not exposed"}</strong><span>{agent.requested?.effort ?? "default"} effort</span></div>
      <div className="config-arrow">→</div>
      <div><label>EFFECTIVE</label><strong>{agent.effective?.model ?? "unknown"}</strong><span>{agent.effective?.effort ?? "default"} effort</span></div>
      {mismatch && <em>MODEL MISMATCH</em>}
    </section>

    {agent.requested?.prompt && <section className="task"><label>ASSIGNMENT</label><p>{agent.requested.prompt}</p></section>}

    <section className="controls">
      <label>CAPABILITIES</label>
      {agent.activeTurnId && <button className="stop" disabled={!canStop} title={capabilities?.interrupt.reason} onClick={() => void onControl({ action: "interrupt", agent: agent.threadId })}>■ STOP {isChild ? "CAR" : "ENGINE"}</button>}
      {!isChild && agent.activeTurnId && <form onSubmit={(event) => { event.preventDefault(); if (steer.trim()) void onControl({ action: "steer", agent: agent.threadId, message: steer.trim() }); setSteer(""); }}>
        <input value={steer} onChange={(event) => setSteer(event.target.value)} placeholder="Steer the root engine…" disabled={!canSteer} title={capabilities?.steer.reason} />
        <button type="submit" disabled={!canSteer || !steer.trim()}>SEND</button>
      </form>}
      {isChild && <p className="capability-note">{capabilities?.steer.reason ?? "Native Codex child: inspect + stop. Steering routes through its parent."}</p>}
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
    <div className="operator-title"><div><small>RUN TOPOLOGY</small><h1>Execution graph</h1></div><span>{snapshot.agents.length} nodes · {snapshot.loops.length} loops</span></div>
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
