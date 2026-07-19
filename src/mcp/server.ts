import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { ControlRequest } from "../runtime/control.js";
import { requestControl } from "../runtime/control.js";
import type { RunSnapshot } from "../runtime/state.js";

const NODE_KINDS = ["stage", "action", "verifier", "wait", "subgraph", "terminal"] as const;
const EDGE_KINDS = ["normal", "success", "failure", "loop-back"] as const;
const NODE_END_STATUSES = ["passed", "failed", "stopped"] as const;
const EXECUTION_END_STATUSES = ["completed", "failed", "stopped", "blocked"] as const;

const NodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(NODE_KINDS).default("stage"),
  description: z.string().optional(),
  subgraphId: z.string().optional(),
});

const EdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(EDGE_KINDS).default("normal"),
  condition: z.string().optional(),
});

const ExecutionInputSchema = z.object({
  action: z.enum([
    "declare",
    "update",
    "list",
    "start_iteration",
    "start_node",
    "complete_node",
    "select_edge",
    "complete",
  ]),
  executionId: z.string().min(1).optional(),
  ownerAgent: z.string().min(1).optional(),
  label: z.string().optional(),
  objective: z.string().optional(),
  parentExecutionId: z.string().optional(),
  parentNodeId: z.string().optional(),
  nodes: z.array(NodeSchema).min(1).optional(),
  edges: z.array(EdgeSchema).optional(),
  entryNodeIds: z.array(z.string()).optional(),
  terminalNodeIds: z.array(z.string()).optional(),
  nodeId: z.string().optional(),
  activationId: z.string().optional(),
  edgeId: z.string().optional(),
  traversalId: z.string().optional(),
  iteration: z.number().int().min(1).optional(),
  status: z.enum([...NODE_END_STATUSES, ...EXECUTION_END_STATUSES, "running", "waiting"]).optional(),
  reason: z.string().optional(),
  summary: z.string().optional(),
});

type ExecutionInput = z.infer<typeof ExecutionInputSchema>;
type ControlRequester = (request: ControlRequest) => Promise<unknown>;

export function createWatchdogMcpServer(request: ControlRequester): McpServer {
  const server = new McpServer(
    { name: "watchdog", version: "0.0.1" },
    {
      instructions: [
        "Watchdog instruments explicit workflows, loops, and execution graphs in the active local agent run.",
        "Do not turn an ordinary one-shot task into a graph.",
        "Declare real semantic nodes before work starts, then report actual node starts, completions, and selected edges.",
        "A cycle is a loop. Use loop-back edges and increment the iteration only when another pass begins.",
        "Use a subgraph node plus matching parentExecutionId/parentNodeId for nested workflows.",
        "If internal stages are unknown, declare one honest opaque action node instead of inventing detail.",
      ].join(" "),
    },
  );

  server.registerTool(
    "watchdog_execution",
    {
      title: "Watchdog Execution",
      description: [
        "Declare, inspect, and instrument a real workflow, loop, or execution graph in Watchdog.",
        "This records semantic boundaries; it does not perform the work.",
        "Use action=list before declaring if the current run may already contain the graph.",
        "ownerAgent defaults to root and may be a Watchdog nickname or unique thread-id prefix.",
      ].join(" "),
      inputSchema: ExecutionInputSchema,
    },
    async (input) => {
      const result = await executeMcpOperation(input, request);
      return {
        content: [{ type: "text", text: summarizeResult(input, result) }],
        structuredContent: asObject(result),
      };
    },
  );

  return server;
}

export async function runWatchdogMcp(args: string[]): Promise<void> {
  const runId = option(args, "--run");
  const cwd = option(args, "--cwd");
  const server = createWatchdogMcpServer(async (request) => await requestControl(request, { runId, cwd }));
  await server.connect(new StdioServerTransport());
}

export async function connectWatchdogMcp(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(transport);
}

async function executeMcpOperation(input: ExecutionInput, request: ControlRequester): Promise<unknown> {
  if (input.action === "list") {
    const snapshot = await request({ action: "snapshot" }) as RunSnapshot;
    return { executions: snapshot.executions ?? [] };
  }

  const executionId = required(input.executionId, `${input.action} requires executionId`);
  if (input.action === "declare") {
    return await request({
      action: "execution.declare",
      graph: {
        id: executionId,
        ownerThreadId: input.ownerAgent ?? "root",
        label: input.label,
        objective: input.objective,
        source: { kind: "watchdog", label: "Codex MCP instrumentation" },
        authority: "declared",
        parentExecutionId: input.parentExecutionId,
        parentNodeId: input.parentNodeId,
        nodes: required(input.nodes, "declare requires nodes"),
        edges: input.edges ?? [],
        entryNodeIds: input.entryNodeIds ?? [],
        terminalNodeIds: input.terminalNodeIds ?? [],
      },
    });
  }
  if (input.action === "update") {
    return await request({
      action: "execution.update",
      executionId,
      nodes: input.nodes,
      edges: input.edges,
      entryNodeIds: input.entryNodeIds,
      terminalNodeIds: input.terminalNodeIds,
      objective: input.objective,
      label: input.label,
    });
  }
  if (input.action === "start_iteration") {
    return await request({
      action: "execution.iteration.start",
      executionId,
      iteration: required(input.iteration, "start_iteration requires iteration"),
      reason: input.reason,
    });
  }
  if (input.action === "start_node") {
    const status = input.status;
    if (status && status !== "running" && status !== "waiting") throw new Error("start_node status must be running or waiting");
    return await request({
      action: "execution.node.start",
      executionId,
      nodeId: required(input.nodeId, "start_node requires nodeId"),
      activationId: required(input.activationId, "start_node requires activationId"),
      agent: input.ownerAgent ?? "root",
      iteration: input.iteration,
      status,
    });
  }
  if (input.action === "complete_node") {
    const status = input.status;
    if (!status || !NODE_END_STATUSES.includes(status as typeof NODE_END_STATUSES[number])) {
      throw new Error("complete_node status must be passed, failed, or stopped");
    }
    return await request({
      action: "execution.node.complete",
      executionId,
      nodeId: required(input.nodeId, "complete_node requires nodeId"),
      activationId: required(input.activationId, "complete_node requires activationId"),
      status: status as typeof NODE_END_STATUSES[number],
      summary: input.summary,
    });
  }
  if (input.action === "select_edge") {
    return await request({
      action: "execution.edge.select",
      executionId,
      edgeId: required(input.edgeId, "select_edge requires edgeId"),
      traversalId: required(input.traversalId, "select_edge requires traversalId"),
      iteration: input.iteration,
    });
  }
  const status = input.status;
  if (!status || !EXECUTION_END_STATUSES.includes(status as typeof EXECUTION_END_STATUSES[number])) {
    throw new Error("complete status must be completed, failed, stopped, or blocked");
  }
  return await request({
    action: "execution.complete",
    executionId,
    status: status as typeof EXECUTION_END_STATUSES[number],
    reason: input.reason,
  });
}

function summarizeResult(input: ExecutionInput, result: unknown): string {
  if (input.action === "list") {
    const count = Array.isArray(asObject(result).executions) ? (asObject(result).executions as unknown[]).length : 0;
    return `Watchdog has ${count} explicit execution${count === 1 ? "" : "s"} in this run.`;
  }
  return `Watchdog recorded ${input.action} for execution '${input.executionId}'.`;
}

function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return required(args[index + 1], `${flag} requires a value`);
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
}
