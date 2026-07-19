import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sirv from "sirv";
import { WebSocket, WebSocketServer } from "ws";
import { createDemoSnapshot } from "../demo/adapter.js";
import { listReachableRuns, requestControlAt, type ControlRequest, type ReachableRun } from "../runtime/control.js";
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
type ActiveRun = ReachableRun;
type SocketSubscription = { view: DashboardView; runId?: string; serialized?: string };
type DashboardOptions = { preferredView?: DashboardView; openBrowser?: boolean };

export async function runDashboard(args: string[], options: DashboardOptions = {}): Promise<void> {
  const port = parsePort(args);
  const preferredView = options.preferredView ?? "live";
  const url = dashboardUrl(port, preferredView);
  const shouldOpenBrowser = options.openBrowser ?? true;
  if (await isWatchdogDashboard(port)) {
    console.log(`[watchdog] dashboard already running: ${url}`);
    if (shouldOpenBrowser) await openBrowser(url);
    if (preferredView === "demo") await waitForTermination();
    return;
  }
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
      if (url.pathname === "/healthz" && request.method === "GET") {
        return json(response, 200, { service: "watchdog-dashboard" });
      }
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
  try {
    await new Promise<void>((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject));
  } catch (error) {
    if (isAddressInUse(error) && await isWatchdogDashboard(port)) {
      console.log(`[watchdog] dashboard already running: ${url}`);
      if (shouldOpenBrowser) await openBrowser(url);
      if (preferredView === "demo") await waitForTermination();
      return;
    }
    if (isAddressInUse(error)) throw new Error(`Dashboard port ${port} is already in use by another application. Choose another with \`--port <port>\`.`);
    throw error;
  }
  const refreshTimer = setInterval(() => void refresh(), 300);
  console.log(`[watchdog] dashboard: ${url}`);
  if (preferredView === "demo") {
    console.log("[watchdog] deterministic simulation is live; controls affect rehearsal state only");
  } else {
    console.log(`[watchdog] demo preview: http://127.0.0.1:${port}/demo`);
    console.log("[watchdog] start `watchdog codex` in another terminal for live data; `watchdog demo` enables interactive rehearsal controls");
  }
  if (shouldOpenBrowser) await openBrowser(url);
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

function dashboardUrl(port: number, view: DashboardView): string {
  return `http://127.0.0.1:${port}${view === "demo" ? "/demo" : ""}`;
}

async function isWatchdogDashboard(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    if (response.ok && (await response.json() as { service?: string }).service === "watchdog-dashboard") return true;
  } catch {
    // Older Watchdog dashboards do not expose /healthz.
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return false;
    const state = await response.json() as { connected?: unknown; snapshot?: unknown; runs?: unknown };
    return typeof state.connected === "boolean" && typeof state.snapshot === "object" && Array.isArray(state.runs);
  } catch {
    return false;
  }
}

export function browserOpenCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

async function openBrowser(url: string): Promise<void> {
  const { command, args } = browserOpenCommand(url);
  const opened = await new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
  console.log(opened
    ? `[watchdog] opened in your browser: ${url}`
    : `[watchdog] could not open a browser automatically; visit ${url}`);
}

async function waitForTermination(): Promise<void> {
  await new Promise<void>((resolve) => {
    const close = () => {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
      resolve();
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
  return (await listReachableRuns({ timeoutMs: 2_000 })).map((run) => ({
    registration: run.registration,
    snapshot: normalizeRunSnapshot(run.snapshot),
  }));
}

function normalizeRunSnapshot(snapshot: RunSnapshot): RunSnapshot {
  return {
    ...snapshot,
    agents: snapshot.agents ?? [],
    loops: snapshot.loops ?? [],
    executions: snapshot.executions ?? [],
  };
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
      message: "Launch a harness through Watchdog to bring the yard online",
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
    objective: run.snapshot.executions.find((execution) => !execution.parentExecutionId)?.objective
      ?? run.snapshot.loops[0]?.objective
      ?? run.snapshot.agents.find((agent) => !agent.parentThreadId)?.task,
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
  executions: [],
};

const DEMO_SNAPSHOT = createDemoSnapshot();

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
