import type { WatchdogEvent } from "../adapters/events.js";
import type { AgentCapabilities, AdapterEventListener, AdapterTarget, HarnessAdapter, RetryOptions } from "../adapters/types.js";
import { available, unavailable } from "../adapters/types.js";
import type { PiWorkerManager } from "./manager.js";

const ROOT_RETRY_REASON = "Pi's extension API does not expose a truthful retry primitive for the interactive root session.";

export type PiRootControls = {
  steer(message: string): void;
  followUp(message: string): void;
  interrupt(): void;
};

export class PiExtensionAdapter implements HarnessAdapter {
  readonly descriptor = { harness: "pi", transport: "extension-rpc", mode: "live", label: "Pi extension + RPC workers" } as const;
  #listeners = new Set<AdapterEventListener>();
  #stopped = false;

  constructor(
    readonly rootId: string,
    private readonly root: PiRootControls,
    readonly workers: PiWorkerManager,
  ) {}

  onEvent(listener: AdapterEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  ingest(event: WatchdogEvent): void {
    if (this.#stopped) return;
    for (const listener of this.#listeners) listener(event);
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.workers.close();
    this.#listeners.clear();
  }

  capabilities(target: AdapterTarget): AgentCapabilities {
    const active = Boolean(target.activeTurnId);
    if (target.threadId === this.rootId) return {
      observe: available(),
      steer: active ? available() : unavailable("The Pi root is idle; steering applies only during an active run."),
      followUp: available(),
      interrupt: active ? available() : unavailable("The Pi root has no active run to stop."),
      retry: unavailable(ROOT_RETRY_REASON),
      modelOverride: unavailable(ROOT_RETRY_REASON),
    };
    return {
      observe: available(),
      steer: active ? available() : unavailable("This Pi subagent is idle; use a follow-up or retry from Pi."),
      followUp: available(),
      interrupt: active ? available() : unavailable("This Pi subagent has no active work to stop."),
      retry: available(),
      modelOverride: available(),
    };
  }

  async steer(target: AdapterTarget, message: string): Promise<unknown> {
    if (target.threadId === this.rootId) {
      this.root.steer(message);
      return { steered: "Pi root" };
    }
    return await this.workers.steer(target.threadId, message);
  }

  async followUp(target: AdapterTarget, message: string): Promise<unknown> {
    if (target.threadId === this.rootId) {
      this.root.followUp(message);
      return { queued: "Pi root", mode: "follow-up" };
    }
    return this.workers.queueFollowUp(target.threadId, message);
  }

  async interrupt(target: AdapterTarget): Promise<unknown> {
    if (target.threadId === this.rootId) {
      this.root.interrupt();
      return { stopped: "Pi root", parentNotified: false };
    }
    return await this.workers.stop(target.threadId);
  }

  async retry(target: AdapterTarget, options: RetryOptions): Promise<unknown> {
    if (target.threadId === this.rootId) throw new Error(ROOT_RETRY_REASON);
    return this.workers.queueRetry(target.threadId, {
      message: options.message,
      model: options.model,
      thinking: normalizeThinking(options.effort),
    });
  }
}

function normalizeThinking(value: string | undefined): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!value) return undefined;
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) return value as ReturnType<typeof normalizeThinking>;
  throw new Error(`Unsupported Pi thinking level '${value}'.`);
}
