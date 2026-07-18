import { EventEmitter } from "node:events";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WatchdogEvent } from "./normalizer.js";

type JsonObject = Record<string, unknown>;
type TailState = { offset: number; remainder: string; accepted?: boolean; threadId?: string; activeTurnId?: string; calls: Map<string, string> };
type PendingSpawn = { parentThreadId: string; taskName?: string; prompt?: string };
export type CodexJsonlObserverOptions = { sessionsRoot: string; cwd: string; intervalMs?: number; sessionId?: string };

export class CodexJsonlObserver extends EventEmitter {
  #files = new Map<string, TailState>();
  #pendingSpawns: PendingSpawn[] = [];
  #timer?: NodeJS.Timeout;
  #sessionId?: string;

  constructor(private readonly options: CodexJsonlObserverOptions) {
    super();
    this.#sessionId = options.sessionId;
  }

  async start(): Promise<void> {
    await this.scanOnce();
    this.#timer = setInterval(() => void this.scanOnce().catch((error) => this.emit("warning", error)), this.options.intervalMs ?? 500);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async scanOnce(): Promise<void> {
    const files = await jsonlFiles(this.options.sessionsRoot);
    this.#sessionId ??= await latestRootSession(files, this.options.cwd);
    for (const path of files) await this.#pump(path);
  }

  async #pump(path: string): Promise<void> {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) return;
    const tail = this.#files.get(path) ?? { offset: 0, remainder: "", calls: new Map<string, string>() };
    this.#files.set(path, tail);
    if (info.size < tail.offset) { tail.offset = 0; tail.remainder = ""; tail.accepted = undefined; }
    if (info.size === tail.offset) return;

    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Number(info.size - tail.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, tail.offset);
      tail.offset += bytesRead;
      const lines = `${tail.remainder}${buffer.subarray(0, bytesRead).toString("utf8")}`.split("\n");
      tail.remainder = lines.pop() ?? "";
      for (const line of lines) this.#consume(line, tail);
    } finally {
      await handle.close();
    }
  }

  #consume(line: string, tail: TailState): void {
    let record: JsonObject;
    try { record = JSON.parse(line) as JsonObject; } catch { return; }
    const payload = object(record.payload);
    if (text(record.type) === "session_meta") {
      const sessionId = text(payload.session_id) ?? text(payload.id);
      tail.accepted = text(payload.cwd) === this.options.cwd && (!this.#sessionId || sessionId === this.#sessionId);
      if (!tail.accepted) return;
      const threadId = text(payload.id) ?? text(payload.session_id);
      if (!threadId) return;
      tail.threadId = threadId;
      const spawn = object(object(payload.source).subagent).thread_spawn;
      const spawnInfo = object(spawn);
      const parentThreadId = text(payload.parent_thread_id) ?? text(spawnInfo.parent_thread_id);
      const nickname = text(payload.agent_nickname) ?? text(spawnInfo.agent_nickname);
      const role = text(spawnInfo.agent_role);
      const agentPath = text(payload.agent_path) ?? text(spawnInfo.agent_path);
      this.#emit({ type: "thread.started", threadId, parentThreadId, nickname, role });
      if (parentThreadId) {
        this.#emit({ type: "agent.spawned", parentThreadId, agentThreadId: threadId, agentPath, state: "observed" });
        const taskName = agentPath?.split("/").filter(Boolean).at(-1);
        const pending = [...this.#pendingSpawns].reverse().find((item) => item.parentThreadId === parentThreadId && (!item.taskName || item.taskName === taskName));
        if (pending) this.#emit({ type: "agent.requestedConfig", parentThreadId, agentThreadId: threadId, prompt: pending.prompt });
      }
      return;
    }
    if (!tail.accepted || !tail.threadId) return;
    const threadId = tail.threadId;
    const recordType = text(record.type);
    const payloadType = text(payload.type);

    if (recordType === "turn_context") {
      this.#emit({ type: "agent.effectiveConfig", threadId, model: text(payload.model), reasoningEffort: text(payload.effort) });
      return;
    }
    if (recordType === "event_msg") {
      if (payloadType === "task_started") {
        const turnId = text(payload.turn_id);
        if (turnId) { tail.activeTurnId = turnId; this.#emit({ type: "turn.started", threadId, turnId }); }
        this.#emit({ type: "thread.status", threadId, status: "active" });
      } else if (payloadType === "task_complete" || payloadType === "turn_aborted") {
        const turnId = text(payload.turn_id) ?? tail.activeTurnId;
        if (turnId) this.#emit({ type: "turn.completed", threadId, turnId });
        tail.activeTurnId = undefined;
        this.#emit({ type: "thread.status", threadId, status: payloadType === "turn_aborted" ? "interrupted" : "idle" });
      } else if (payloadType === "user_message" && tail.activeTurnId) {
        const input = text(payload.message)?.trim();
        if (input) this.#emit({ type: "turn.input", threadId, turnId: tail.activeTurnId, input: input.slice(0, 2_000) });
      } else if (payloadType === "agent_message") {
        const message = text(payload.message)?.trim();
        if (message) this.#emit({ type: "agent.message", threadId, message, at: text(record.timestamp) });
      } else if (payloadType === "token_count") {
        const usage = object(object(payload.info).total_token_usage);
        this.#emit({ type: "tokens.updated", threadId, totalTokens: numeric(usage.total_tokens), outputTokens: numeric(usage.output_tokens) });
      }
      return;
    }
    if (recordType !== "response_item") return;
    if (payloadType === "custom_tool_call") {
      const name = text(payload.name) ?? "tool";
      const callId = text(payload.call_id);
      if (callId) tail.calls.set(callId, name);
      this.#emit({ type: "agent.activity", threadId, tool: name, status: "inProgress" });
      if (name === "spawn_agent") {
        const input = parseJson(text(payload.input));
        this.#pendingSpawns.push({ parentThreadId: threadId, taskName: text(input.task_name), prompt: text(input.message) });
      }
    } else if (payloadType === "custom_tool_call_output") {
      const name = tail.calls.get(text(payload.call_id) ?? "") ?? "tool";
      this.#emit({ type: "agent.activity", threadId, tool: name, status: "completed" });
    }
  }

  #emit(event: WatchdogEvent): void { this.emit("event", event); }
}

async function jsonlFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(path);
    }));
  };
  await visit(root);
  return output.sort();
}

async function latestRootSession(paths: string[], cwd: string): Promise<string | undefined> {
  let selected: { id: string; modifiedAt: number } | undefined;
  for (const path of paths) {
    const handle = await open(path, "r").catch(() => undefined);
    if (!handle) continue;
    try {
      const buffer = Buffer.alloc(32_768);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
      if (!firstLine) continue;
      const record = JSON.parse(firstLine) as JsonObject;
      const payload = object(record.payload);
      if (text(record.type) !== "session_meta" || text(payload.cwd) !== cwd || text(payload.parent_thread_id)) continue;
      const id = text(payload.session_id) ?? text(payload.id);
      if (!id) continue;
      const modifiedAt = (await stat(path)).mtimeMs;
      if (!selected || modifiedAt > selected.modifiedAt) selected = { id, modifiedAt };
    } catch {
      // A partially-written or unrelated file is simply not a candidate.
    } finally {
      await handle.close();
    }
  }
  return selected?.id;
}

function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function numeric(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
function parseJson(value?: string): JsonObject { try { return value ? object(JSON.parse(value)) : {}; } catch { return {}; } }
