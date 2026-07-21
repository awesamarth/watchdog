export type ExecutionAuthority = "authoritative" | "declared" | "legacy" | "suspected";
type ExecutionSourceKind = "harness" | "watchdog" | "operator" | "legacy" | "inferred";
type ExecutionNodeKind = "stage" | "action" | "verifier" | "wait" | "subgraph" | "terminal";
type ExecutionEdgeKind = "normal" | "success" | "failure" | "loop-back";
export type ExecutionStatus = "pending" | "running" | "waiting" | "blocked" | "completed" | "failed" | "stopped";
export type NodeActivationStatus = "queued" | "running" | "waiting" | "passed" | "failed" | "stopped";

type ExecutionSource = {
  kind: ExecutionSourceKind;
  label?: string;
};

export type ExecutionNodeDefinition = {
  id: string;
  label: string;
  kind: ExecutionNodeKind;
  description?: string;
  subgraphId?: string;
};

export type ExecutionEdgeDefinition = {
  id: string;
  from: string;
  to: string;
  kind: ExecutionEdgeKind;
  condition?: string;
};

export type ExecutionGraphDefinition = {
  id: string;
  ownerThreadId: string;
  label?: string;
  objective?: string;
  policy?: ExecutionPolicy;
  source: ExecutionSource;
  authority: ExecutionAuthority;
  parentExecutionId?: string;
  parentNodeId?: string;
  nodes: ExecutionNodeDefinition[];
  edges: ExecutionEdgeDefinition[];
  entryNodeIds: string[];
  terminalNodeIds: string[];
};

export type ExecutionPolicy = {
  verifier?: string;
  maxTokens?: number;
  maxIterations?: number;
};

export type ExecutionEvidence = {
  id: string;
  iteration: number;
  summary: string;
  source: string;
  threadId: string;
  nodeId?: string;
  at: string;
};

export type ExecutionVerification = {
  status: "not-run" | "running" | "passed" | "failed";
  summary?: string;
  at?: string;
};

export type NodeActivation = {
  id: string;
  nodeId: string;
  iteration: number;
  status: NodeActivationStatus;
  threadIds: string[];
  startedAt: string;
  completedAt?: string;
  summary?: string;
};

type EdgeTraversal = {
  id: string;
  edgeId: string;
  from: string;
  to: string;
  iteration: number;
  at: string;
};

export type ExecutionGraphState = ExecutionGraphDefinition & {
  status: ExecutionStatus;
  /**
   * Set on snapshots when harness work has gone idle but explicit graph
   * instrumentation still claims that work is running. This is presentation
   * truth, not a fabricated completion event.
   */
  incompleteReason?: string;
  iteration: number;
  activations: NodeActivation[];
  traversals: EdgeTraversal[];
  activeNodeIds: string[];
  startedAt?: string;
  completedAt?: string;
  stopReason?: string;
  evidence: ExecutionEvidence[];
  verification: ExecutionVerification;
  usedTokens: number;
  warnings: string[];
};

export const EXECUTION_AUTHORITY_RANK: Record<ExecutionAuthority, number> = {
  suspected: 0,
  legacy: 1,
  declared: 2,
  authoritative: 3,
};

export function legacyLoopExecutionId(threadId: string): string {
  return `legacy-loop:${threadId}`;
}

export function createLegacyLoopGraph(input: {
  threadId: string;
  objective?: string;
  verifier?: string;
}): ExecutionGraphDefinition {
  const id = legacyLoopExecutionId(input.threadId);
  return {
    id,
    ownerThreadId: input.threadId,
    label: input.objective ? "Loop" : undefined,
    objective: input.objective,
    policy: { verifier: input.verifier },
    source: { kind: "legacy", label: "Watchdog loop metadata" },
    authority: "legacy",
    nodes: [
      {
        id: "attempt",
        label: "ATTEMPT",
        kind: "action",
        description: "The harness owns this iteration body; its internal steps are not exposed.",
      },
      {
        id: "verify",
        label: "VERIFY",
        kind: "verifier",
        description: input.verifier,
      },
      { id: "done", label: "DONE", kind: "terminal" },
    ],
    edges: [
      { id: "attempt-to-verify", from: "attempt", to: "verify", kind: "normal" },
      { id: "verify-pass", from: "verify", to: "done", kind: "success", condition: "verifier passed" },
      { id: "verify-fail", from: "verify", to: "attempt", kind: "loop-back", condition: "verifier failed" },
    ],
    entryNodeIds: ["attempt"],
    terminalNodeIds: ["done"],
  };
}

