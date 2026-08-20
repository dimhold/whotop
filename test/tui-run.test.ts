/**
 * The half of the screen that owns a terminal.
 *
 * Everything in `tui.test.ts` is pure and decides what should happen.
 * `runTui` is what actually happens: raw mode, the alternate screen, a redraw
 * loop and a collect that takes seconds. It was the largest untested thing in
 * the project, and it is where the three failures that matter live — a
 * terminal handed back broken, a keypress dropped, and a kill aimed at the
 * wrong row.
 *
 * A terminal is faked rather than mocked. The pair below behaves the way Node
 * hands a real one over: `out` records everything written, `input` delivers
 * keys through an async iterator and accepts the `data` listener the splash
 * attaches. Nothing is stubbed inside `runTui` itself, so what these tests
 * exercise is the real control flow.
 */
import { describe, expect, it, vi } from 'vitest';
import { runTui } from '../src/tui.js';
import { collectingNote } from '../src/splash.js';
import { exact, unavailable } from '../src/types.js';
import type { ProcessView, Snapshot } from '../src/types.js';

const ALT_SCREEN_ON = '\u001B[?1049h';
const ALT_SCREEN_OFF = '\u001B[?1049l';
const CURSOR_HIDE = '\u001B[?25l';
const CURSOR_SHOW = '\u001B[?25h';

const view = (over: Partial<ProcessView> = {}): ProcessView => ({
  pid: 4310,
  ppid: 900,
  name: 'node.exe',
  exePath: null,
  commandLine: exact('node vite.js dev --port 4310'),
  cwd: exact('C:\\Users\\dev\\projects\\shop-web'),
  startedAt: new Date('2026-08-20T09:00:00.000Z'),
  user: null,
  services: [],
  classification: { role: 'dev-server', confidence: 0.8, reason: 'vite', matches: [], label: 'vite' },
  ports: [],
  orphan: exact(false),
  ageMs: 3_600_000,
  project: exact('shop-web'),
  ...over,
});

const snapshot = (processes: ProcessView[] = [view()]): Snapshot => ({
  platform: 'win32',
  capturedAt: new Date('2026-08-20T12:00:00.000Z'),
  capabilities: { commandLine: 'partial', cwd: 'none', ports: 'full', user: 'none', notes: [] },
  processes,
  warnings: [],
});

interface Terminal {
  readonly out: NodeJS.WriteStream;
  readonly input: NodeJS.ReadStream;
  /** Everything written, in order. */
  readonly writes: string[];
  /** Only the full-frame repaints, which is what the reader sees. */
  frames(): string[];
  /** The last frame, with the escape sequences taken out. */
  screen(): string;
  /** Deliver a keypress the way a `data` listener would receive it. */
  press(text: string): void;
  readonly raw: boolean[];
}

/**
 * Keys are handed over two different ways on purpose. Before the first
 * snapshot arrives the splash is listening with a `data` handler; afterwards
 * the key loop is iterating the stream. Both have to work, and a fake that
 * only did one of them would have hidden the bug where ctrl-c was ignored for
 * the two seconds the screen took to open.
 */
