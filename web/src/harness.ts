import type { AdapterDescriptor } from "./types";

export function harnessDisplayName(adapter?: AdapterDescriptor): string {
  const harness = adapter?.harness.toLowerCase();
  if (!harness) return "STANDBY";
  if (harness === "codex") return "CODEX";
  if (harness === "pi") return "PI";
  if (harness === "claude" || harness === "claude-code") return "CLAUDE CODE";
  if (harness === "opencode" || harness === "open-code") return "OPENCODE";
  return adapter!.harness.replaceAll("-", " ").toUpperCase();
}

export function harnessSlug(adapter?: AdapterDescriptor): string {
  return (adapter?.harness ?? "standby").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
