import type { WatchdogEvent } from "./events.js";

type AdapterMode = "live" | "observed";
type AdapterTransport = "app-server" | "jsonl";

export type AdapterDescriptor = {
  harness: "codex" | "pi" | "claude" | string;
  transport: AdapterTransport | string;
  mode: AdapterMode;
  label: string;
};

export type Capability = { available: boolean; reason?: string };
export type AgentCapabilities = {
  observe: Capability;
  steer: Capability;
  followUp: Capability;
  interrupt: Capability;
  retry: Capability;
  modelOverride: Capability;
};

export type AdapterTarget = {
  threadId: string;
  parentThreadId?: string;
  nickname?: string;
  agentPath?: string;
  activeTurnId?: string;
};

export type RetryOptions = { message: string; model?: string; effort?: string };
export type AdapterEventListener = (event: WatchdogEvent) => void;

/**
 * Harness boundary for Watchdog. Adapters emit the same semantic event model
 * and advertise controls per agent; runtime, TUI, and dashboard stay unaware
 * of Codex/Pi/Claude protocol details.
 */
export interface HarnessAdapter {
  readonly descriptor: AdapterDescriptor;
  onEvent(listener: AdapterEventListener): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  capabilities(target: AdapterTarget): AgentCapabilities;
  steer(target: AdapterTarget, message: string): Promise<unknown>;
  followUp(target: AdapterTarget, message: string): Promise<unknown>;
  interrupt(target: AdapterTarget): Promise<unknown>;
  retry(target: AdapterTarget, options: RetryOptions): Promise<unknown>;
}

export function available(): Capability { return { available: true }; }
export function unavailable(reason: string): Capability { return { available: false, reason }; }
