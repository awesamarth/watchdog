import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dashboardAssetsPath } from "../server/dashboard.js";
import { listReachableRuns } from "./control.js";

type Check = { label: string; ok: boolean; detail: string; required?: boolean };

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ label: "Node runtime", ok: nodeMajor >= 22, required: true, detail: `v${process.versions.node} (requires 22+)` });

  const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
  const codexVersion = (codex.stdout || codex.stderr).trim();
  const codexAvailable = codex.status === 0;
  checks.push({ label: "Codex CLI", ok: codexAvailable, detail: codexAvailable ? codexVersion : "not found on PATH (optional when using Pi only)" });
  const pi = spawnSync("pi", ["--version"], { encoding: "utf8" });
  const piVersion = (pi.stdout || pi.stderr).trim();
  const piAvailable = pi.status === 0;
  checks.push({ label: "Pi CLI", ok: piAvailable, detail: piAvailable ? piVersion : "not found on PATH (optional when using Codex only)" });
  checks.push({
    label: "Agent harness",
    ok: codexAvailable || piAvailable,
    required: true,
    detail: codexAvailable || piAvailable ? [codexAvailable && "Codex", piAvailable && "Pi"].filter(Boolean).join(" + ") : "install Codex CLI or Pi",
  });

  try {
    const assets = dashboardAssetsPath();
    checks.push({ label: "Dashboard assets", ok: existsSync(`${assets}/index.html`), required: true, detail: assets });
  } catch (error) {
    checks.push({ label: "Dashboard assets", ok: false, required: true, detail: error instanceof Error ? error.message : String(error) });
  }

  const active = await listReachableRuns({ cwd: process.cwd() });
  if (active.length) {
    const agents = active.reduce((sum, run) => sum + run.snapshot.agents.length, 0);
    const harnesses = [...new Set(active.map((run) => run.snapshot.adapter?.harness ?? run.snapshot.mode))].join(", ");
    checks.push({ label: "Project runtime", ok: true, detail: `${active.length} active · ${harnesses} · ${agents} agents` });
  } else {
    checks.push({ label: "Project runtime", ok: true, detail: "inactive (expected until `watchdog codex`, `watchdog pi`, or `watchdog observe` starts)" });
  }

  console.log("Watchdog doctor\n");
  for (const check of checks) console.log(`${check.ok ? "✓" : check.required ? "✗" : "–"} ${check.label.padEnd(18)} ${check.detail}`);
  const failures = checks.filter((check) => check.required && !check.ok);
  if (failures.length) {
    process.exitCode = 1;
    console.log(`\n${failures.length} required check${failures.length === 1 ? "" : "s"} failed.`);
  } else {
    console.log("\nReady for a Watchdog-owned run.");
  }
}
