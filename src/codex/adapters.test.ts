import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RuntimeState } from "../runtime/state.js";
import { CodexAppServerAdapter } from "./adapters.js";
import type { CodexAppServerClient, JsonObject } from "./protocol.js";

class FakeClient extends EventEmitter {
  request = vi.fn(async (_method: string, _params: JsonObject) => ({}));
}

describe("Codex interrupt notification routing", () => {
  it("reports the direct root parent as notified for a first-level child", async () => {
    const { adapter, client, state } = fixture();
    state.apply({ type: "thread.started", threadId: "child", parentThreadId: "root", nickname: "Curie" });
    state.apply({ type: "turn.started", threadId: "child", turnId: "child-turn" });

    await expect(adapter.interrupt(state.resolve("child"))).resolves.toMatchObject({
      stopped: "Curie",
      parentNotified: true,
      rootNotified: true,
      directParent: "Root",
      notificationTarget: "Root",
    });
    expect(client.request).toHaveBeenCalledWith("turn/steer", expect.objectContaining({
      threadId: "root",
      input: [expect.objectContaining({ text: expect.stringContaining("Curie (thread child)") })],
    }));
  });

  it("does not claim that an unsteerable nested parent was notified", async () => {
    const { adapter, client, state } = fixture();
    state.apply({ type: "thread.started", threadId: "child", parentThreadId: "root", nickname: "Curie" });
    state.apply({ type: "thread.started", threadId: "grandchild", parentThreadId: "child", nickname: "Gauss" });
    state.apply({ type: "turn.started", threadId: "grandchild", turnId: "grandchild-turn" });

    await expect(adapter.interrupt(state.resolve("grandchild"))).resolves.toMatchObject({
      stopped: "Gauss",
      parentNotified: false,
      rootNotified: true,
      directParent: "Curie",
      notificationTarget: "Root",
    });
    expect(client.request).toHaveBeenCalledWith("turn/steer", expect.objectContaining({
      threadId: "root",
      input: [expect.objectContaining({ text: expect.stringContaining("cannot steer directly") })],
    }));
  });
});

function fixture(): { adapter: CodexAppServerAdapter; client: FakeClient; state: RuntimeState } {
  const state = new RuntimeState();
  state.apply({ type: "thread.started", threadId: "root", nickname: "Root" });
  state.apply({ type: "turn.started", threadId: "root", turnId: "root-turn" });
  const client = new FakeClient();
  const adapter = new CodexAppServerAdapter(client as unknown as CodexAppServerClient, state);
  return { adapter, client, state };
}
