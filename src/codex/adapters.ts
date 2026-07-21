import type { AgentCapabilities, AdapterEventListener, AdapterTarget, HarnessAdapter, RetryOptions } from "../adapters/types.js";
import { available, unavailable } from "../adapters/types.js";
import { RuntimeState } from "../runtime/state.js";
import { CodexJsonlObserver, type CodexJsonlObserverOptions } from "./jsonl.js";
import { CodexEventNormalizer } from "./normalizer.js";
import type { CodexAppServerClient } from "./protocol.js";

const CHILD_STEER_REASON = "Codex does not allow direct steering input for native subagents. Stop is supported; steering must currently go through the parent agent.";
const FOLLOW_UP_REASON = "Codex App Server does not expose a distinct follow-up queue through Watchdog. Use root steering while active or retry/start a root turn.";
const CHILD_RETRY_REASON = "Codex does not allow direct new-turn input for native subagents. Retry is available only for top-level Watchdog-owned threads right now.";
const OBSERVED_REASON = "This is an external Codex session observed from JSONL. Agent steering and stopping are unavailable; relaunch with `watchdog codex` for live controls.";

export class CodexAppServerAdapter implements HarnessAdapter {
  readonly descriptor = { harness: "codex", transport: "app-server", mode: "live", label: "Codex App Server" } as const;
  #listeners = new Set<AdapterEventListener>();

