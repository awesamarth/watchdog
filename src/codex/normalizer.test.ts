import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CodexEventNormalizer, type WatchdogEvent } from "./normalizer.js";
import type { CodexAppServerClient, JsonObject } from "./protocol.js";

class FakeClient extends EventEmitter {
  request = vi.fn(async (_method: string, params: JsonObject): Promise<JsonObject> => {
    if (params.threadId === "child" && params.includeTurns === false) {
      return { thread: { id: "child", parentThreadId: "root", agentNickname: "Curie", agentRole: "investigator" } };
    }
    if (params.threadId === "root") {
      return { thread: { turns: [{ items: [{ type: "collabAgentToolCall", receiverThreadIds: ["child"], prompt: "Inspect control.ts", model: "luna", reasoningEffort: "low" }] }] } };
    }
    return {};
  });
}

describe("CodexEventNormalizer", () => {
  it("publishes cumulative input and output token usage", () => {
    const client = new FakeClient();
    const events: WatchdogEvent[] = [];
    const normalizer = new CodexEventNormalizer(client as unknown as CodexAppServerClient);
    normalizer.on("event", (event: WatchdogEvent) => events.push(event));

    client.emit("notification", "thread/tokenUsage/updated", {
      threadId: "root",
      tokenUsage: { total: { totalTokens: 120, inputTokens: 100, outputTokens: 20 } },
    });

    expect(events).toContainEqual({
      type: "tokens.updated",
      threadId: "root",
      totalTokens: 120,
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it("publishes native child tool activity", () => {
    const client = new FakeClient();
    const events: WatchdogEvent[] = [];
    const normalizer = new CodexEventNormalizer(client as unknown as CodexAppServerClient);
    normalizer.on("event", (event: WatchdogEvent) => events.push(event));

    client.emit("notification", "item/started", {
      threadId: "child",
      item: { id: "cmd-1", type: "commandExecution", command: "sleep 60", status: "inProgress" },
    });

    expect(events).toContainEqual(expect.objectContaining({ type: "agent.activity", threadId: "child", tool: "command · sleep 60", status: "inProgress" }));
  });

  it("maps canonical paths only when topology proves the item points to a child", () => {
    const client = new FakeClient();
    const events: WatchdogEvent[] = [];
    const normalizer = new CodexEventNormalizer(client as unknown as CodexAppServerClient);
    normalizer.on("event", (event: WatchdogEvent) => events.push(event));

    client.emit("notification", "thread/started", {
      thread: { id: "root" },
    });
    client.emit("notification", "thread/started", {
      thread: { id: "child", parentThreadId: "root", agentNickname: "Curie" },
    });
    client.emit("notification", "item/started", {
      threadId: "root",
      item: {
        id: "spawn-1",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "child",
        agentPath: "/root/runtime",
      },
    });

    expect(events).toContainEqual({
      type: "agent.spawned",
      parentThreadId: "root",
      agentThreadId: "child",
      agentPath: "/root/runtime",
      state: "started",
    });
    client.emit("notification", "item/started", {
      threadId: "child",
      item: {
        id: "back-reference-1",
        type: "subAgentActivity",
        kind: "interacted",
        agentThreadId: "root",
        agentPath: "/root",
      },
    });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "agent.spawned",
      parentThreadId: "child",
      agentThreadId: "root",
    }));
  });

  it("shows the command inside Codex's dynamic exec wrapper", () => {
    const client = new FakeClient();
    const events: WatchdogEvent[] = [];
    const normalizer = new CodexEventNormalizer(client as unknown as CodexAppServerClient);
    normalizer.on("event", (event: WatchdogEvent) => events.push(event));

    client.emit("notification", "item/started", {
      threadId: "child",
      item: {
        id: "exec-1",
        type: "dynamicToolCall",
        tool: "exec",
        status: "inProgress",
        arguments: 'const r = await tools.exec_command({"cmd":"rg -n \\"assignment|spawn_agent\\" src/codex"}); text(r.output);',
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.activity",
      threadId: "child",
      itemId: "exec-1",
      tool: 'command · rg -n "assignment|spawn_agent" src/codex',
      status: "inProgress",
    }));
  });

  it("publishes streaming message deltas and the complete final message", () => {
    const client = new FakeClient();
    const events: WatchdogEvent[] = [];
    const normalizer = new CodexEventNormalizer(client as unknown as CodexAppServerClient);
    normalizer.on("event", (event: WatchdogEvent) => events.push(event));
    const longMessage = "x".repeat(2_000);

    client.emit("notification", "item/agentMessage/delta", { threadId: "child", turnId: "turn", itemId: "message-1", delta: "Working…" });
    client.emit("notification", "item/completed", { threadId: "child", item: { id: "message-1", type: "agentMessage", text: longMessage } });

    expect(events).toContainEqual(expect.objectContaining({ type: "agent.message.delta", threadId: "child", itemId: "message-1", delta: "Working…" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.message", threadId: "child", itemId: "message-1", message: longMessage }));
  });

  it("hydrates a child's assignment from its parent turn", async () => {
    const client = new FakeClient();
    const events: WatchdogEvent[] = [];
    const normalizer = new CodexEventNormalizer(client as unknown as CodexAppServerClient);
    normalizer.on("event", (event: WatchdogEvent) => events.push(event));

    client.emit("notification", "thread/status/changed", { threadId: "child", status: { type: "idle" } });
    await vi.waitFor(() => {
      expect(events).toContainEqual(expect.objectContaining({
        type: "agent.requestedConfig",
        parentThreadId: "root",
        agentThreadId: "child",
        prompt: "Inspect control.ts",
      }));
    });
  });
});
