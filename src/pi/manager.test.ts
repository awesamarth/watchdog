import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WatchdogEvent } from "../adapters/events.js";
import { PiWorkerManager } from "./manager.js";
import { PiRpcClient, type PiRpcClientOptions } from "./rpc.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));

describe("PiWorkerManager", () => {
  it("does not expose nested delegation to ordinary workers", async () => {
    const launches: PiRpcClientOptions[] = [];
    const events: WatchdogEvent[] = [];
    const manager = new PiWorkerManager({
      rootId: "root",
      cwd: process.cwd(),
      extensionPath: "/tmp/watchdog-test-extension.js",
      coordinatorSocket: "/tmp/watchdog-test-coordinator.sock",
      emit: (event) => events.push(event),
      createClient: (options) => {
        launches.push(options);
        return new PiRpcClient({
          ...options,
          piBin: process.execPath,
          piArgsPrefix: [fixture],
        });
      },
    });

    await manager.execute("root", {
      action: "spawn",
      tasks: [{ name: "Ordinary", task: "inspect without delegation" }],
    });
    const ordinary = manager.get("Ordinary");
    expect(ordinary.delegation).toBeUndefined();
    expect(launches[0]).toMatchObject({
      extensionPath: "/tmp/watchdog-test-extension.js",
      env: {
        WATCHDOG_PI_ALLOW_DELEGATION: "0",
        WATCHDOG_PI_COORDINATOR_TOKEN: expect.any(String),
      },
    });
    const instrumentationToken = launches[0]?.env?.WATCHDOG_PI_COORDINATOR_TOKEN;
    expect(manager.executeDelegatedExecution(instrumentationToken!, {
      action: "declare",
      executionId: "ordinary-workflow",
      nodes: [{ id: "inspect", label: "INSPECT", kind: "stage" }],
      edges: [],
    })).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
      type: "execution.declared",
      graph: expect.objectContaining({ id: "ordinary-workflow", ownerThreadId: ordinary.id }),
    }));
    await expect(manager.executeDelegated(instrumentationToken!, { action: "list" }))
      .rejects.toThrow("Ordinary is not allowed to delegate");
    await expect(manager.execute(ordinary.id, {
      action: "spawn",
      tasks: [{ name: "Unexpected", task: "must not start" }],
    })).rejects.toThrow("Ordinary is not allowed to delegate");
    expect(manager.list()).toHaveLength(1);
    await manager.close();
  });

  it("enforces explicit child/depth budgets and scopes a worker to its own subtree", async () => {
    const launches: PiRpcClientOptions[] = [];
    const manager = new PiWorkerManager({
      rootId: "root",
      cwd: process.cwd(),
      extensionPath: "/tmp/watchdog-test-extension.js",
      coordinatorSocket: "/tmp/watchdog-test-coordinator.sock",
      emit: () => undefined,
      createClient: (options) => {
        launches.push(options);
        return new PiRpcClient({
          ...options,
          piBin: process.execPath,
          piArgsPrefix: [fixture],
        });
      },
    });

    const parentRun = manager.execute("root", {
      action: "spawn",
      tasks: [{
        name: "Parent",
        task: "SLOW parent",
        tools: ["read"],
        allowDelegation: true,
        maxChildren: 1,
        maxDepth: 1,
      }],
    });
    await waitFor(() => manager.get("Parent").status === "working");
    const delegationToken = launches[0]?.env?.WATCHDOG_PI_COORDINATOR_TOKEN;
    expect(delegationToken).toEqual(expect.any(String));
    await expect(manager.executeDelegated("forged-token", { action: "list" }))
      .rejects.toThrow("Invalid or expired");
    await expect(manager.executeDelegated(delegationToken!, {
      action: "spawn",
      tasks: [{
        name: "OverDeep",
        task: "attempt another generation",
        allowDelegation: true,
        maxChildren: 1,
        maxDepth: 1,
      }],
    })).rejects.toThrow("cannot receive delegation permission");
    const nestedRun = manager.executeDelegated(delegationToken!, {
      action: "spawn",
      tasks: [{ name: "Nested", task: "inspect one bounded thing" }],
    });
    await Promise.all([parentRun, nestedRun]);

    expect(manager.get("Parent").delegation).toEqual({
      maxChildren: 1,
      spawnedChildren: 1,
      maxDepth: 1,
    });
    expect(launches[0]).toMatchObject({
      extensionPath: "/tmp/watchdog-test-extension.js",
      tools: ["read", "watchdog_execution", "subagent"],
      env: {
        WATCHDOG_PI_ALLOW_DELEGATION: "1",
        WATCHDOG_PI_COORDINATOR_SOCKET: "/tmp/watchdog-test-coordinator.sock",
        WATCHDOG_PI_COORDINATOR_TOKEN: expect.any(String),
      },
    });
    expect(launches[1]).toMatchObject({
      extensionPath: "/tmp/watchdog-test-extension.js",
      env: {
        WATCHDOG_PI_ALLOW_DELEGATION: "0",
        WATCHDOG_PI_COORDINATOR_TOKEN: expect.any(String),
      },
    });

    await manager.execute("root", {
      action: "spawn",
      tasks: [{ name: "Sibling", task: "inspect separately" }],
    });
    await expect(manager.executeDelegated(delegationToken!, { action: "list" })).resolves.toEqual({
      agents: [expect.objectContaining({ name: "Nested" })],
    });
    await expect(manager.executeDelegated(delegationToken!, {
      action: "retry",
      agent: "Sibling",
      message: "cross the boundary",
    })).rejects.toThrow("delegated subtree");
    await expect(manager.executeDelegated(delegationToken!, {
      action: "spawn",
      tasks: [{ name: "TooMany", task: "exceed the child budget" }],
    })).rejects.toThrow("lifetime limit 1");
    await expect(manager.execute(manager.get("Nested").id, {
      action: "spawn",
      tasks: [{ name: "Grandchild", task: "must not fan out" }],
    })).rejects.toThrow("Nested is not allowed to delegate");
    expect(manager.list()).toHaveLength(3);
    await manager.close();
  });

  it("creates persistent controlled workers and preserves requested/effective configuration", async () => {
    const events: WatchdogEvent[] = [];
    const manager = new PiWorkerManager({
      rootId: "root",
      cwd: process.cwd(),
      extensionPath: "/tmp/watchdog-test-extension.js",
      coordinatorSocket: "/tmp/watchdog-test-coordinator.sock",
      emit: (event) => events.push(event),
      maxConcurrent: 1,
      createClient: (options) => new PiRpcClient({
        ...options,
        piBin: process.execPath,
        piArgsPrefix: [fixture],
      }),
    });

    const result = await manager.execute("root", {
      action: "spawn",
      tasks: [
        { name: "Scout", role: "investigator", task: "inspect A", model: "test/test-model", thinking: "medium" },
        { name: "Verifier", role: "verifier", task: "inspect B" },
      ],
    }) as { agents: Array<{ name: string; status: string; totalTokens: number }> };

    expect(result.agents).toEqual([
      expect.objectContaining({ name: "Scout", status: "idle", totalTokens: 15 }),
      expect.objectContaining({ name: "Verifier", status: "idle", totalTokens: 15 }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.requestedConfig",
      model: "test/test-model",
      reasoningEffort: "medium",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.effectiveConfig",
      model: "test/test-model",
      reasoningEffort: "medium",
    }));

    const retried = await manager.retry("Scout", {
      message: "inspect C",
      model: "test/other-model",
      thinking: "high",
    }) as { model?: string; thinking?: string; latestMessage?: string };
    expect(retried).toMatchObject({
      model: "test/other-model",
      thinking: "high",
      latestMessage: "done: inspect C",
    });

    expect(manager.queueFollowUp("Scout", "inspect D")).toEqual({ queued: "Scout", mode: "new-turn" });
    await waitFor(() => manager.get("Scout").latestMessage === "done: inspect D");

    await manager.close();
  });

  it("queues a follow-up into active work without starting a competing worker turn", async () => {
    const events: WatchdogEvent[] = [];
    const manager = new PiWorkerManager({
      rootId: "root",
      cwd: process.cwd(),
      extensionPath: "/tmp/watchdog-test-extension.js",
      coordinatorSocket: "/tmp/watchdog-test-coordinator.sock",
      emit: (event) => events.push(event),
      createClient: (options) => new PiRpcClient({
        ...options,
        piBin: process.execPath,
        piArgsPrefix: [fixture],
      }),
    });
    const running = manager.execute("root", { action: "spawn", tasks: [{ name: "Active", task: "SLOW" }] });
    await waitFor(() => manager.get("Active").status === "working");

    await expect(manager.execute("root", {
      action: "follow_up",
      agent: "Active",
      message: "inspect after slow work",
    })).resolves.toEqual({ queued: "Active", mode: "follow-up" });

    await running;
    expect(manager.get("Active")).toMatchObject({
      status: "idle",
      latestMessage: "done: inspect after slow work",
      totalTokens: 30,
    });
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    await manager.close();
  });

  it("serializes an active retry after the interrupted turn has cleaned up", async () => {
    const events: WatchdogEvent[] = [];
    const manager = new PiWorkerManager({
      rootId: "root",
      cwd: process.cwd(),
      extensionPath: "/tmp/watchdog-test-extension.js",
      coordinatorSocket: "/tmp/watchdog-test-coordinator.sock",
      emit: (event) => events.push(event),
      createClient: (options) => new PiRpcClient({
        ...options,
        piBin: process.execPath,
        piArgsPrefix: [fixture],
      }),
    });
    const firstRun = manager.execute("root", {
      action: "spawn",
      tasks: [{ name: "Retrying", task: "SLOW first attempt" }],
    });
    await waitFor(() => manager.get("Retrying").status === "working");

    const retry = manager.retry("Retrying", {
      message: "second attempt",
      model: "test/other-model",
      thinking: "high",
    });
    await Promise.all([firstRun, retry]);

    expect(manager.get("Retrying")).toMatchObject({
      status: "idle",
      latestMessage: "done: second attempt",
      model: "test/other-model",
      thinking: "high",
    });
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(2);
    await manager.close();
  });

  it("stops active work and reports parent notification truthfully", async () => {
    const manager = new PiWorkerManager({
      rootId: "root",
      cwd: process.cwd(),
      extensionPath: "/tmp/watchdog-test-extension.js",
      coordinatorSocket: "/tmp/watchdog-test-coordinator.sock",
      emit: () => undefined,
      createClient: (options) => new PiRpcClient({
        ...options,
        piBin: process.execPath,
        piArgsPrefix: [fixture],
      }),
    });
    const running = manager.execute("root", { action: "spawn", tasks: [{ name: "Slow", task: "SLOW" }] });
    await waitFor(() => manager.list()[0]?.status === "working");
    await expect(manager.stop("Slow")).resolves.toMatchObject({
      stopped: "Slow",
      parentNotified: true,
      notificationTarget: "Pi root",
    });
    await running;
    expect(manager.get("Slow").status).toBe("stopped");
    await manager.close();
  });

  it("keeps a nested parent stopped when its delegated child finishes later", async () => {
    const manager = new PiWorkerManager({
      rootId: "root",
      cwd: process.cwd(),
      extensionPath: "/tmp/watchdog-test-extension.js",
      coordinatorSocket: "/tmp/watchdog-test-coordinator.sock",
      emit: () => undefined,
      maxConcurrent: 1,
      createClient: (options) => new PiRpcClient({
        ...options,
        piBin: process.execPath,
        piArgsPrefix: [fixture],
      }),
    });
    const parentRun = manager.execute("root", {
      action: "spawn",
      tasks: [{
        name: "Parent",
        task: "SLOW parent",
        allowDelegation: true,
        maxChildren: 1,
        maxDepth: 1,
      }],
    });
    await waitFor(() => manager.get("Parent").status === "working");
    const parentId = manager.get("Parent").id;
    const nestedRun = manager.execute(parentId, {
      action: "spawn",
      tasks: [{ name: "Nested", task: "SLOW nested" }],
    });
    await waitFor(() => manager.get("Parent").status === "waiting");

    await manager.stop("Parent");
    await Promise.all([parentRun, nestedRun]);
    expect(manager.get("Parent").status).toBe("stopped");
    await manager.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
