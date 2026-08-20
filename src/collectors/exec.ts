import { execFile } from 'node:child_process';

export interface RunResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the binary is missing or the call timed out. */
  readonly error: Error | null;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  /** Process tables get large; 64 MB is well past any real machine. */
  readonly maxBuffer?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Run a helper binary and capture stdout. Never throws: a missing `lsof` or a
 * denied query is a warning in the report, not a crash.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 15_000, maxBuffer = 64 * 1024 * 1024, env } = options;
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: 'utf8', env },
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
          ? ((error as unknown as { code: number }).code)
          : error
            ? null
            : 0;
        resolve({
          ok: !error,
          code,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: error ?? null,
        });
      },
    );
  });
}

/**
 * Why a run produced nothing usable, in a sentence somebody can act on.
 *
 * Not `error.message`. Node builds that as "Command failed: " followed by
 * the whole command line, and the Windows collector passes its script as a
 * base64 -EncodedCommand — four kilobytes of it. A CI log once carried the
 * entire encoded script where the reason should have been, which is how
 * this came to be written.
 */
export function failureReason(result: RunResult): string {
  const stderr = result.stderr.trim();
  if (stderr !== "") return stderr;

  const error = result.error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
  if (error?.killed) return "it was still running when the timeout expired";
  if (error?.code === "ENOENT") return "the program is not installed here";
  if (error?.code === "EACCES") return "the program is there but could not be run";
  if (typeof result.code === "number" && result.code !== 0) {
    return `it exited with code ${result.code} and printed nothing`;
  }
  if (error?.code !== undefined) return `it failed with ${error.code}`;
  return "it printed nothing and gave no reason";
}

/** True when the failure was "the binary does not exist here". */
export function isMissingBinary(result: RunResult): boolean {
  const err = result.error as NodeJS.ErrnoException | null;
  return err?.code === 'ENOENT';
}
