export type AgentConfig = { model?: string; effort?: string };
export type AgentMessage = { id: string; text: string; at: string };
export type StreamingAgentMessage = { itemId: string; text: string; startedAt: string; updatedAt: string };
export type Capability = { available: boolean; reason?: string };
export type AgentCapabilities = {
  observe: Capability;
  steer: Capability;
  interrupt: Capability;
  retry: Capability;
  modelOverride: Capability;
};
export type AdapterDescriptor = { harness: string; transport: string; mode: "live" | "observed"; label: string };

export type AgentState = {
  threadId: string;
  parentThreadId?: string;
  nickname?: string;
  role?: string;
  agentPath?: string;
  status: string;
  activeTurnId?: string;
  totalTokens?: number;
  outputTokens?: number;
  requested?: AgentConfig & { prompt?: string };
  effective?: AgentConfig;
  latestActivity?: { tool: string; status: string };
  task?: string;
  latestMessage?: string;
  messages?: AgentMessage[];
  messageCount?: number;
  streamingMessage?: StreamingAgentMessage;
  startedAt?: string;
  lastActivityAt?: string;
};

export type LoopState = {
  threadId: string;
  objective?: string;
  iteration: number;
  activeTurnId?: string;
  phase: "plan" | "execute" | "verify" | "done" | "blocked";
  verifier?: string;
  verification: { status: "not-run" | "running" | "passed" | "failed"; summary?: string; at?: string };
  evidence: Array<{ id: string; iteration: number; summary: string; source: string; agentThreadId: string; at: string }>;
  budget: { maxTokens?: number; maxIterations?: number; usedTokens: number };
  warnings: string[];
};

export type RunSnapshot = {
  startedAt: string;
  mode: "live" | "observed";
  agents: AgentState[];
  loops: LoopState[];
  adapter?: AdapterDescriptor;
  capabilities?: Record<string, AgentCapabilities>;
};
export type RunListItem = {
  runId: string;
  projectName: string;
  cwd: string;
  startedAt: string;
  adapter: AdapterDescriptor;
  agents: number;
  activeAgents: number;
  objective?: string;
};
export type DashboardState = {
  connected: boolean;
  snapshot: RunSnapshot;
  message?: string;
  runs: RunListItem[];
  selectedRunId?: string;
};
