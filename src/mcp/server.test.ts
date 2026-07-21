import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ControlRequest } from "../runtime/control.js";
import { connectWatchdogMcp, createWatchdogMcpServer } from "./server.js";

describe("Watchdog MCP bridge", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("exposes Codex execution instrumentation and scopes declarations to the selected run", async () => {
    const requests: ControlRequest[] = [];
    const server = createWatchdogMcpServer(async (request) => {
      requests.push(request);
      if (request.action === "snapshot") return { executions: [] };
      return { id: "repair", status: "pending" };
    });
    const client = new Client({ name: "watchdog-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await connectWatchdogMcp(server, serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => {
      await client.close();
      await server.close();
    });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("watchdog_execution");

    const result = await client.callTool({
      name: "watchdog_execution",
      arguments: {
        action: "declare",
        executionId: "repair",
        objective: "Repair until verified",
        verifier: "the regression suite passes",
        maxIterations: 3,
        nodes: [
          { id: "patch", label: "PATCH", kind: "action" },
          { id: "verify", label: "VERIFY", kind: "verifier" },
        ],
        edges: [
          { id: "check", from: "patch", to: "verify", kind: "normal" },
          { id: "retry", from: "verify", to: "patch", kind: "loop-back" },
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    const evidence = await client.callTool({
      name: "watchdog_execution",
      arguments: {
        action: "evidence",
        executionId: "repair",
        nodeId: "verify",
        summary: "Regression failure reproduced.",
      },
    });
    expect(evidence.isError).not.toBe(true);
    expect(requests).toEqual([
      expect.objectContaining({
        action: "execution.declare",
        graph: expect.objectContaining({
          id: "repair",
          ownerThreadId: "root",
          authority: "declared",
          policy: { verifier: "the regression suite passes", maxIterations: 3 },
          nodes: [expect.objectContaining({ label: "PATCH" }), expect.objectContaining({ label: "VERIFY" })],
        }),
      }),
      {
        action: "execution.evidence",
        executionId: "repair",
        agent: "root",
        nodeId: "verify",
        summary: "Regression failure reproduced.",
        source: "Codex MCP instrumentation",
      },
    ]);
  });
});
