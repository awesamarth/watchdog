const MAX_COMMAND_LABEL = 320;

export function codexToolLabel(tool: string, args: unknown): string {
  const commands = commandValues(args);
  if (!commands.length) return tool;
  const command = commands.length === 1 ? commands[0]! : commands.join(" | ");
  return `command · ${truncate(command, MAX_COMMAND_LABEL)}`;
}

function commandValues(value: unknown): string[] {
  const direct = nestedCommands(value);
  if (direct.length || typeof value !== "string") return direct;

  const parsed = parseJson(value);
  if (parsed !== undefined) {
    const commands = nestedCommands(parsed);
    if (commands.length) return commands;
  }

  const commands: string[] = [];
  for (const match of value.matchAll(/["']cmd["']\s*:\s*("(?:\\.|[^"\\])*")/g)) {
    try {
      const command = JSON.parse(match[1]!) as unknown;
      if (typeof command === "string" && command.trim()) commands.push(command.trim());
    } catch {
      // Dynamic tool source is best-effort display data, never executable input.
    }
  }
  return unique(commands);
}

function nestedCommands(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return unique(value.flatMap((item) => nestedCommands(item, depth + 1)));
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const command = typeof record.cmd === "string"
    ? record.cmd
    : typeof record.command === "string" ? record.command : undefined;
  if (command?.trim()) return [command.trim()];
  return unique(Object.values(record).flatMap((item) => nestedCommands(item, depth + 1)));
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
