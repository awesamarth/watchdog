import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunTrace } from "./replay.js";

describe("Watchdog trace replay", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("reconstructs completed execution lifecycle and infers Pi traces without making a new runtime model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "watchdog-replay-"));
    directories.push(directory);
    const path = join(directory, "run.jsonl");
    const events = [
      { type: "thread.started", threadId: "pi-root-session", kind: "root" },
      { type: "execution.node.started", executionId: "audit", nodeId: "verify", activationId: "verify-1", threadId: "pi-root-session", iteration: 1 },
      {
        type: "execution.declared",
        graph: {
          id: "audit",
          ownerThreadId: "pi-root-session",
          source: { kind: "watchdog", label: "Pi execution instrumentation" },
          authority: "declared",
          nodes: [{ id: "verify", label: "VERIFY", kind: "verifier" }],
          edges: [],
          entryNodeIds: ["verify"],
          terminalNodeIds: ["verify"],
        },
      },
      { type: "execution.node.completed", executionId: "audit", nodeId: "verify", activationId: "verify-1", status: "passed", summary: "green" },
      { type: "execution.completed", executionId: "audit", status: "completed" },
    ];
    await writeFile(path, `${events.map((event) => JSON.stringify({ at: "2026-07-20T00:00:00.000Z", ...event })).join("\n")}\n`);

    const replay = await loadRunTrace(path);
    expect(replay).toMatchObject({ inferredHarness: "pi", count: 5 });
    expect(replay.state.snapshot()).toMatchObject({
      mode: "observed",
      executions: [{
        id: "audit",
        status: "completed",
        verification: { status: "passed", summary: "green" },
        activations: [expect.objectContaining({ status: "passed" })],
      }],
    });
  });
});
