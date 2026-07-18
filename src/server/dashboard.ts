import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sirv from "sirv";
import { WebSocket, WebSocketServer } from "ws";
import { requestControlAt, RunUnavailableError, type ControlRequest } from "../runtime/control.js";
import { listRegisteredRuns, unregisterRun, type RegisteredRun } from "../runtime/registry.js";
import type { RunSnapshot } from "../runtime/state.js";

type RunListItem = {
  runId: string;
  projectName: string;
  cwd: string;
  startedAt: string;
  adapter: NonNullable<RunSnapshot["adapter"]>;
  agents: number;
  activeAgents: number;
  objective?: string;
};
type DashboardState = {
  connected: boolean;
  snapshot: RunSnapshot;
  message?: string;
  runs: RunListItem[];
  selectedRunId?: string;
};
type DashboardView = "live" | "demo";
type ActiveRun = { registration: RegisteredRun; snapshot: RunSnapshot };
type SocketSubscription = { view: DashboardView; runId?: string; serialized?: string };

export async function runDashboard(args: string[], options: { preferredView?: DashboardView } = {}): Promise<void> {
  const port = parsePort(args);
  const preferredCwd = resolve(process.cwd());
  const assets = dashboardAssetsPath();
  const serveStatic = sirv(assets, { single: true, dev: true });
  const sockets = new WebSocketServer({ noServer: true });
  const subscriptions = new Map<WebSocket, SocketSubscription>();
  let catalog = await runtimeCatalog();
  let refreshing = false;
  const refresh = async (force = false) => {
    if (refreshing) return;
    refreshing = true;
    try {
      catalog = await runtimeCatalog();
      for (const client of sockets.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        const subscription = subscriptions.get(client) ?? { view: "live" };
        const serialized = JSON.stringify(dashboardState(catalog, subscription.view, subscription.runId, preferredCwd));
        if (!force && serialized === subscription.serialized) continue;
        subscription.serialized = serialized;
        subscriptions.set(client, subscription);
        client.send(serialized);
      }
    } finally {
      refreshing = false;
    }
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const view = dashboardView(url);
      const requestedRunId = url.searchParams.get("run") ?? undefined;
      if (url.pathname === "/api/state" && request.method === "GET") {
        catalog = await runtimeCatalog();
        return json(response, 200, dashboardState(catalog, view, requestedRunId, preferredCwd));
      }
      if (url.pathname === "/api/control" && request.method === "POST") {
        catalog = await runtimeCatalog();
        const visible = dashboardState(catalog, view, requestedRunId, preferredCwd);
        const selected = catalog.find((run) => run.registration.runId === visible.selectedRunId);
        if (!visible.connected || !selected) {
          throw new Error(view === "demo"
            ? "The demo preview is read-only. Run `watchdog demo` to enable rehearsal controls."
            : "No live Watchdog runtime is connected.");
        }
        const body = await readJson(request) as ControlRequest;
        const result = await requestControlAt(selected.registration.socketPath, body);
        await refresh(true);
        return json(response, 200, { ok: true, result });
      }
      serveStatic(request, response);
    } catch (error) {
      json(response, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") return socket.destroy();
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
  });
  sockets.on("connection", (client, request) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const subscription: SocketSubscription = { view: dashboardView(url), runId: url.searchParams.get("run") ?? undefined };
    const serialized = JSON.stringify(dashboardState(catalog, subscription.view, subscription.runId, preferredCwd));
    subscription.serialized = serialized;
    subscriptions.set(client, subscription);
    client.once("close", () => subscriptions.delete(client));
    client.send(serialized);
  });
  const refreshTimer = setInterval(() => void refresh(), 300);

  try {
    await new Promise<void>((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject));
  } catch (error) {
    if (isAddressInUse(error)) throw new Error(`Dashboard port ${port} is already in use. Reuse that dashboard or choose another with \`--port <port>\`.`);
    throw error;
  }
  const preferredView = options.preferredView ?? "live";
  console.log(`[watchdog] dashboard: http://127.0.0.1:${port}${preferredView === "demo" ? "/demo" : ""}`);
  if (preferredView === "demo") {
    console.log("[watchdog] deterministic simulation is live; controls affect rehearsal state only");
  } else {
    console.log(`[watchdog] demo preview: http://127.0.0.1:${port}/demo`);
    console.log("[watchdog] start `watchdog codex` in another terminal for live data; `watchdog demo` enables interactive rehearsal controls");
  }
  await new Promise<void>((resolve) => {
    const close = () => {
      clearInterval(refreshTimer);
      for (const client of sockets.clients) client.close();
      sockets.close();
      server.close(() => resolve());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

export function dashboardAssetsPath(cwd = process.cwd(), moduleUrl = import.meta.url): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    process.env.WATCHDOG_WEB_DIST,
    join(cwd, "web", "dist"),
    join(moduleDirectory, "..", "web", "dist"),
    join(moduleDirectory, "..", "..", "web", "dist"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(join(candidate, "index.html")));
  if (found) return found;
  throw new Error("Dashboard assets are missing. Run `bun run web:build` when developing, or reinstall the Watchdog package.");
}

async function runtimeCatalog(): Promise<ActiveRun[]> {
  const registrations = await listRegisteredRuns();
  const runs = await Promise.all(registrations.map(async (registration) => {
    try {
      return {
        registration,
        snapshot: await requestControlAt(registration.socketPath, { action: "snapshot" }, 2_000) as RunSnapshot,
      };
    } catch (error) {
      if (error instanceof RunUnavailableError) await unregisterRun(registration.runId);
      return undefined;
    }
  }));
  return runs.filter((run): run is ActiveRun => Boolean(run));
}

function dashboardState(catalog: ActiveRun[], view: DashboardView, requestedRunId: string | undefined, preferredCwd: string): DashboardState {
  const compatible = catalog.filter((run) => (run.snapshot.adapter ?? run.registration.adapter).transport === "simulation" ? view === "demo" : view === "live");
  const selected = compatible.find((run) => run.registration.runId === requestedRunId)
    ?? compatible.find((run) => run.registration.cwd === preferredCwd)
    ?? compatible[0];
  const runs = compatible.map(runListItem);
  if (view === "demo") {
    if (selected) return { connected: true, snapshot: selected.snapshot, runs, selectedRunId: selected.registration.runId };
    return {
      connected: false,
      snapshot: DEMO_SNAPSHOT,
      message: "Demo yard · read-only preview · run watchdog demo for controls",
      runs,
    };
  }
  if (!selected) {
    return {
      connected: false,
      snapshot: EMPTY_SNAPSHOT,
      message: "Launch with watchdog codex to bring the yard online",
      runs,
    };
  }
  return { connected: true, snapshot: selected.snapshot, runs, selectedRunId: selected.registration.runId };
}

function runListItem(run: ActiveRun): RunListItem {
  return {
    runId: run.registration.runId,
    projectName: run.registration.projectName,
    cwd: run.registration.cwd,
    startedAt: run.registration.startedAt,
    adapter: run.snapshot.adapter ?? run.registration.adapter,
    agents: run.snapshot.agents.length,
    activeAgents: run.snapshot.agents.filter((agent) => agent.activeTurnId).length,
    objective: run.snapshot.loops[0]?.objective ?? run.snapshot.agents.find((agent) => !agent.parentThreadId)?.task,
  };
}

function dashboardView(url: URL): DashboardView {
  return url.searchParams.get("view") === "demo" ? "demo" : "live";
}

const EMPTY_SNAPSHOT: RunSnapshot = {
  startedAt: new Date().toISOString(),
  mode: "live",
  agents: [],
  loops: [],
};

const DEMO_SNAPSHOT = demoSnapshot();

function demoSnapshot(): RunSnapshot {
  const root = "demo-root";
  return {
    startedAt: new Date(Date.now() - 284_000).toISOString(),
    mode: "live",
    adapter: { harness: "watchdog-demo", transport: "simulation", mode: "live", label: "Watchdog deterministic simulation" },
    loops: [{
      threadId: root,
      objective: "Repair the flaky checkout flow and prove the fix",
      iteration: 3,
      activeTurnId: "demo-turn",
      phase: "execute",
      verifier: "20 clean checkout runs and the regression suite passes",
      verification: { status: "running", summary: "12/20 clean runs" },
      evidence: [
        { id: "demo-proof-1", iteration: 2, summary: "Race reproduced when two payment callbacks overlap", source: "Locke", agentThreadId: "demo-locke", at: new Date(Date.now() - 90_000).toISOString() },
        { id: "demo-proof-2", iteration: 3, summary: "Regression suite is green; soak verification still running", source: "Turing", agentThreadId: "demo-turing", at: new Date(Date.now() - 25_000).toISOString() },
      ],
      budget: { maxTokens: 200_000, maxIterations: 5, usedTokens: 166_354 },
      warnings: ["Kepler model differs from request"],
    }, {
      threadId: "demo-curie",
      objective: "Trace payment mutations and return one reproducible cause",
      iteration: 2,
      activeTurnId: "demo-curie-turn",
      phase: "verify",
      verifier: "A nested verifier reproduces the mutation ordering",
      verification: { status: "running" },
      evidence: [{ id: "nested-proof-1", iteration: 1, summary: "Duplicate callback enters before the first transaction commits", source: "Curie", agentThreadId: "demo-curie", at: new Date(Date.now() - 40_000).toISOString() }],
      budget: { maxTokens: 45_000, maxIterations: 3, usedTokens: 25_112 },
      warnings: [],
    }],
    agents: [
      { threadId: root, status: "active", activeTurnId: "demo-turn", totalTokens: 68_420, outputTokens: 4_812, effective: { model: "gpt-5.6-terra", effort: "medium" }, latestActivity: { tool: "wait", status: "inProgress" } },
      { threadId: "demo-locke", parentThreadId: root, nickname: "Locke", role: "investigator", status: "active", activeTurnId: "demo-locke-turn", totalTokens: 22_184, outputTokens: 1_620, requested: { model: "gpt-5.6-luna", effort: "low", prompt: "Trace the checkout race and return evidence." }, effective: { model: "gpt-5.6-luna", effort: "low" }, latestActivity: { tool: "exec", status: "inProgress" }, latestMessage: "Race reproduced; checking callback ordering before the final report.", messages: [{ id: "demo-locke-note", text: "Started tracing the checkout callback ordering.", at: new Date(Date.now() - 55_000).toISOString() }, { id: "demo-locke-report", text: "Race reproduced; checking callback ordering before the final report.", at: new Date(Date.now() - 18_000).toISOString() }], messageCount: 2, streamingMessage: { itemId: "demo-locke-live", text: "Preparing the next verified update…", startedAt: new Date(Date.now() - 2_000).toISOString(), updatedAt: new Date().toISOString() } },
      { threadId: "demo-kepler", parentThreadId: root, nickname: "Kepler", role: "verifier", status: "active", activeTurnId: "demo-kepler-turn", totalTokens: 31_902, outputTokens: 2_090, requested: { model: "gpt-5.6-luna", effort: "low", prompt: "Reproduce and verify the proposed fix." }, effective: { model: "gpt-5.6-terra", effort: "medium" }, latestActivity: { tool: "test", status: "inProgress" } },
      { threadId: "demo-hopper", parentThreadId: root, nickname: "Hopper", role: "reviewer", status: "active", activeTurnId: "demo-hopper-turn", totalTokens: 8_440, outputTokens: 702, requested: { prompt: "Review the patch for regressions." }, effective: { model: "gpt-5.6-luna", effort: "low" }, latestActivity: { tool: "review", status: "inProgress" } },
      { threadId: "demo-curie", parentThreadId: root, nickname: "Curie", role: "investigator", status: "active", activeTurnId: "demo-curie-turn", totalTokens: 16_208, outputTokens: 1_044, requested: { model: "gpt-5.6-luna", effort: "low", prompt: "Inspect payment traces for duplicate mutations." }, effective: { model: "gpt-5.6-luna", effort: "low" }, latestActivity: { tool: "search", status: "inProgress" } },
      { threadId: "demo-turing", parentThreadId: root, nickname: "Turing", role: "verifier", status: "active", activeTurnId: "demo-turing-turn", totalTokens: 12_880, outputTokens: 934, requested: { model: "gpt-5.6-luna", effort: "medium", prompt: "Build a minimal deterministic regression case." }, effective: { model: "gpt-5.6-luna", effort: "medium" }, latestActivity: { tool: "exec", status: "inProgress" } },
      { threadId: "demo-ada", parentThreadId: root, nickname: "Ada", role: "reviewer", status: "idle", totalTokens: 6_320, outputTokens: 511, requested: { prompt: "Check the final evidence against the exit criterion." }, effective: { model: "gpt-5.6-luna", effort: "low" }, latestActivity: { tool: "wait", status: "completed" } },
      { threadId: "demo-feynman", parentThreadId: "demo-curie", nickname: "Feynman", role: "verifier", status: "active", activeTurnId: "demo-feynman-turn", totalTokens: 8_904, outputTokens: 608, requested: { model: "gpt-5.6-luna", effort: "low", prompt: "Independently reproduce Curie's proposed callback ordering." }, effective: { model: "gpt-5.6-luna", effort: "low" }, latestActivity: { tool: "test", status: "inProgress" } },
    ],
  };
}

function parsePort(args: string[]): number {
  const index = args.indexOf("--port");
  const value = index >= 0 ? Number(args[index + 1]) : 4242;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error("Usage: watchdog dashboard [--port <1-65535>]");
  return value;
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body || "{}");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
