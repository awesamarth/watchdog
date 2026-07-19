import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PiRpcClient } from "./rpc.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));

describe("PiRpcClient", () => {
  it("speaks Pi's JSONL RPC protocol and streams lifecycle events", async () => {
    const client = new PiRpcClient({
      cwd: process.cwd(),
      piBin: process.execPath,
      piArgsPrefix: [fixture],
    });
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));

    const initial = await client.start();
    expect(initial).toMatchObject({ sessionId: "fake-session", thinkingLevel: "medium", isStreaming: false });

    await client.prompt("inspect the repository");
    await client.waitForSettled();
    expect(events).toEqual(expect.arrayContaining(["agent_start", "message_update", "message_end", "agent_settled"]));

    expect(await client.setModel("test/other-model")).toEqual({ provider: "test", id: "other-model" });
    await client.setThinkingLevel("high");
    expect(await client.getState()).toMatchObject({
      model: { provider: "test", id: "other-model" },
      thinkingLevel: "high",
    });

    await client.stop();
  });

  it("aborts an active worker cleanly", async () => {
    const client = new PiRpcClient({
      cwd: process.cwd(),
      piBin: process.execPath,
      piArgsPrefix: [fixture],
    });
    await client.start();
    await client.prompt("SLOW");
    await client.abort();
    await client.waitForSettled();
    expect((await client.getState()).isStreaming).toBe(false);
    await client.stop();
  });
});
