import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunLogs } from "./codex.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex run logs", () => {
  it("records live events and diagnostics without writing into the active terminal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "watchdog-codex-logs-"));
    temporaryDirectories.push(directory);
    const terminal = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = await createRunLogs(directory);

    logs.event({ type: "thread.started", threadId: "root-thread" });
    logs.diagnostic("app-server", "synthetic diagnostic");
    await logs.flush();

    expect(terminal).not.toHaveBeenCalled();
    expect(await readFile(logs.eventPath, "utf8")).toContain('"type":"thread.started"');
    expect(await readFile(logs.diagnosticPath, "utf8")).toContain("[app-server] synthetic diagnostic");
  });
});
