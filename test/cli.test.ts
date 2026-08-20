import { describe, expect, it, vi } from 'vitest';
import { parseCliArgs } from '../src/cli.js';
import { createPalette, detectColorSupport, padEndVisible, visibleLength } from '../src/color.js';
import { describeTarget, killProcesses, signalNote } from '../src/kill.js';
import { formatAge, formatPorts, wrap } from '../src/render.js';
import { exact, unavailable } from '../src/types.js';
import type { ProcessView } from '../src/types.js';

describe('parseCliArgs', () => {
  /**
   * The bare name opens the interactive screen, changed 2026-08-19. The rule is
   * deliberately "no arguments at all" rather than "no positionals", so that
   * anything scripted still gets the one-shot listing and never blocks waiting
   * on a terminal that is not attached.
   */
  it('opens the interactive screen when given nothing at all', () => {
    expect(parseCliArgs([]).command).toBe('top');
  });

  it('still gives the plain listing to anything with arguments', () => {
    expect(parseCliArgs(['ls']).command).toBe('ls');
    expect(parseCliArgs(['--all']).command).toBe('ls');
    expect(parseCliArgs(['vite']).command).toBe('ls');
  });

  it('reads a bare query as a filter', () => {
    expect(parseCliArgs(['vite']).query).toBe('vite');
  });

  it('parses the port subcommand', () => {
    const parsed = parseCliArgs(['port', '4310']);
    expect(parsed.command).toBe('port');
    expect(parsed.ports).toEqual([4310]);
  });

  it('rejects a port subcommand with no number', () => {
    expect(() => parseCliArgs(['port'])).toThrow(/needs a port number/);
    expect(() => parseCliArgs(['port', 'abc'])).toThrow(/not a port number/);
  });

  it('requires a target for kill', () => {
    expect(() => parseCliArgs(['kill'])).toThrow(/--port .* or --pid/);
    expect(parseCliArgs(['kill', '--port', '4310']).ports).toEqual([4310]);
    expect(parseCliArgs(['kill', '1234']).pids).toEqual([1234]);
  });

  it('accepts comma separated and repeated roles', () => {
    expect(parseCliArgs(['-r', 'dev-server,mcp-server', '-r', 'watcher']).roles).toEqual([
      'dev-server',
      'mcp-server',
      'watcher',
    ]);
  });

  it('rejects an unknown role with the list of known ones', () => {
    expect(() => parseCliArgs(['--role', 'nonsense'])).toThrow(/unknown role .*dev-server/s);
  });

  it('maps signal names', () => {
    expect(parseCliArgs(['kill', '1', '--signal', 'kill']).signal).toBe('SIGKILL');
    expect(parseCliArgs(['kill', '1', '--signal', 'int']).signal).toBe('SIGINT');
    expect(parseCliArgs(['kill', '1']).signal).toBe('SIGTERM');
    expect(() => parseCliArgs(['kill', '1', '--signal', 'hup'])).toThrow(/unknown signal/);
  });

  it('handles --no-color, which older Node cannot parse on its own', () => {
    expect(parseCliArgs(['--no-color']).color).toBe(false);
    expect(parseCliArgs(['--color']).color).toBe(true);
    expect(parseCliArgs([]).color).toBeNull();
  });

  it('rejects an unknown sort key', () => {
    expect(() => parseCliArgs(['--sort', 'colour'])).toThrow(/unknown sort key/);
  });
});

describe('colour', () => {
  it('honours NO_COLOR above everything else', () => {
    expect(detectColorSupport({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false);
  });

  it('honours FORCE_COLOR when there is no TTY', () => {
    expect(detectColorSupport({ FORCE_COLOR: '1' }, false)).toBe(true);
  });

  it('stays off when the output is not a terminal', () => {
    expect(detectColorSupport({}, false)).toBe(false);
  });

  it('measures visible length without the escape codes, so columns line up', () => {
    const painted = createPalette(true)('red', 'abc');
    expect(painted.length).toBeGreaterThan(3);
    expect(visibleLength(painted)).toBe(3);
    expect(visibleLength(padEndVisible(painted, 10))).toBe(10);
  });
});

describe('render helpers', () => {
  it('formats an age at the right scale', () => {
    expect(formatAge(5_000)).toBe('5s');
    expect(formatAge(90_000)).toBe('1m');
    expect(formatAge(3 * 3_600_000 + 600_000)).toBe('3h 10m');
    expect(formatAge(50 * 3_600_000)).toBe('2d 2h');
    expect(formatAge(null)).toBe('?');
  });

  it('shows only listening ports, deduplicated and capped', () => {
    const ports = [4310, 4310, 80, 443, 8080, 9000, 9001].map((port) => ({
      protocol: 'tcp' as const,
      address: '::',
      port,
      state: 'listen',
      pid: 1,
    }));
    expect(formatPorts(ports)).toBe('80 443 4310 8080 +2');
    expect(formatPorts([{ protocol: 'tcp', address: '::', port: 1, state: 'established', pid: 1 }])).toBe('');
  });

  it('wraps long lines with a hanging indent', () => {
    const lines = wrap('aaaa bbbb cccc dddd eeee ffff', 20, 4);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]?.startsWith('    ')).toBe(true);
  });
});

const view = (over: Partial<ProcessView> = {}): ProcessView => ({
  pid: 9120,
  ppid: 1,
  name: 'node.exe',
  exePath: null,
  commandLine: exact('node vite.js'),
  cwd: exact('/projects/shop-web'),
  startedAt: null,
  user: null,
  services: [],
  classification: { role: 'dev-server', confidence: 0.8, reason: 'vite', matches: [], label: 'vite' },
  ports: [],
  orphan: exact(true),
  ageMs: null,
  project: unavailable<string>('n/a'),
  ...over,
});

describe('kill', () => {
  it('describes a target in terms a human can check before agreeing', () => {
    expect(describeTarget(view(), 4310)).toBe(
      'pid 9120, vite, holding port 4310, in /projects/shop-web, orphan',
    );
  });

  it('warns that a signal on Windows is not a graceful shutdown', () => {
    expect(signalNote('win32', 'SIGTERM')).toMatch(/TerminateProcess/);
    expect(signalNote('linux', 'SIGTERM')).toBeNull();
  });

  it('reports each outcome instead of failing the whole batch', async () => {
    const send = vi.fn((pid: number) => {
      if (pid === 2) {
        const error = new Error('no such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
    });
    const outcomes = await killProcesses([view({ pid: 1 }), view({ pid: 2 })], 'SIGTERM', { send });
    expect(outcomes).toEqual([
      { pid: 1, ok: true },
      { pid: 2, ok: false, error: 'the process had already exited' },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('explains a permission failure', async () => {
    const send = (): never => {
      const error = new Error('denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    };
    const [outcome] = await killProcesses([view()], 'SIGKILL', { send });
    expect(outcome?.error).toMatch(/permission denied/);
  });
});
