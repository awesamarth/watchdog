import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PI_BIN = process.env.WATCHDOG_PI_BIN ?? "pi";

export async function runPiWithWatchdog(piArgs: string[]): Promise<number> {
  const extensionPath = resolvePiExtension();
  const cliSpawn = JSON.stringify({
    command: process.execPath,
    args: [...process.execArgv, process.argv[1]],
  });
  const child = spawn(PI_BIN, ["--extension", extensionPath, ...piArgs], {
    cwd: process.cwd(),
    env: { ...process.env, WATCHDOG_CLI_SPAWN: cliSpawn },
    stdio: "inherit",
  });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function resolvePiExtension(moduleUrl = import.meta.url): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    process.env.WATCHDOG_PI_EXTENSION,
    join(moduleDirectory, "pi-extension.js"),
    join(moduleDirectory, "..", "pi", "extension.ts"),
    join(process.cwd(), "dist", "pi-extension.js"),
    join(process.cwd(), "src", "pi", "extension.ts"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const extension = candidates.find((candidate) => existsSync(candidate));
  if (!extension) throw new Error("Watchdog's Pi extension is missing. Rebuild or reinstall the package.");
  return extension;
}
