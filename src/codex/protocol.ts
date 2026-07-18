import { EventEmitter } from "node:events";
import net from "node:net";
import WebSocket from "ws";

export type JsonObject = Record<string, unknown>;
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CodexAppServerClient extends EventEmitter {
  #socket?: WebSocket;
  #nextRequestId = 1;
  #pending = new Map<number, PendingRequest>();

  constructor(private readonly endpoint: string, private readonly requestTimeoutMs = 10_000) {
    super();
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = this.endpoint.startsWith("ws://") || this.endpoint.startsWith("wss://")
        ? new WebSocket(this.endpoint)
        : new WebSocket("ws://localhost/", { createConnection: () => net.createConnection({ path: this.endpoint }) });
      const rejectConnect = (error: Error) => reject(error);
      socket.once("error", rejectConnect);
      socket.once("open", () => {
        socket.off("error", rejectConnect);
        this.#socket = socket;
        resolve();
      });
      socket.on("message", (data) => this.#handle(data.toString()));
      socket.on("close", () => {
        if (this.#socket === socket) this.#socket = undefined;
        this.#rejectPending(new Error("Codex App Server connection closed before responding"));
        this.emit("close");
      });
      socket.on("error", (error) => this.emit("connectionError", error));
    });

    await this.request("initialize", {
      clientInfo: { name: "watchdog", title: "Watchdog", version: "0.0.1" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
  }

  request<T = unknown>(method: string, params: JsonObject): Promise<T> {
    const id = this.#nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error(`Codex App Server request '${method}' timed out after ${this.requestTimeoutMs}ms`));
      }, Math.max(1, this.requestTimeoutMs));
      timer.unref();
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.#send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: JsonObject): void {
    this.#send({ method, params });
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#rejectPending(new Error("Codex App Server connection closed"));
    socket?.close();
  }

  #send(message: JsonObject): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("Codex App Server is not connected");
    this.#socket.send(JSON.stringify(message));
  }

  #handle(raw: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(raw) as JsonObject;
    } catch {
      this.emit("protocolError", new Error(`Invalid JSON-RPC payload: ${raw.slice(0, 120)}`));
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") this.emit("notification", message.method, (message.params ?? {}) as JsonObject);
  }

  #rejectPending(error: Error): void {
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.#pending.clear();
  }
}
