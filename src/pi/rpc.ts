import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PiRpcState = {
  model?: { id?: string; provider?: string; name?: string };
  thinkingLevel: PiThinkingLevel;
  isStreaming: boolean;
  sessionId: string;
  messageCount: number;
  pendingMessageCount: number;
};

export type PiRpcEvent = Record<string, unknown> & { type: string };

export type PiRpcClientOptions = {
  cwd: string;
  model?: string;
  thinking?: PiThinkingLevel;
  tools?: string[];
  extensionPath?: string;
  env?: NodeJS.ProcessEnv;
  piBin?: string;
  piArgsPrefix?: string[];
  requestTimeoutMs?: number;
};

type PendingRequest = {
  command: string;
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class PiRpcClient {
  #process?: ChildProcessWithoutNullStreams;
  #lines?: Interface;
  #listeners = new Set<(event: PiRpcEvent) => void>();
  #pending = new Map<string, PendingRequest>();
  #nextId = 0;
  #stderr = "";
  #exitError?: Error;

  constructor(private readonly options: PiRpcClientOptions) {}

  get pid(): number | undefined { return this.#process?.pid; }
  get stderr(): string { return this.#stderr; }
  get running(): boolean { return Boolean(this.#process && this.#process.exitCode === null && !this.#process.killed); }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<PiRpcState> {
    if (this.#process) throw new Error("Pi RPC worker is already started.");
    const args = [
      "--mode", "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
    ];
    if (this.options.extensionPath) args.push("--extension", this.options.extensionPath);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.thinking) args.push("--thinking", this.options.thinking);
    if (this.options.tools?.length) args.push("--tools", [...new Set(this.options.tools)].join(","));

    const child = spawn(this.options.piBin ?? process.env.WATCHDOG_PI_BIN ?? "pi", [...(this.options.piArgsPrefix ?? []), ...args], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.#process = child;
    child.stderr.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-32_768);
    });
    child.once("error", (error) => this.#fail(new Error(`Could not start Pi RPC worker: ${error.message}`)));
    child.once("exit", (code, signal) => {
      const detail = this.#stderr.trim().split("\n").at(-1);
      this.#fail(new Error(`Pi RPC worker exited (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`));
    });
    this.#lines = createInterface({ input: child.stdout });
    this.#lines.on("line", (line) => this.#handleLine(line));

    return await this.getState();
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (!child) return;
    this.#lines?.close();
    this.#lines = undefined;
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    this.#process = undefined;
    this.#rejectPending(new Error("Pi RPC worker stopped."));
    this.#listeners.clear();
  }

  async prompt(message: string): Promise<void> { await this.#request("prompt", { message }); }
  async steer(message: string): Promise<void> { await this.#request("steer", { message }); }
  async followUp(message: string): Promise<void> { await this.#request("follow_up", { message }); }
  async abort(): Promise<void> { await this.#request("abort"); }
  async newSession(): Promise<void> { await this.#request("new_session"); }
  async setThinkingLevel(level: PiThinkingLevel): Promise<void> { await this.#request("set_thinking_level", { level }); }
  async getState(): Promise<PiRpcState> { return await this.#request("get_state") as PiRpcState; }
  async getMessages(): Promise<unknown[]> {
    const data = await this.#request("get_messages") as { messages?: unknown[] };
    return data.messages ?? [];
  }
  async getSessionStats(): Promise<Record<string, unknown>> {
    return await this.#request("get_session_stats") as Record<string, unknown>;
  }

  async setModel(model: string): Promise<{ provider: string; id: string }> {
    const available = await this.#request("get_available_models") as { models?: Array<{ provider?: string; id?: string }> };
    const candidates = (available.models ?? []).filter((candidate) => candidate.provider && candidate.id);
    const exactReference = candidates.find((candidate) => `${candidate.provider}/${candidate.id}` === model);
    const idMatches = candidates.filter((candidate) => candidate.id === model);
    if (!exactReference && idMatches.length > 1) {
      throw new Error(`Pi model '${model}' is ambiguous; use provider/model.`);
    }
    const exact = exactReference ?? idMatches[0];
    if (!exact?.provider || !exact.id) throw new Error(`Pi model '${model}' is not available to this worker.`);
    await this.#request("set_model", { provider: exact.provider, modelId: exact.id });
    return { provider: exact.provider, id: exact.id };
  }

  async waitForSettled(timeoutMs = 10 * 60_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        error ? reject(error) : resolve();
      };
      const unsubscribe = this.onEvent((event) => {
        if (event.type === "agent_settled") finish();
      });
      const timer = setTimeout(() => finish(new Error(`Pi worker did not settle within ${timeoutMs}ms.`)), timeoutMs);
      timer.unref();
      void this.getState().then(
        (current) => {
          if (!current.isStreaming && current.pendingMessageCount === 0) finish();
        },
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  async #request(command: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.#process?.stdin.writable) throw this.#exitError ?? new Error("Pi RPC worker is not running.");
    const id = `watchdog-${++this.#nextId}`;
    const timeoutMs = Math.max(1, this.options.requestTimeoutMs ?? 12_000);
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC '${command}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { command, timer, resolve, reject });
    });
    this.#process.stdin.write(`${JSON.stringify({ id, type: command, ...fields })}\n`);
    return await result;
  }

  #handleLine(line: string): void {
    let message: PiRpcEvent;
    try {
      message = JSON.parse(line) as PiRpcEvent;
    } catch {
      return;
    }
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.success === true) pending.resolve(message.data);
      else pending.reject(new Error(typeof message.error === "string" ? message.error : `Pi RPC '${pending.command}' failed.`));
      return;
    }
    for (const listener of this.#listeners) listener(message);
  }

  #fail(error: Error): void {
    if (this.#exitError) return;
    this.#exitError = error;
    this.#rejectPending(error);
    for (const listener of this.#listeners) listener({ type: "process_exit", error: error.message });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