  constructor(private readonly client: CodexAppServerClient, private readonly state: RuntimeState) {
    const normalizer = new CodexEventNormalizer(client);
    normalizer.on("event", (event) => {
      for (const listener of this.#listeners) listener(event);
    });
  }

  onEvent(listener: AdapterEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> { this.#listeners.clear(); }

  capabilities(target: AdapterTarget): AgentCapabilities {
    const active = Boolean(target.activeTurnId);
    if (target.parentThreadId) return {
      observe: available(),
      steer: unavailable(CHILD_STEER_REASON),
      followUp: unavailable(FOLLOW_UP_REASON),
      interrupt: active ? available() : unavailable("This subagent has no active turn to interrupt."),
      retry: unavailable(CHILD_RETRY_REASON),
      modelOverride: unavailable("A native Codex subagent cannot be restarted directly with a model override."),
    };
    return {
      observe: available(),
      steer: active ? available() : unavailable("This root agent has no active turn to steer."),
      followUp: unavailable(FOLLOW_UP_REASON),
      interrupt: active ? available() : unavailable("This root agent has no active turn to interrupt."),
      retry: available(),
      modelOverride: available(),
    };
  }

  async steer(target: AdapterTarget, message: string): Promise<unknown> {
    if (target.parentThreadId) throw new Error(CHILD_STEER_REASON);
    return await steerActiveRoot(this.client, this.state, target.threadId, message);
  }
  async followUp(): Promise<unknown> { throw new Error(FOLLOW_UP_REASON); }

  async interrupt(target: AdapterTarget): Promise<unknown> {
    if (!target.activeTurnId) throw new Error(`${agentLabel(target)} has no active turn to interrupt`);
    await this.client.request("turn/interrupt", { threadId: target.threadId, turnId: target.activeTurnId });
    if (!target.parentThreadId) return { stopped: agentLabel(target), parentNotified: false };

    const root = this.state.rootFor(target.threadId);
    const directParent = this.state.resolve(target.parentThreadId);
    const directParentIsRoot = directParent.threadId === root.threadId;
    const activeRoot = await this.state.waitForActiveTurn(root.threadId, 3_000);
    const notification = {
      directParent: agentLabel(directParent),
      notificationTarget: agentLabel(root),
    };
    if (!activeRoot?.activeTurnId) {
      return { stopped: agentLabel(target), parentNotified: false, rootNotified: false, ...notification };
    }
    try {
      const nestedContext = directParentIsRoot
        ? ""
        : ` Its immediate parent is native subagent ${agentReference(directParent)}, which Watchdog cannot steer directly; account for the possibility that it is still waiting.`;
      await steerActiveRoot(this.client, this.state, activeRoot.threadId, `Watchdog operator intervention: subagent ${agentReference(target)} was stopped.${nestedContext} Do not continue waiting for it. Re-plan from the evidence you have: continue yourself, delegate a replacement if warranted, or report the limitation.`);
      return {
        stopped: agentLabel(target),
        parentNotified: directParentIsRoot,
        rootNotified: true,
        ...notification,
      };
    } catch {
      return { stopped: agentLabel(target), parentNotified: false, rootNotified: false, ...notification };
    }
  }

  async retry(target: AdapterTarget, options: RetryOptions): Promise<unknown> {
    if (target.parentThreadId) throw new Error(CHILD_RETRY_REASON);
    if (target.activeTurnId) {
      await this.client.request("turn/interrupt", { threadId: target.threadId, turnId: target.activeTurnId });
      await this.state.waitForIdle(target.threadId);
    }
    return await this.client.request("turn/start", {
      threadId: target.threadId,
      input: [{ type: "text", text: options.message }],
      model: options.model ?? null,
      effort: options.effort ?? null,
    });
  }
}

export class CodexJsonlAdapter implements HarnessAdapter {
  readonly descriptor = { harness: "codex", transport: "jsonl", mode: "observed", label: "Codex session JSONL" } as const;
  #listeners = new Set<AdapterEventListener>();
  #observer: CodexJsonlObserver;

  constructor(options: CodexJsonlObserverOptions) {
    this.#observer = new CodexJsonlObserver(options);
    this.#observer.on("event", (event) => {
      for (const listener of this.#listeners) listener(event);
    });
    this.#observer.on("warning", (error) => console.error(`[watchdog:observe] ${error instanceof Error ? error.message : String(error)}`));
  }

  onEvent(listener: AdapterEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> { await this.#observer.start(); }
  async stop(): Promise<void> { this.#observer.stop(); this.#listeners.clear(); }
  capabilities(): AgentCapabilities {
    return {
      observe: available(),
      steer: unavailable(OBSERVED_REASON),
      followUp: unavailable(OBSERVED_REASON),
      interrupt: unavailable(OBSERVED_REASON),
      retry: unavailable(OBSERVED_REASON),
      modelOverride: unavailable(OBSERVED_REASON),
    };
  }
  async steer(): Promise<unknown> { throw new Error(OBSERVED_REASON); }
  async followUp(): Promise<unknown> { throw new Error(OBSERVED_REASON); }
  async interrupt(): Promise<unknown> { throw new Error(OBSERVED_REASON); }
  async retry(): Promise<unknown> { throw new Error(OBSERVED_REASON); }
}

async function steerActiveRoot(client: CodexAppServerClient, state: RuntimeState, threadId: string, message: string): Promise<unknown> {
  let active = state.resolve(threadId);
  if (!active.activeTurnId) active = await state.waitForActiveTurn(threadId, 1_500) ?? active;
  if (!active.activeTurnId) throw new Error(`${agentLabel(active)} has no active turn to steer`);
  const firstTurnId = active.activeTurnId;
  try {
    return await client.request("turn/steer", { threadId, expectedTurnId: firstTurnId, input: [{ type: "text", text: message }] });
  } catch (error) {
    const refreshed = await state.waitForActiveTurn(threadId, 750);
    if (!refreshed?.activeTurnId || refreshed.activeTurnId === firstTurnId) throw error;
    return await client.request("turn/steer", { threadId, expectedTurnId: refreshed.activeTurnId, input: [{ type: "text", text: message }] });
  }
}

function agentLabel(agent: { nickname?: string; agentPath?: string; threadId: string }): string {
  return agent.nickname ?? agent.agentPath ?? agent.threadId.slice(0, 8);
}

function agentReference(agent: { nickname?: string; agentPath?: string; threadId: string }): string {
  const identities = [agent.agentPath, agent.nickname].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  return `${identities.join(" / ") || "unnamed subagent"} (thread ${agent.threadId})`;
}
