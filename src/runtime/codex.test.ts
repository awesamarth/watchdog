import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunLogs, watchdogMcpConfigArgs } from "./codex.js";

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

  it("builds a run-scoped required Watchdog MCP config for the owned App Server", () => {
    const args = watchdogMcpConfigArgs("codex-run-123", {
      execPath: "/usr/local/bin/node",
      execArgv: ["--import", "/tmp/tsx-loader.mjs", "--inspect=9229"],
      scriptPath: "/opt/watchdog/dist/cli.js",
    });
    const joined = args.join(" ");

    expect(joined).toContain('mcp_servers.watchdog.command="/usr/local/bin/node"');
    expect(joined).toContain('["--import","/tmp/tsx-loader.mjs","/opt/watchdog/dist/cli.js","mcp","--run","codex-run-123"]');
    expect(joined).toContain("mcp_servers.watchdog.required=true");
    expect(joined).toContain('mcp_servers.watchdog.default_tools_approval_mode="approve"');
    expect(joined).not.toContain("--inspect");
  });
});
