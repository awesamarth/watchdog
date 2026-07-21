import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexJsonlObserver } from "./jsonl.js";
import type { WatchdogEvent } from "./normalizer.js";
import { RuntimeState } from "../runtime/state.js";

describe("CodexJsonlObserver", () => {
  it("reconstructs a near-live nested run without exposing controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "watchdog-jsonl-"));
    const day = join(root, "2026", "07", "15");
    await mkdir(day, { recursive: true });
    const cwd = "/project/watchdog";
    const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
    await writeFile(join(day, "a-root.jsonl"), [
      line("session_meta", { id: "root", session_id: "root", cwd }),
      line("event_msg", { type: "task_started", turn_id: "turn-1" }),
      line("turn_context", { model: "gpt-test", effort: "medium" }),
      line("event_msg", { type: "user_message", message: "Find and verify the race" }),
      line("response_item", { type: "custom_tool_call", name: "spawn_agent", call_id: "spawn-1", input: JSON.stringify({ task_name: "verify", message: "Prove the fix" }) }),
      line("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 123, input_tokens: 111, output_tokens: 12 } } }),
    ].join("\n") + "\n");
    await writeFile(join(day, "b-child.jsonl"), [
      line("session_meta", { id: "child", session_id: "root", cwd, parent_thread_id: "root", agent_path: "/root/verify", agent_nickname: "Gauss", source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_path: "/root/verify", agent_nickname: "Gauss", agent_role: "verifier" } } } }),
      line("event_msg", { type: "task_started", turn_id: "child-turn" }),
      line("event_msg", { type: "agent_message", message: "The regression test passes" }),
      line("event_msg", { type: "task_complete", turn_id: "child-turn" }),
    ].join("\n") + "\n");

    const state = new RuntimeState();
    const observer = new CodexJsonlObserver({ sessionsRoot: root, cwd });
    observer.on("event", (event: WatchdogEvent) => state.apply(event));
    await observer.scanOnce();

    const snapshot = state.snapshot();
    expect(snapshot.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "root", task: "Find and verify the race", totalTokens: 123, inputTokens: 111, outputTokens: 12, effective: { model: "gpt-test", effort: "medium" } }),
      expect.objectContaining({ threadId: "child", parentThreadId: "root", nickname: "Gauss", role: "verifier", latestMessage: "The regression test passes", messageCount: 1, messages: [expect.objectContaining({ text: "The regression test passes" })], requested: expect.objectContaining({ prompt: "Prove the fix" }) }),
    ]));
    expect(snapshot.loops).toEqual([]);
  });

  it("hydrates a resumed large session from a bounded tail and ignores inherited metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "watchdog-jsonl-tail-"));
    const day = join(root, "2026", "07", "20");
    await mkdir(day, { recursive: true });
    const cwd = "/project/watchdog";
    const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
    const path = join(day, "large-root.jsonl");
    await writeFile(path, [
      line("session_meta", { id: "root", session_id: "root", cwd }),
      ...Array.from({ length: 20 }, (_, index) => line("event_msg", { type: "agent_message", message: `stale-${index}-${"x".repeat(80)}` })),
      line("session_meta", { id: "inherited", session_id: "inherited", cwd: "/old/project" }),
      line("event_msg", { type: "task_started", turn_id: "current-turn" }),
      line("turn_context", { model: "gpt-current", effort: "high" }),
      line("event_msg", { type: "user_message", message: "Observe only the current turn" }),
      line("response_item", { type: "function_call", name: "exec_command", call_id: "call-1", arguments: JSON.stringify({ cmd: "rg -n TODO src" }) }),
      line("response_item", { type: "function_call_output", call_id: "call-1", output: "ok" }),
      line("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 456, input_tokens: 411, output_tokens: 45 } } }),
    ].join("\n") + "\n");

    const state = new RuntimeState();
    const observer = new CodexJsonlObserver({ sessionsRoot: root, cwd, bootstrapBytes: 1_024 });
    observer.on("event", (event: WatchdogEvent) => state.apply(event));
    await observer.scanOnce();

    expect(state.snapshot().agents).toEqual([
      expect.objectContaining({
        threadId: "root",
        status: "active",
        activeTurnId: "current-turn",
        task: "Observe only the current turn",
        effective: { model: "gpt-current", effort: "high" },
        latestActivity: { tool: "command · rg -n TODO src", status: "completed" },
        activities: [expect.objectContaining({ id: "call-1", tool: "command · rg -n TODO src", status: "completed" })],
        totalTokens: 456,
        inputTokens: 411,
        outputTokens: 45,
      }),
    ]);
  });
});