export function normalizeExecutionGraph(definition: ExecutionGraphDefinition): ExecutionGraphDefinition {
  const id = requiredText(definition.id, "Execution id");
  const ownerThreadId = requiredText(definition.ownerThreadId, "Execution owner");
  if (Boolean(definition.parentExecutionId) !== Boolean(definition.parentNodeId)) {
    throw new Error(`Execution '${id}' must declare parentExecutionId and parentNodeId together.`);
  }
  if (definition.parentExecutionId === id) throw new Error(`Execution '${id}' cannot be its own parent.`);
  const nodes = uniqueById(definition.nodes.map((node) => ({
    ...node,
    id: requiredText(node.id, "Execution node id"),
    label: requiredText(node.label, `Execution node '${node.id}' label`),
    kind: node.kind ?? "stage",
  })));
  if (nodes.length === 0) throw new Error(`Execution '${id}' must declare at least one node.`);
  for (const node of nodes) {
    if (node.kind === "subgraph" && !node.subgraphId?.trim()) {
      throw new Error(`Execution subgraph node '${node.id}' must declare subgraphId.`);
    }
    if (node.subgraphId && node.kind !== "subgraph") {
      throw new Error(`Execution node '${node.id}' declares subgraphId but is not a subgraph node.`);
    }
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = uniqueById(definition.edges.map((edge) => {
    const normalized = {
      ...edge,
      id: requiredText(edge.id, "Execution edge id"),
      from: requiredText(edge.from, `Execution edge '${edge.id}' source`),
      to: requiredText(edge.to, `Execution edge '${edge.id}' target`),
      kind: edge.kind ?? "normal",
    };
    if (!nodeIds.has(normalized.from) || !nodeIds.has(normalized.to)) {
      throw new Error(`Execution edge '${normalized.id}' references an unknown node.`);
    }
    return normalized;
  }));
  const incoming = new Set(edges.map((edge) => edge.to));
  const outgoing = new Set(edges.map((edge) => edge.from));
  const entryNodeIds = normalizedNodeRefs(
    definition.entryNodeIds.length ? definition.entryNodeIds : nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id),
    nodeIds,
    "entry",
  );
  const terminalNodeIds = normalizedNodeRefs(
    definition.terminalNodeIds.length ? definition.terminalNodeIds : nodes.filter((node) => node.kind === "terminal" || !outgoing.has(node.id)).map((node) => node.id),
    nodeIds,
    "terminal",
  );
  return {
    ...definition,
    id,
    ownerThreadId,
    policy: normalizeExecutionPolicy(definition.policy),
    nodes,
    edges,
    entryNodeIds: entryNodeIds.length ? entryNodeIds : [nodes[0]!.id],
    terminalNodeIds,
  };
}

function normalizeExecutionPolicy(policy?: ExecutionPolicy): ExecutionPolicy {
  if (!policy) return {};
  const maxTokens = positiveInteger(policy.maxTokens, "Execution token budget");
  const maxIterations = positiveInteger(policy.maxIterations, "Execution iteration budget");
  return {
    verifier: policy.verifier?.trim() || undefined,
    maxTokens,
    maxIterations,
  };
}

function positiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

export function executionHasCycle(graph: Pick<ExecutionGraphDefinition, "nodes" | "edges">): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) if (visit(next)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return graph.nodes.some((node) => visit(node.id));
}

function requiredText(value: string, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} cannot be empty.`);
  return normalized;
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`Duplicate execution id '${value.id}'.`);
    ids.add(value.id);
  }
  return values;
}

function normalizedNodeRefs(values: string[], known: Set<string>, label: string): string[] {
  const refs = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  for (const ref of refs) if (!known.has(ref)) throw new Error(`Execution ${label} node '${ref}' does not exist.`);
  return refs;
}