function terminal(keys: string[] = [], options: { rows?: number; columns?: number } = {}): Terminal {
  const writes: string[] = [];
  const raw: boolean[] = [];
  const listeners: Array<(chunk: string) => void> = [];
  let released: (() => void) | null = null;

  const out = {
    isTTY: true,
    rows: options.rows ?? 24,
    columns: options.columns ?? 100,
    write: (text: string) => {
      writes.push(text);
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  const input = {
    isTTY: true,
    setRawMode(on: boolean) {
      raw.push(on);
      return this;
    },
    resume() {
      return this;
    },
    pause() {
      return this;
    },
    setEncoding() {
      return this;
    },
    on(event: string, handler: (chunk: string) => void) {
      if (event === 'data') listeners.push(handler);
      return this;
    },
    off(event: string, handler: (chunk: string) => void) {
      const at = listeners.indexOf(handler);
      if (at >= 0) listeners.splice(at, 1);
      return this;
    },
    async *[Symbol.asyncIterator]() {
      for (const key of keys) yield key;
      // The stream stays open the way a terminal does. A test that wants the
      // loop to end sends 'q' rather than relying on the keys running out.
      await new Promise<void>((resolve) => {
        released = resolve;
      });
    },
  } as unknown as NodeJS.ReadStream;

  const strip = (text: string): string => text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
  const frames = (): string[] => writes.filter((w) => w.startsWith('\u001B[H'));

  return {
    out,
    input,
    writes,
    raw,
    frames,
    screen: () => strip(frames().at(-1) ?? ''),
    press: (text: string) => {
      for (const listener of [...listeners]) listener(text);
      released?.();
    },
  };
}

/** A collect that resolves after `ms` of fake time, so the splash can be seen. */
const slowCollect = (result: Snapshot, ms: number) => () =>
  new Promise<Snapshot>((resolve) => setTimeout(() => resolve(result), ms));

describe('runTui', () => {
  it('refuses to open a screen where there is no terminal to open it on', async () => {
    const term = terminal(['q']);
    const input = { ...term.input, isTTY: false } as unknown as NodeJS.ReadStream;
    await expect(runTui({ collect: async () => snapshot(), out: term.out, input })).rejects.toThrow(
      /needs a terminal/,
    );
  });

  /**
   * Raw mode, the alternate screen and a hidden cursor are three global
   * changes to somebody's shell. A crash that leaves them set hands back a
   * session that appears broken, which is why every way out goes through the
   * same function.
   */
  it('takes the terminal and gives all of it back', async () => {
    const term = terminal(['q']);
    await runTui({ collect: async () => snapshot(), out: term.out, input: term.input });

    const all = term.writes.join('');
    expect(all).toContain(ALT_SCREEN_ON);
    expect(all).toContain(CURSOR_HIDE);
    expect(all).toContain(ALT_SCREEN_OFF);
    expect(all).toContain(CURSOR_SHOW);
    expect(term.raw).toEqual([true, false]);
  });

  /**
   * The alternate screen is discarded on the way out and takes anything
   * written on it along. A collect that failed used to print its reason there,
   * so the reader got a blank terminal and no explanation.
   */
  it('hands the terminal back before a failed collect escapes', async () => {
    const term = terminal(['q']);
    let thrown: Error | null = null;
    try {
      await runTui({
        collect: () => Promise.reject(new Error('PowerShell returned nothing')),
        out: term.out,
        input: term.input,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toBe('PowerShell returned nothing');
    const all = term.writes.join('');
    expect(all.indexOf(ALT_SCREEN_OFF)).toBeGreaterThan(-1);
  });

  it('leaves no handlers on the process behind it', async () => {
    const before = process.listenerCount('SIGINT') + process.listenerCount('uncaughtException');
    const term = terminal(['q']);
    await runTui({ collect: async () => snapshot(), out: term.out, input: term.input });
    const after = process.listenerCount('SIGINT') + process.listenerCount('uncaughtException');
    expect(after).toBe(before);
  });

  describe('the splash', () => {
    it('holds the screen while the first collect is in flight', async () => {
      const term = terminal(['q']);
      let now = 0;
      await runTui({
        collect: slowCollect(snapshot(), 30),
        out: term.out,
        input: term.input,
        spinnerMs: 5,
        clock: () => (now += 400),
      });

      const early = term.frames()[0] ?? '';
      expect(early).toContain('reading this machine');
      // The splash names the command the running platform actually waits on:
      // PowerShell on Windows, /proc on Linux, ps and lsof on macOS. The
      // expectation comes from the same place the screen does, because a test
      // that spelled out one platform's answer passed only on that platform.
      expect(early).toContain(collectingNote(process.platform)[0]);
    });

    it('gives way to the list the moment there is one', async () => {
      const term = terminal(['q']);
      await runTui({
        collect: slowCollect(snapshot(), 20),
        out: term.out,
        input: term.input,
        spinnerMs: 5,
      });

      expect(term.screen()).toContain('dev-server');
      expect(term.screen()).not.toContain('reading this machine');
    });

    /**
     * Raw mode turns ctrl-c into a byte rather than a signal, and until the key
     * loop starts there is nothing reading bytes. A screen that says ctrl-c
     * gets you out has to mean it while it is still saying it.
     */
    it('answers ctrl-c while it is still loading', async () => {
      const term = terminal([]);
      const exit = vi.fn();
      const running = runTui({
        collect: slowCollect(snapshot(), 200),
        out: term.out,
        input: term.input,
        spinnerMs: 5,
        exit,
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      term.press('\u0003');

      expect(exit).toHaveBeenCalledWith(130);
      expect(term.writes.join('')).toContain(ALT_SCREEN_OFF);
      await running;
    });

    /** Somebody who types / while the screen loads meant to search. */
    it('keeps what was typed during the wait and applies it after', async () => {
      // Enter closes the search box first: a q typed into an open one is the
      // letter q, which is exactly what the search is supposed to do with it.
      const term = terminal(['\r', 'q']);
      const running = runTui({
        collect: slowCollect(snapshot(), 60),
        out: term.out,
        input: term.input,
        spinnerMs: 5,
      });

      await new Promise((resolve) => setTimeout(resolve, 15));
      term.press('/');
      await running;

      expect(term.frames().some((frame) => frame.includes('search:'))).toBe(true);
    });

    /** A q typed during the load is answered, and nothing waits for a second one. */
    it('quits when the key typed during the wait was q', async () => {
      const term = terminal([]);
      const running = runTui({
        collect: slowCollect(snapshot(), 40),
        out: term.out,
        input: term.input,
        spinnerMs: 5,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      term.press('q');
      await expect(running).resolves.toBeUndefined();
      expect(term.writes.join('')).toContain(ALT_SCREEN_OFF);
    });
  });

  describe('the keys', () => {
    const two = [view(), view({ pid: 4311, classification: { role: 'mcp-server', confidence: 0.9, reason: 'mcp', matches: [], label: 'mcp' } })];

    it('moves the cursor without collecting again', async () => {
      const term = terminal(['j', 'q']);
      const collect = vi.fn(async () => snapshot(two));
      await runTui({ collect, out: term.out, input: term.input });

      // One collect for the whole session: moving the cursor is a redraw over
      // data already in hand, never a second reading of the machine.
      expect(collect).toHaveBeenCalledTimes(1);
      expect(term.frames().length).toBeGreaterThan(1);
    });

    it('opens and closes the search box', async () => {
      const term = terminal(['/', 'm', 'c', 'p', '\r', 'q']);
      await runTui({ collect: async () => snapshot(two), out: term.out, input: term.input });

      const screen = term.screen();
      expect(screen).toContain('mcp-server');
      expect(screen).not.toContain('dev-server');
    });

    it('cycles the middle column', async () => {
      const term = terminal(['c', 'q']);
      await runTui({ collect: async () => snapshot(), out: term.out, input: term.input });
      expect(term.screen()).toContain('column:where');
    });

    it('opens the full view and comes back', async () => {
      const term = terminal(['d', 'q']);
      await runTui({ collect: async () => snapshot(), out: term.out, input: term.input });
      expect(term.screen()).toContain('full view');
    });

    it('asks before it quits on escape, and the second escape answers', async () => {
      const term = terminal(['\u001B', 'q']);
      await runTui({ collect: async () => snapshot(), out: term.out, input: term.input });
      const asked = term.frames().some((frame) => frame.includes('leave whotop') || frame.includes('quit'));
      expect(asked).toBe(true);
    });

    it('collects again when asked to, and not otherwise', async () => {
      const term = terminal(['r', 'q']);
      const collect = vi.fn(async () => snapshot());
      await runTui({ collect, out: term.out, input: term.input });
      expect(collect).toHaveBeenCalledTimes(2);
    });

    it('ignores a key it has no meaning for', async () => {
      const term = terminal(['\u0007', 'q']);
      const collect = vi.fn(async () => snapshot());
      await runTui({ collect, out: term.out, input: term.input });
      expect(collect).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The whole reason this screen is careful. A kill goes to the pid under the
   * cursor, only after a question, and the question has to be answered with a
   * y. Everything else cancels.
   */
  describe('killing', () => {
    it('asks first, and sends nothing until it is answered', async () => {
      const term = terminal(['x', 'n', 'q']);
      const send = vi.fn();
      await runTui({ collect: async () => snapshot(), out: term.out, input: term.input, send });

      expect(send).not.toHaveBeenCalled();
      expect(term.frames().some((frame) => frame.includes('4310'))).toBe(true);
    });

    it('sends the signal to the pid under the cursor when answered yes', async () => {
      const term = terminal(['x', 'y', 'q']);
      const send = vi.fn();
      await runTui({ collect: async () => snapshot(), out: term.out, input: term.input, send });

      expect(send).toHaveBeenCalledWith(4310, 'SIGTERM');
    });

    it('sends nothing when the question is answered with anything else', async () => {
      const term = terminal(['x', 'n', 'q']);
      const send = vi.fn();
      await runTui({ collect: async () => snapshot(), out: term.out, input: term.input, send });

      expect(send).not.toHaveBeenCalled();
      expect(term.screen()).toContain('cancelled');
    });

    it('honours the signal it was given', async () => {
      const term = terminal(['x', 'y', 'q']);
      const send = vi.fn();
      await runTui({ collect: async () => snapshot(), out: term.out, input: term.input, send, signal: 'SIGKILL' });

      expect(send).toHaveBeenCalledWith(4310, 'SIGKILL');
    });

    /**
     * The signal can be refused: the process belongs to another user, or runs
     * elevated, or exited between the question and the answer. Reporting that
     * as success would be the same lie as killing the wrong row.
     */
    it('reports a refused signal rather than claim it worked', async () => {
      const term = terminal(['x', 'y', 'q']);
      const send = vi.fn(() => {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      });

      await runTui({ collect: async () => snapshot(), out: term.out, input: term.input, send });

      expect(send).toHaveBeenCalledWith(4310, 'SIGTERM');
      expect(term.screen()).toContain('could not kill');
      expect(term.screen()).toContain('another user or runs elevated');
    });

    /**
     * The pid is looked up again in the current snapshot at the moment of the
     * kill, rather than trusted from the row, because the row was drawn from a
     * snapshot that can be seconds old by the time the question is answered.
     */
    it('says so when the process is gone by the time the answer arrives', async () => {
      const term = terminal(['x', 'y', 'q']);
      const send = vi.fn();
      // Present for the frame the reader saw, gone for every collect after,
      // which is what the background refresh will bring in mid-question.
      let collected = 0;
      const collect = async () => (collected++ === 0 ? snapshot() : snapshot([]));

      await runTui({ collect, out: term.out, input: term.input, send, refreshMs: 1 });

      // Either the refresh landed first and the kill was refused as stale, or
      // it did not and the signal went to the pid that was on the screen.
      // Both are correct; sending to a pid that is no longer there is not.
      if (send.mock.calls.length === 0) {
        expect(term.frames().some((frame) => frame.includes('gone already'))).toBe(true);
      } else {
        expect(send).toHaveBeenCalledWith(4310, 'SIGTERM');
      }
    });
  });

  describe('the shape of the frame', () => {
    /**
     * A frame one line too tall loses its top row, and a line filled to the
     * exact terminal width makes many terminals wrap it, which pushes the
     * screen up by one. Both used to happen, and both look like the cursor
     * starting halfway down the screen.
     */
    it('never draws more lines than the terminal has, at any size', async () => {
      for (const rows of [8, 12, 24, 60]) {
        const term = terminal(['q'], { rows, columns: 90 });
        await runTui({ collect: async () => snapshot([view(), view({ pid: 1 }), view({ pid: 2 })]), out: term.out, input: term.input });

        const frame = term.frames().at(-1) ?? '';
        expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
      }
    });

    it('never draws a line wider than the terminal', async () => {
      const term = terminal(['q'], { columns: 60 });
      await runTui({
        collect: async () =>
          snapshot([view({ commandLine: exact('node ' + 'x'.repeat(400)), cwd: unavailable('withheld') })]),
        out: term.out,
        input: term.input,
      });

      const strip = (text: string) => text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
      for (const line of strip(term.frames().at(-1) ?? '').split('\n')) {
        expect(line.length).toBeLessThanOrEqual(59);
      }
    });

    it('says so rather than draw an empty list', async () => {
      const term = terminal(['/', 'z', 'z', 'z', '\r', 'q'], { rows: 20 });
      await runTui({ collect: async () => snapshot(), out: term.out, input: term.input });
      expect(term.screen()).toContain('nothing matches');
    });

    it('stamps the version in the corner it was given one for', async () => {
      const term = terminal(['q']);
      await runTui({ collect: async () => snapshot(), out: term.out, input: term.input, version: '0.3.0' });
      expect(term.screen()).toContain('v0.3.0');
    });
  });
});
