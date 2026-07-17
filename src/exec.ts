import { type ExecFileException, execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Result, tryCatch, withTimeout } from "@micthiesen/mitools/async";

const execFileAsync = promisify(execFile);

// execFile's own timeout only kills the child; if the child ignores the signal or a
// grandchild holds the stdio pipes open, the promise never settles. The outer
// withTimeout guarantees the caller always gets an answer (and SIGKILL can't be ignored).
const KILL_GRACE_MS = 5_000;

export interface ExecOutput {
  stdout: string;
  stderr: string;
}

/** Run a binary with a hard timeout, returning a Result instead of throwing. */
export async function runCommand(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<Result<ExecOutput>> {
  return tryCatch(async () => {
    const { stdout, stderr } = await withTimeout(
      execFileAsync(file, args, {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
      }),
      timeoutMs + KILL_GRACE_MS,
    );
    return { stdout, stderr };
  });
}

/** Human-readable one-liner for a failed subprocess. */
export function describeExecError(error: Error): string {
  const execError = error as ExecFileException & { stderr?: string };
  if (execError.code === "ENOENT") return "binary not found (ENOENT)";
  if (execError.killed)
    return `timed out and was killed (${execError.signal ?? "signal"})`;
  const stderr = execError.stderr?.trim().split("\n").at(-1);
  const exit =
    typeof execError.code === "number" ? `exit ${execError.code}` : error.message;
  return stderr ? `${exit}: ${stderr}` : exit;
}

/** True when the subprocess failed because the binary itself is missing. */
export function isMissingBinaryError(error: Error): boolean {
  return (error as ExecFileException).code === "ENOENT";
}

/** Exit code of a failed subprocess, if it ran and exited non-zero. */
export function exitCodeOf(error: Error): number | undefined {
  const code = (error as ExecFileException).code;
  return typeof code === "number" ? code : undefined;
}
