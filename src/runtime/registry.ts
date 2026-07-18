import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AdapterDescriptor } from "../adapters/types.js";

export type RegisteredRun = {
  version: 1;
  runId: string;
  cwd: string;
  projectName: string;
  socketPath: string;
  pid: number;
  startedAt: string;
  adapter: AdapterDescriptor;
};

export type RegistryOptions = {
  home?: string;
  cwd?: string;
};

export function watchdogHome(home = process.env.WATCHDOG_HOME ?? join(homedir(), ".watchdog")): string {
  return resolve(home);
}

export function createRunId(harness: string): string {
  const prefix = harness.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function runSocketPath(runId: string, home?: string): string {
  const validatedRunId = safeRunId(runId);
  const homeHash = shortHash(watchdogHome(home));
  const runHash = shortHash(validatedRunId, 16);
  const user = typeof process.getuid === "function" ? process.getuid() : "user";
  return join("/tmp", `watchdog-${user}`, `${homeHash}-${runHash}.sock`);
}

export async function registerRun(input: Omit<RegisteredRun, "version" | "projectName">, options: RegistryOptions = {}): Promise<RegisteredRun> {
  const record: RegisteredRun = {
    version: 1,
    ...input,
    cwd: resolve(input.cwd),
    projectName: basename(resolve(input.cwd)) || resolve(input.cwd),
  };
  const directory = registryDirectory(options.home);
  await mkdir(directory, { recursive: true });
  const target = registryFile(record.runId, options.home);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return record;
}

export async function unregisterRun(runId: string, options: RegistryOptions = {}): Promise<void> {
  await rm(registryFile(runId, options.home), { force: true });
}

export async function listRegisteredRuns(options: RegistryOptions = {}): Promise<RegisteredRun[]> {
  const directory = registryDirectory(options.home);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    try {
      const value = JSON.parse(await readFile(join(directory, name), "utf8")) as RegisteredRun;
      if (!isRegisteredRun(value)) return undefined;
      if (options.cwd && resolve(value.cwd) !== resolve(options.cwd)) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }));
  return records.filter((record): record is RegisteredRun => Boolean(record))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function registryDirectory(home?: string): string {
  return join(watchdogHome(home), "registry");
}

function registryFile(runId: string, home?: string): string {
  return join(registryDirectory(home), `${safeRunId(runId)}.json`);
}

function safeRunId(runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(runId)) throw new Error(`Invalid Watchdog run id '${runId}'`);
  return runId;
}

function shortHash(value: string, length = 8): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function isRegisteredRun(value: unknown): value is RegisteredRun {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RegisteredRun>;
  return record.version === 1
    && typeof record.runId === "string"
    && typeof record.cwd === "string"
    && typeof record.projectName === "string"
    && typeof record.socketPath === "string"
    && typeof record.pid === "number"
    && typeof record.startedAt === "string"
    && Boolean(record.adapter)
    && typeof record.adapter?.harness === "string";
}
