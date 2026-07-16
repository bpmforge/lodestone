// Shell command execution (concept: command_execution).
export interface ExecResult {
  stdout: string;
  exitCode: number;
}

const ALLOWED_COMMANDS = new Set(["diff", "convert", "ffprobe"]);

export function runShellCommand(command: string, args: string[]): ExecResult {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`command not allowlisted: ${command}`);
  }
  return spawnProcess(command, args);
}

function spawnProcess(command: string, args: string[]): ExecResult {
  // Placeholder for child_process.execFile(command, args) — fixture only.
  return { stdout: `${command} ${args.join(" ")}`, exitCode: 0 };
}
