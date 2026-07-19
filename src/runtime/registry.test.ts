import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterDescriptor } from "../adapters/types.js";
import { ControlRequestTimeoutError, listReachableRuns, requestControl, requestControlAt, startRunControlServer, type ControlHandlers } from "./control.js";
import { listRegisteredRuns, registerRun } from "./registry.js";
import type { RunSnapshot } from "./state.js";

describe("multi-run registry and control sockets", () => {
  it("gives harness-neutral guidance when no run matches the directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "watchdog-empty-registry-"));
    try {
      await expect(requestControl({ action: "snapshot" }, { home, cwd: join(home, "project") }))
        .rejects.toThrow("Launch a harness (Codex, Pi) through Watchdog");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps simultaneous runs in one project independently addressable", async () => {
    const home = await mkdtemp(join(tmpdir(), "watchdog-registry-"));
    const cwd = join(home, "same-project");
    const codex = descriptor("codex", "Codex App Server");
    const pi = descriptor("pi", "Pi RPC");
    const first = await startRunControlServer(handlers("Codex root", codex), codex, { home, cwd, runId: "codex-one" });
    const second = await startRunControlServer(handlers("Pi root", pi), pi, { home, cwd, runId: "pi-two" });

    try {
      expect(first.path).not.toBe(second.path);
      expect(await listRegisteredRuns({ home, cwd })).toHaveLength(2);
      await expect(requestControl({ action: "snapshot" }, { home, cwd })).rejects.toThrow("Multiple Watchdog runs");
      await expect(requestControl({ action: "snapshot" }, { home, runId: "codex" })).resolves.toMatchObject({
        agents: [{ nickname: "Codex root" }],
      });
      await expect(requestControl({ action: "snapshot" }, { home, runId: "pi-two" })).resolves.toMatchObject({
        agents: [{ nickname: "Pi root" }],
      });
      await expect(requestControl({ action: "steer", agent: "codex-root", message: "test" }, { home, runId: "codex-one" }))
        .rejects.toThrow("fixture control failure");
      expect(await listRegisteredRuns({ home, cwd })).toHaveLength(2);

      await first.close();
      expect(await listRegisteredRuns({ home, cwd })).toHaveLength(1);
      await expect(requestControl({ action: "snapshot" }, { home, cwd })).resolves.toMatchObject({
        agents: [{ nickname: "Pi root" }],
      });
    } finally {
      await first.close();
      await second.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("bounds a control request when a connected runtime never responds", async () => {
    const home = await mkdtemp(join(tmpdir(), "watchdog-silent-control-"));
    const path = join(home, "silent.sock");
    let accepted: Socket | undefined;
    const server = createServer((socket) => {
      accepted = socket;
      socket.on("data", () => undefined);
    });
    await new Promise<void>((resolve, reject) => server.listen(path, resolve).once("error", reject));
    await registerRun({
      runId: "silent-run",
      cwd: home,
      socketPath: path,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      adapter: descriptor("test", "Silent fixture"),
    }, { home });

    try {
      await expect(requestControlAt(path, { action: "snapshot" }, 40)).rejects.toBeInstanceOf(ControlRequestTimeoutError);
      await expect(listReachableRuns({ home, cwd: home, timeoutMs: 40 })).resolves.toEqual([]);
      expect(await listRegisteredRuns({ home, cwd: home })).toHaveLength(1);
    } finally {
      accepted?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
});

function descriptor(harness: string, label: string): AdapterDescriptor {
  return { harness, label, transport: "fixture", mode: "live" };
}

function handlers(nickname: string, adapter: AdapterDescriptor): ControlHandlers {
  const snapshot: RunSnapshot = {
    startedAt: new Date().toISOString(),
    mode: "live",
    adapter,
    agents: [{ threadId: `${adapter.harness}-root`, nickname, status: "idle" }],
    loops: [],
    executions: [],
  };
  return {
    snapshot: () => snapshot,
    steer: async () => { throw new Error("fixture control failure"); },
    followUp: async () => ({}),
    interrupt: async () => ({}),
    retry: async () => ({}),
    configureLoop: async () => ({}),
    addEvidence: async () => ({}),
    verifyLoop: async () => ({}),
  };
}
