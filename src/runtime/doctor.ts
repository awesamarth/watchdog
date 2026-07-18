import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dashboardAssetsPath } from "../server/dashboard.js";
import { requestControlAt } from "./control.js";
import { listRegisteredRuns, unregisterRun } from "./registry.js";
import type { RunSnapshot } from "./state.js";

type Check = { label: string; ok: boolean; detail: string; required?: boolean };

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ label: "Node runtime", ok: nodeMajor >= 22, required: true, detail: `v${process.versions.node} (requires 22+)` });

  const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
  const codexVersion = (codex.stdout || codex.stderr).trim();
  checks.push({ label: "Codex CLI", ok: codex.status === 0, required: true, detail: codex.status === 0 ? codexVersion : "not found on PATH" });

  try {
    const assets = dashboardAssetsPath();
    checks.push({ label: "Dashboard assets", ok: existsSync(`${assets}/index.html`), required: true, detail: assets });
  } catch (error) {
    checks.push({ label: "Dashboard assets", ok: false, required: true, detail: error instanceof Error ? error.message : String(error) });
  }

  const records = await listRegisteredRuns({ cwd: process.cwd() });
  const active: Array<{ snapshot: RunSnapshot }> = [];
  for (const record of records) {
    try {
      active.push({ snapshot: await requestControlAt(record.socketPath, { action: "snapshot" }) as RunSnapshot });
    } catch {
      await unregisterRun(record.runId);
    }
  }
  if (active.length) {
    const agents = active.reduce((sum, run) => sum + run.snapshot.agents.length, 0);
    const harnesses = [...new Set(active.map((run) => run.snapshot.adapter?.harness ?? run.snapshot.mode))].join(", ");
    checks.push({ label: "Project runtime", ok: true, detail: `${active.length} active · ${harnesses} · ${agents} agents` });
  } else {
    checks.push({ label: "Project runtime", ok: true, detail: "inactive (expected until `watchdog codex`, `observe`, or `demo` starts)" });
  }

  console.log("Watchdog doctor\n");
  for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.label.padEnd(18)} ${check.detail}`);
  const failures = checks.filter((check) => check.required && !check.ok);
  if (failures.length) {
    process.exitCode = 1;
    console.log(`\n${failures.length} required check${failures.length === 1 ? "" : "s"} failed.`);
  } else {
    console.log("\nReady for a Watchdog-owned Codex run.");
  }
}
