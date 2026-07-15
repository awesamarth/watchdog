import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import sirv from "sirv";
import { WebSocket, WebSocketServer } from "ws";
import { requestControl, type ControlRequest } from "../runtime/control.js";
import type { RunSnapshot } from "../runtime/state.js";

type DashboardState = { connected: boolean; snapshot: RunSnapshot; message?: string };

export async function runDashboard(args: string[]): Promise<void> {
  const port = parsePort(args);
  const serveStatic = sirv(join(process.cwd(), "web", "dist"), { single: true, dev: true });
  const sockets = new WebSocketServer({ noServer: true });
  let current = await dashboardState();
  let serialized = JSON.stringify(current);
  const refresh = async () => {
    const next = await dashboardState();
    const nextSerialized = JSON.stringify(next);
    if (nextSerialized === serialized) return;
    current = next;
    serialized = nextSerialized;
    for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.send(serialized);
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/api/state" && request.method === "GET") {
        return json(response, 200, await dashboardState());
      }
      if (request.url === "/api/control" && request.method === "POST") {
        const body = await readJson(request) as ControlRequest;
        const result = await requestControl(body);
        void refresh();
        return json(response, 200, { ok: true, result });
      }
      serveStatic(request, response);
    } catch (error) {
      json(response, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") return socket.destroy();
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
  });
  sockets.on("connection", (client) => client.send(JSON.stringify(current)));
  const refreshTimer = setInterval(() => void refresh(), 300);

  await new Promise<void>((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject));
  console.log(`[watchdog] dashboard: http://127.0.0.1:${port}`);
  console.log("[watchdog] start `watchdog codex` in another terminal for live data; demo mode is available without it");
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

async function dashboardState(): Promise<DashboardState> {
  try {
    return { connected: true, snapshot: await requestControl({ action: "snapshot" }) as RunSnapshot };
  } catch {
    return { connected: false, snapshot: DEMO_SNAPSHOT, message: "Demo yard · start watchdog codex for live data" };
  }
}

const DEMO_SNAPSHOT = demoSnapshot();

function demoSnapshot(): RunSnapshot {
  const root = "demo-root";
  return {
    startedAt: new Date(Date.now() - 284_000).toISOString(),
    mode: "live",
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
      { threadId: "demo-locke", parentThreadId: root, nickname: "Locke", role: "investigator", status: "active", activeTurnId: "demo-locke-turn", totalTokens: 22_184, outputTokens: 1_620, requested: { model: "gpt-5.6-luna", effort: "low", prompt: "Trace the checkout race and return evidence." }, effective: { model: "gpt-5.6-luna", effort: "low" }, latestActivity: { tool: "exec", status: "inProgress" } },
      { threadId: "demo-kepler", parentThreadId: root, nickname: "Kepler", role: "verifier", status: "active", activeTurnId: "demo-kepler-turn", totalTokens: 31_902, outputTokens: 2_090, requested: { model: "gpt-5.6-luna", effort: "low", prompt: "Reproduce and verify the proposed fix." }, effective: { model: "gpt-5.6-terra", effort: "medium" }, latestActivity: { tool: "test", status: "inProgress" } },
      { threadId: "demo-hopper", parentThreadId: root, nickname: "Hopper", role: "reviewer", status: "idle", totalTokens: 8_440, outputTokens: 702, requested: { prompt: "Review the patch for regressions." }, effective: { model: "gpt-5.6-luna", effort: "low" }, latestActivity: { tool: "review", status: "completed" } },
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body || "{}");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
