/**
 * The one place whotop starts another program.
 *
 * Nothing here is mocked. `run` is asked to start real processes — Node
 * itself, which is by definition present — because what it promises is about
 * how a real spawn fails, and a fake spawn cannot fail those ways. The promise
 * is narrow and absolute: it never throws. A missing `ss`, a denied query, a
 * PowerShell that hangs, are each a warning in the report rather than a
 * crash, and every collector is written assuming that.
 */
import { describe, expect, it } from 'vitest';
import { isMissingBinary, run } from '../src/collectors/exec.js';

/** Node is the one binary that is certainly installed wherever this runs. */
const node = process.execPath;

describe('run', () => {
  it('captures what the program printed', async () => {
    const result = await run(node, ['-e', 'process.stdout.write("4310 vite")']);

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('4310 vite');
    expect(result.stderr).toBe('');
    expect(result.error).toBeNull();
  });

  it('keeps stderr apart from stdout', async () => {
    const result = await run(node, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("Get-NetTCPConnection is unavailable")',
    ]);

    expect(result.stdout).toBe('out');
    expect(result.stderr).toContain('unavailable');
    expect(result.ok).toBe(true);
  });

  /**
   * A non-zero exit is an answer, not an exception. `ss` returning 1 because
   * it was denied something still leaves whatever it managed to print, and
   * that partial output is worth reporting.
   */
  it('reports a failure without throwing, and keeps the output anyway', async () => {
    const result = await run(node, ['-e', 'process.stdout.write("partial"); process.exit(3)']);

    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('partial');
    expect(result.error).not.toBeNull();
  });

  /**
   * The case every collector branches on. Linux without `ss` falls back to
   * /proc/net; Windows without `powershell.exe` tries `pwsh.exe`. Both need
   * "the binary is not here" told apart from "the binary said no".
   */
  it('says a missing binary is missing, rather than failing some other way', async () => {
    const result = await run('whotop-no-such-binary-anywhere', ['--version']);

    expect(result.ok).toBe(false);
    expect(isMissingBinary(result)).toBe(true);
    expect(result.stdout).toBe('');
  });

  it('does not mistake a program that ran and failed for a missing one', async () => {
    const result = await run(node, ['-e', 'process.exit(1)']);

    expect(result.ok).toBe(false);
    expect(isMissingBinary(result)).toBe(false);
  });

  /**
   * A collector that waited forever on a wedged PowerShell would hang the
   * whole screen, and the screen is what the reader is looking at.
   */
  it('gives up on a program that will not finish', async () => {
    const started = Date.now();
    const result = await run(node, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 150 });

    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    expect(isMissingBinary(result)).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('passes an environment through when given one', async () => {
    const result = await run(node, ['-e', 'process.stdout.write(process.env.WHOTOP_TEST ?? "unset")'], {
      env: { ...process.env, WHOTOP_TEST: 'passed' },
    });

    expect(result.stdout).toBe('passed');
  });

  /**
   * Process tables get large. A default buffer would truncate the answer on a
   * busy machine, which is the machine somebody is most likely to be asking
   * about, and truncated JSON does not parse.
   */
  it('holds more output than a process table will ever be', async () => {
    const result = await run(node, ['-e', 'process.stdout.write("x".repeat(2_000_000))']);

    expect(result.ok).toBe(true);
    expect(result.stdout).toHaveLength(2_000_000);
  });

  it('cuts output off rather than crash when a limit is set', async () => {
    const result = await run(node, ['-e', 'process.stdout.write("x".repeat(100_000))'], { maxBuffer: 1024 });

    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
  });
});

describe('isMissingBinary', () => {
  it('is false for a result that never failed', () => {
    expect(isMissingBinary({ ok: true, code: 0, stdout: 'x', stderr: '', error: null })).toBe(false);
  });

  it('recognises only ENOENT', () => {
    const enoent = Object.assign(new Error('spawn ss ENOENT'), { code: 'ENOENT' });
    const denied = Object.assign(new Error('spawn ss EACCES'), { code: 'EACCES' });

    expect(isMissingBinary({ ok: false, code: null, stdout: '', stderr: '', error: enoent })).toBe(true);
    expect(isMissingBinary({ ok: false, code: null, stdout: '', stderr: '', error: denied })).toBe(false);
  });
});
