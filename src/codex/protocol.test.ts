import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexAppServerClient, type JsonObject } from "./protocol.js";

describe("Codex App Server request lifecycle", () => {
  it("times out a request that receives no response", async () => {
    const server = await protocolServer(() => undefined);
    const client = new CodexAppServerClient(server.endpoint, 40);
    try {
      await client.connect();
      await expect(client.request("test/hang", {})).rejects.toThrow("request 'test/hang' timed out");
    } finally {
      client.close();
      await server.close();
    }
  });

  it("rejects pending requests when the connection closes unexpectedly", async () => {
    const server = await protocolServer((socket, message) => {
      if (message.method === "test/disconnect") socket.terminate();
    });
    const client = new CodexAppServerClient(server.endpoint, 2_000);
    try {
      await client.connect();
      await expect(client.request("test/disconnect", {})).rejects.toThrow("connection closed before responding");
    } finally {
      client.close();
      await server.close();
    }
  });
});

async function protocolServer(onRequest: (socket: WebSocket, message: JsonObject) => void): Promise<{
  endpoint: string;
  close(): Promise<void>;
}> {
  const server = new WebSocketServer({ port: 0 });
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as JsonObject;
    if (message.method === "initialize" && typeof message.id === "number") {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
      return;
    }
    onRequest(socket, message);
  }));
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `ws://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
