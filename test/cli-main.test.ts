/**
 * `main` from the outside: arguments in, exit code and output out.
 *
 * The pieces it composes are each tested against fixtures elsewhere. What was
 * never tested is the composition — which subcommand each set of arguments
 * reaches, what each one prints, and which of the four exit codes it returns.
 * Those codes are the contract a script depends on, and `whotop port 4310 ||
 * echo free` is wrong the moment one of them changes.
 *
 * Reading the machine and taking a terminal are injected. Everything between
 * them is the real thing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { exact, inferred, unavailable } from '../src/types.js';
import type { ProcessView, Snapshot } from '../src/types.js';

const view = (over: Partial<ProcessView> = {}): ProcessView => ({
  pid: 9120,
  ppid: 6104,
  name: 'node.exe',
  exePath: null,
  commandLine: exact('node vite.js dev --port 4310'),
  cwd: exact('C:\\Users\\dev\\projects\\shop-web'),
  startedAt: new Date('2026-08-20T09:00:00.000Z'),
  user: null,
  services: [],
  classification: { role: 'dev-server', confidence: 0.78, reason: 'vite', matches: [], label: 'vite' },
  ports: [{ protocol: 'tcp', address: '::', port: 4310, state: 'listen', pid: 9120 }],
  orphan: exact(false),
  ageMs: 3 * 3_600_000,
  project: exact('shop-web'),
  ...over,
});

const orphan = view({
  pid: 9121,
  commandLine: exact('node vite.js dev --port 4311'),
  cwd: inferred('C:\\Users\\dev\\projects\\admin-ui', 'from the command line'),
  ports: [{ protocol: 'tcp', address: '::', port: 4311, state: 'listen', pid: 9121 }],
  orphan: exact(true),
  project: exact('admin-ui'),
});

const silent = view({
  pid: 5684,
  name: 'svchost.exe',
  commandLine: unavailable('Win32_Process withheld the command line for this process'),
  cwd: unavailable('withheld'),
  project: unavailable('withheld'),
  ports: [],
  services: ['WireGuardTunnel$Poland-2'],
  classification: { role: 'unknown', confidence: 0, reason: 'no rule matched', matches: [], label: null },
});

const snapshot = (processes: ProcessView[] = [view(), orphan, silent]): Snapshot => ({
  platform: 'win32',
  capturedAt: new Date('2026-08-20T12:00:00.000Z'),
  capabilities: {
    commandLine: 'partial',
    cwd: 'none',
    ports: 'full',
    user: 'none',
    notes: ['Command lines come from Win32_Process.'],
  },
  processes,
  warnings: ['1 socket(s) were reported without an owning process.'],
});

/** Everything written to stdout and stderr while `main` ran. */
interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function run(
  argv: string[],
  deps: Parameters<typeof main>[1] = {},
  result: Snapshot | Error = snapshot(),
): Promise<Captured> {
  let out = '';
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  spies.push(outSpy, errSpy);

  const inspect = (async () => {
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as NonNullable<Parameters<typeof main>[1]>['inspect'];

  const code = await main(argv, { inspect, ...deps });
  return { code, out, err };
}

describe('main', () => {
  describe('the entry points that never read the machine', () => {
    it('prints usage for help, as a word and as a flag', async () => {
      for (const argv of [['help'], ['--help'], ['-h']]) {
        const result = await run(argv);
        expect(result.code).toBe(0);
        expect(result.out).toContain('Usage');
        expect(result.out).toContain('whotop kill --port');
      }
    });

    it('prints a version number for version, as a word and as a flag', async () => {
      for (const argv of [['version'], ['--version'], ['-V']]) {
        const result = await run(argv);
        expect(result.code).toBe(0);
        expect(result.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
      }
    });

    /**
     * A word that is not a subcommand is a filter, which is what makes
     * `whotop vite` work. It is also why version and help had to be spelled
     * out: before they were, `whotop version` searched for "version" and
     * exited 0, which looks exactly like having worked.
     */
    it('treats an unknown word as a filter rather than an error', async () => {
      const result = await run(['admin-ui']);
      expect(result.code).toBe(0);
      expect(result.out).toContain('admin-ui');
      expect(result.out).not.toContain('shop-web');
    });

    it('refuses an argument it does not know, and says where to look', async () => {
      const result = await run(['--no-such-flag']);
      expect(result.code).toBe(2);
      expect(result.err).toContain('whotop --help');
    });
  });

  describe('the listing', () => {
    it('shows the developer-relevant processes and what they are', async () => {
      const result = await run(['ls']);
      expect(result.code).toBe(0);
      expect(result.out).toContain('dev-server');
      expect(result.out).toContain('4310');
      expect(result.out).toContain('shop-web');
    });

    /**
     * The middle column shows what a process is, not what it is called, so a
     * row is found by its pid. A process with no role and no listening socket
     * is not developer-relevant and is held back until --all asks for it.
     */
    it('keeps the uninteresting ones out until asked', async () => {
      const plain = await run(['ls']);
      const all = await run(['ls', '--all']);
      expect(plain.out).not.toContain('5684');
      expect(all.out).toContain('5684');
      expect(all.out).toContain('no cmdline');
    });

    it('filters by role', async () => {
      const result = await run(['ls', '-r', 'dev-server']);
      expect(result.out).toContain('dev-server');
      expect(result.out).not.toContain('svchost');
    });

    it('filters to the orphans', async () => {
      const result = await run(['ls', '-o']);
      expect(result.out).toContain('4311');
      expect(result.out).not.toContain('4310 ');
    });

    it('filters to what holds a listening socket', async () => {
      const result = await run(['ls', '-l', '--all']);
      expect(result.out).not.toContain('svchost.exe');
    });

    /** Warnings are part of the answer, not decoration: they say what is missing. */
    it('always reports what the platform would not disclose', async () => {
      const result = await run(['ls']);
      expect(result.out).toContain('reported without an owning process');
    });

    it('names the rule behind each row under --explain', async () => {
      const result = await run(['ls', '--explain']);
      expect(result.out).toContain('vite');
      expect(result.out).toContain('Win32_Process');
    });

    /** Exit 1 means nothing matched, so a shell can ask without parsing text. */
    it('exits 1 when the filter matched nothing', async () => {
      const result = await run(['ls', 'a-string-no-process-can-match']);
      expect(result.code).toBe(1);
    });
  });

  describe('--json', () => {
    it('emits a parseable snapshot with the fields a script would want', async () => {
      const result = await run(['ls', '--json', '--all']);
      const parsed = JSON.parse(result.out);

      expect(parsed.platform).toBe('win32');
      expect(parsed.capturedAt).toBe('2026-08-20T12:00:00.000Z');
      expect(parsed.processes).toHaveLength(3);

      const [first] = parsed.processes;
      expect(first.pid).toBe(9120);
      expect(first.role).toBe('dev-server');
      expect(first.ports[0].port).toBe(4310);
    });

    /**
     * The provenance survives the serialisation. A consumer that could not tell
     * an inferred directory from a read one would be exactly the confident
     * wrongness the whole design avoids.
     */
    it('keeps the provenance of every uncertain field', async () => {
      const result = await run(['ls', '--json', '--all']);
      const parsed = JSON.parse(result.out);
      const byPid = Object.fromEntries(parsed.processes.map((p: { pid: number }) => [p.pid, p]));

      expect(byPid[9120].cwd.source).toBe('exact');
      expect(byPid[9121].cwd.source).toBe('inferred');
      expect(byPid[9121].cwd.note).toBeTruthy();
      expect(byPid[5684].commandLine.value).toBeNull();
      expect(byPid[5684].commandLine.note).toContain('withheld');
    });

    it('never colours JSON, whatever the terminal says', async () => {
      const result = await run(['ls', '--json']);
      expect(result.out).not.toContain('\u001B[');
    });
  });

  describe('port', () => {
    it('shows what holds the port, in full', async () => {
      const result = await run(['port', '4310']);
      expect(result.code).toBe(0);
      expect(result.out).toContain('9120');
      expect(result.out).toContain('shop-web');
    });

    it('exits 1 and says so when nothing holds it', async () => {
      const result = await run(['port', '65535']);
      expect(result.code).toBe(1);
      expect(result.out).toContain('nothing holds port 65535');
    });

    it('refuses a port that is not a number', async () => {
      const result = await run(['port', 'four-thousand']);
      expect(result.code).toBe(2);
    });

    it('needs a port at all', async () => {
      const result = await run(['port']);
      expect(result.code).toBe(2);
      expect(result.err).toContain('needs a port number');
    });
  });

  describe('kill', () => {
    /**
     * The confirmation is the safety. Every path that skips it has to be one
     * the person asked for, in words, on that invocation.
     */
    it('shows what it resolved and asks before it does anything', async () => {
      const send = vi.fn();
      const confirm = vi.fn(async (_question: string) => false);
      const result = await run(['kill', '--port', '4310'], { send, confirm });

      expect(confirm).toHaveBeenCalledOnce();
      expect(String(confirm.mock.calls[0]?.[0])).toContain('9120');
      expect(send).not.toHaveBeenCalled();
      expect(result.code).toBe(0);
      expect(result.err).toContain('nothing was killed');
    });

    it('sends the signal once the question is answered yes', async () => {
      const send = vi.fn();
      const result = await run(['kill', '--port', '4310'], { send, confirm: async () => true });

      expect(send).toHaveBeenCalledWith(9120, 'SIGTERM');
      expect(result.code).toBe(0);
      expect(result.out).toContain('signalled 9120');
    });

    it('takes the signal it was given', async () => {
      const send = vi.fn();
      await run(['kill', '--pid', '9120', '--signal', 'kill'], { send, confirm: async () => true });
      expect(send).toHaveBeenCalledWith(9120, 'SIGKILL');
    });

    it('skips the question only when --yes was passed', async () => {
      const send = vi.fn();
      const confirm = vi.fn(async () => true);
      await run(['kill', '--pid', '9120', '--yes'], { send, confirm });

      expect(confirm).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(9120, 'SIGTERM');
    });

    it('exits 1 and sends nothing when the target does not exist', async () => {
      const send = vi.fn();
      const result = await run(['kill', '--port', '65535'], { send, confirm: async () => true });

      expect(send).not.toHaveBeenCalled();
      expect(result.code).toBe(1);
      expect(result.err).toContain('nothing to kill');
    });

    it('needs to be told what to kill', async () => {
      const result = await run(['kill']);
      expect(result.code).toBe(2);
      expect(result.err).toContain('--port');
    });

    it('reports a refused signal rather than claim it worked', async () => {
      const send = vi.fn(() => {
        const error = new Error('nope') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      });
      const result = await run(['kill', '--pid', '9120', '--yes'], { send });

      expect(result.code).toBe(1);
      expect(result.err).toContain('permission denied');
    });

    /**
     * Windows maps every signal to TerminateProcess, so SIGTERM there is as
     * abrupt as SIGKILL. Implying a graceful shutdown that will not happen is
     * the same class of mistake as an inferred value presented as read.
     */
    it('warns on Windows that there is no such thing as a gentle signal', async () => {
      const send = vi.fn();
      const result = await run(['kill', '--pid', '9120', '--yes'], { send });
      if (process.platform === 'win32') {
        expect(result.err).toContain('TerminateProcess');
      }
    });
  });

  describe('the interactive screen', () => {
    it('is what a bare invocation asks for', async () => {
      const runTui = vi.fn(async () => undefined);
      const isTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      try {
        const result = await run([], { runTui });
        expect(runTui).toHaveBeenCalledOnce();
        expect(result.code).toBe(0);
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
      }
    });

    /**
     * `whotop | grep vite` has no arguments and no terminal. Opening a screen
     * there, or refusing to run, would break every pipe that already exists.
     */
    it('steps aside for a pipe and prints the listing instead', async () => {
      const runTui = vi.fn(async () => undefined);
      const isTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      try {
        const result = await run([], { runTui });
        expect(runTui).not.toHaveBeenCalled();
        expect(result.code).toBe(0);
        expect(result.out).toContain('dev-server');
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
      }
    });

    /** Asking for it by name in a pipe is a different thing, and still says no. */
    it('still refuses when the screen was asked for by name', async () => {
      const runTui = vi.fn(async () => {
        throw new Error('the interactive screen needs a terminal');
      });
      const result = await run(['top'], { runTui });
      expect(result.code).toBe(3);
      expect(result.err).toContain('needs a terminal');
    });
  });

  describe('when the machine cannot be read at all', () => {
    it('exits 3 and says why', async () => {
      const result = await run(['ls'], {}, new Error('neither powershell.exe nor pwsh.exe could be started'));
      expect(result.code).toBe(3);
      expect(result.err).toContain('could not read the process table');
      expect(result.err).toContain('powershell.exe');
    });
  });
});
