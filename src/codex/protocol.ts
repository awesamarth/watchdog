import { EventEmitter } from "node:events";
import net from "node:net";
import WebSocket from "ws";

export type JsonObject = Record<string, unknown>;

export class CodexAppServerClient extends EventEmitter {
  #socket?: WebSocket;
  #nextRequestId = 1;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();

  constructor(private readonly endpoint: string) {
    super();
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = this.endpoint.startsWith("ws://") || this.endpoint.startsWith("wss://")
        ? new WebSocket(this.endpoint)
        : new WebSocket("ws://localhost/", { createConnection: () => net.createConnection({ path: this.endpoint }) });
      socket.once("open", () => {
        this.#socket = socket;
        resolve();
      });
      socket.once("error", reject);
      socket.on("message", (data) => this.#handle(data.toString()));
      socket.on("close", () => this.emit("close"));
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
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#send({ method, id, params });
    });
  }

  notify(method: string, params: JsonObject): void {
    this.#send({ method, params });
  }

  close(): void {
    this.#socket?.close();
    for (const request of this.#pending.values()) request.reject(new Error("Codex App Server connection closed"));
    this.#pending.clear();
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
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") this.emit("notification", message.method, (message.params ?? {}) as JsonObject);
  }
}
