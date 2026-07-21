import { EventEmitter } from "node:events";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { WatchdogEvent } from "../adapters/events.js";
import { codexToolLabel } from "./activity.js";

type JsonObject = Record<string, unknown>;
type TailState = {
  offset: number;
  remainder: string;
  accepted?: boolean;
  metadataSeen: boolean;
  bootstrapped: boolean;
  decoder: StringDecoder;
  threadId?: string;
  activeTurnId?: string;
  calls: Map<string, string>;
};
type PendingSpawn = { parentThreadId: string; taskName?: string; prompt?: string };
export type CodexJsonlObserverOptions = {
  sessionsRoot: string;
  cwd: string;
  intervalMs?: number;
  sessionId?: string;
  bootstrapBytes?: number;
};

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
    let tail = this.#files.get(path);
    if (!tail) {
      const header = await readSessionHeader(path);
      if (!header) return;
      tail = {
        offset: header.nextOffset,
        remainder: "",
        metadataSeen: false,
        bootstrapped: false,
        decoder: new StringDecoder("utf8"),
        calls: new Map<string, string>(),
      };
      this.#files.set(path, tail);
      this.#consume(header.line, tail);
    }
    if (info.size < tail.offset) {
      this.#files.delete(path);
      await this.#pump(path);
      return;
    }
    if (!tail.accepted) {
      tail.offset = info.size;
      return;
    }
    if (!tail.bootstrapped) {
      tail.bootstrapped = true;
      const bootstrapBytes = this.options.bootstrapBytes ?? DEFAULT_BOOTSTRAP_BYTES;
      if (info.size - tail.offset > bootstrapBytes) {
        tail.offset = Math.max(tail.offset, info.size - bootstrapBytes);
        tail.remainder = "";
        tail.decoder = new StringDecoder("utf8");
        await this.#read(path, info.size, tail, true);
        return;
      }
    }
    if (info.size === tail.offset) return;
    await this.#read(path, info.size, tail, false);
  }

  async #read(path: string, endOffset: number, tail: TailState, discardFirstPartialLine: boolean): Promise<void> {
    const handle = await open(path, "r");
    try {
      let discarding = discardFirstPartialLine;
      while (tail.offset < endOffset) {
        const length = Math.min(READ_CHUNK_BYTES, endOffset - tail.offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, tail.offset);
        if (!bytesRead) break;
        tail.offset += bytesRead;
        let content = tail.decoder.write(buffer.subarray(0, bytesRead));
        if (discarding) {
          const newline = content.indexOf("\n");
          if (newline < 0) continue;
          content = content.slice(newline + 1);
          discarding = false;
        }
        const lines = `${tail.remainder}${content}`.split("\n");
        tail.remainder = lines.pop() ?? "";
        for (const line of lines) this.#consume(line, tail);
      }
    } finally {
      await handle.close();
    }
  }

  #consume(line: string, tail: TailState): void {
    let record: JsonObject;
    try { record = JSON.parse(line) as JsonObject; } catch { return; }
    const payload = object(record.payload);
    if (text(record.type) === "session_meta") {
      if (tail.metadataSeen) return;
      tail.metadataSeen = true;
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
      this.#emit({ type: "thread.started", threadId, parentThreadId, nickname, role, kind: parentThreadId ? "native-child" : "root" });
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
        this.#emit({
          type: "tokens.updated",
          threadId,
          totalTokens: numeric(usage.total_tokens),
          inputTokens: numeric(usage.input_tokens),
          outputTokens: numeric(usage.output_tokens),
        });
      }
      return;
    }
    if (recordType !== "response_item") return;
    if (payloadType === "custom_tool_call" || payloadType === "function_call") {
      const name = text(payload.name) ?? "tool";
      const callId = text(payload.call_id) ?? text(payload.id);
      const rawInput = text(payload.input) ?? text(payload.arguments);
      const label = codexToolLabel(name, parseJsonValue(rawInput));
      if (callId) tail.calls.set(callId, label);
      this.#emit({ type: "agent.activity", threadId, itemId: callId, tool: label, status: "inProgress", at: text(record.timestamp) });
      if (name === "spawn_agent") {
        const input = parseJson(rawInput);
        this.#pendingSpawns.push({ parentThreadId: threadId, taskName: text(input.task_name), prompt: text(input.message) });
      }
    } else if (payloadType === "custom_tool_call_output" || payloadType === "function_call_output") {
      const callId = text(payload.call_id);
      const name = tail.calls.get(callId ?? "") ?? "tool";
      this.#emit({ type: "agent.activity", threadId, itemId: callId, tool: name, status: "completed", at: text(record.timestamp) });
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
    try {
      const header = await readSessionHeader(path);
      if (!header) continue;
      const record = JSON.parse(header.line) as JsonObject;
      const payload = object(record.payload);
      if (text(record.type) !== "session_meta" || text(payload.cwd) !== cwd || text(payload.parent_thread_id)) continue;
      const id = text(payload.session_id) ?? text(payload.id);
      if (!id) continue;
      const modifiedAt = (await stat(path)).mtimeMs;
      if (!selected || modifiedAt > selected.modifiedAt) selected = { id, modifiedAt };
    } catch {
      // A partially-written or unrelated file is simply not a candidate.
    }
  }
  return selected?.id;
}

async function readSessionHeader(path: string): Promise<{ line: string; nextOffset: number } | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < MAX_SESSION_META_BYTES) {
      const length = Math.min(SESSION_META_CHUNK_BYTES, MAX_SESSION_META_BYTES - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (!bytesRead) return undefined;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return { line: Buffer.concat(chunks).toString("utf8"), nextOffset: offset + newline + 1 };
      }
      chunks.push(chunk);
      offset += bytesRead;
    }
    throw new Error(`Codex session metadata exceeds ${MAX_SESSION_META_BYTES} bytes in ${path}`);
  } finally {
    await handle.close();
  }
}

function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function numeric(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
function parseJson(value?: string): JsonObject { try { return value ? object(JSON.parse(value)) : {}; } catch { return {}; } }
function parseJsonValue(value?: string): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

const DEFAULT_BOOTSTRAP_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const SESSION_META_CHUNK_BYTES = 64 * 1024;
const MAX_SESSION_META_BYTES = 4 * 1024 * 1024;
