import { describe, expect, it } from 'vitest';
import {
  anchorSelection,
  clampVisible,
  columnText,
  nextColumnMode,
  MIN_LIST_ROWS,
  PANE_HEIGHT,
  paneHeightFor,
  renderRow,
  indexOfPid,
  initialState,
  matchesSearch,
  moveSelection,
  splitKeys,
  visibleRows,
  windowOffset,
  withVersion,
} from '../src/tui.js';
import { exact } from '../src/types.js';
import { createPalette } from '../src/color.js';
import type { ProcessView, Snapshot } from '../src/types.js';

const view = (over: Partial<ProcessView> = {}): ProcessView => ({
  pid: 9120,
  ppid: 6104,
  name: 'node.exe',
  exePath: null,
  commandLine: exact('node vite.js dev --port 4310'),
  cwd: exact('C:\\Users\\dev\\projects\\shop-web'),
  startedAt: null,
  user: null,
  services: [],
  classification: {
    role: 'dev-server',
    confidence: 0.78,
    reason: 'vite',
    matches: [],
    label: 'vite',
  },
  ports: [],
  orphan: exact(false),
  ageMs: 3 * 3_600_000,
  project: exact('shop-web'),
  ...over,
});

const snapshot = (processes: ProcessView[]): Snapshot => ({
  platform: 'win32',
  capturedAt: new Date('2026-08-19T16:00:00.000Z'),
  capabilities: { commandLine: 'partial', cwd: 'none', ports: 'full', user: 'none', notes: [] },
  processes,
  warnings: [],
});

describe('anchorSelection', () => {
  /**
   * The rule the whole screen rests on. A refresh reorders rows whenever a
   * process exits, and a cursor that remembered "row 1" would come to rest on
   * a different process than the one the reader was looking at. Killing that
   * one is the mistake whotop exists to prevent.
   */
  it('follows the pid when the list reorders under it', () => {
    const before = [view({ pid: 100 }), view({ pid: 200 }), view({ pid: 300 })];
    const after = [view({ pid: 300 }), view({ pid: 100 }), view({ pid: 200 })];
    const index = indexOfPid(before, 200);
    expect(anchorSelection(after, 200, index)).toBe(200);
  });

  it('holds the position rather than jumping to the top when the pid is gone', () => {
    const after = [view({ pid: 100 }), view({ pid: 300 }), view({ pid: 400 })];
    expect(anchorSelection(after, 200, 1)).toBe(300);
  });

  it('clamps to the last row when the list shrank past the old position', () => {
    expect(anchorSelection([view({ pid: 100 })], 999, 7)).toBe(100);
  });

  it('selects nothing when nothing is left', () => {
    expect(anchorSelection([], 100, 0)).toBeNull();
  });
});

describe('moveSelection', () => {
  const rows = [view({ pid: 1 }), view({ pid: 2 }), view({ pid: 3 })];

  it('moves by one and stops at both ends', () => {
    expect(moveSelection(rows, 1, 1)).toBe(2);
    expect(moveSelection(rows, 1, -1)).toBe(1);
    expect(moveSelection(rows, 3, 1)).toBe(3);
  });

  it('clamps a page jump instead of falling off the list', () => {
    expect(moveSelection(rows, 1, 50)).toBe(3);
    expect(moveSelection(rows, 3, -50)).toBe(1);
  });
});

describe('windowOffset', () => {
  it('does not scroll while the cursor is already on screen', () => {
    expect(windowOffset(3, 10, 0, 40)).toBe(0);
  });

  it('scrolls by the smallest amount that brings the cursor back', () => {
    expect(windowOffset(12, 10, 0, 40)).toBe(3);
    expect(windowOffset(2, 10, 5, 40)).toBe(2);
  });

  it('never leaves a gap below the last row', () => {
    expect(windowOffset(39, 10, 35, 40)).toBe(30);
  });
});

describe('matchesSearch', () => {
  it('finds a process by the service name, which is sometimes all it discloses', () => {
    const row = view({ services: ['WireGuardTunnel$Poland-2'] });
    expect(matchesSearch(row, 'wireguard')).toBe(true);
  });

  it('finds a process by pid, port, project and command line', () => {
    const row = view({ pid: 4321, ports: [{ protocol: 'tcp', address: '::', port: 5173, state: 'listen', pid: 4321 }] });
    expect(matchesSearch(row, '4321')).toBe(true);
    expect(matchesSearch(row, '5173')).toBe(true);
    expect(matchesSearch(row, 'shop-web')).toBe(true);
    expect(matchesSearch(row, 'vite.js')).toBe(true);
  });

  it('does not match what is not there', () => {
    expect(matchesSearch(view(), 'postgres')).toBe(false);
  });
});

describe('visibleRows', () => {
  it('narrows to the search and keeps the rest reachable through show all', () => {
    const snap = snapshot([
      view({ pid: 1, services: ['Dnscache'], classification: { ...view().classification, role: 'unknown', label: null } }),
      view({ pid: 2 }),
    ]);
    const state = initialState(true, 'pid');
    expect(visibleRows(snap, state).map((r) => r.pid)).toEqual([1, 2]);
    expect(visibleRows(snap, { ...state, search: 'dnscache' }).map((r) => r.pid)).toEqual([1]);
  });
});

describe('splitKeys', () => {
  it('keeps an arrow together instead of reading it as three keys', () => {
    expect(splitKeys('\x1b[A')).toEqual(['\x1b[A']);
    expect(splitKeys('\x1b[6~')).toEqual(['\x1b[6~']);
  });

  it('splits a burst of plain keys, and a mix of both', () => {
    expect(splitKeys('abc')).toEqual(['a', 'b', 'c']);
    expect(splitKeys('j\x1b[Bk')).toEqual(['j', '\x1b[B', 'k']);
  });

  it('passes a lone escape through, which is how search is cleared', () => {
    expect(splitKeys('\x1b')).toEqual(['\x1b']);
  });
});

describe('columnText', () => {
  it('shows what a process is, with its services and project beside it', () => {
    const row = view({ services: ['Dnscache'] });
    const text = columnText(row, 'what');
    expect(text).toContain('vite');
    expect(text).toContain('Dnscache');
    expect(text).toContain('shop-web');
  });

  /**
   * A directory guessed from a command line is a weaker claim than one the
   * kernel handed over, and the list has to say so without a whole column of
   * prose. A trailing mark is enough, and the pane carries the reason.
   */
  it('marks a working directory that was only inferred', () => {
    const kernel = columnText(view(), 'where');
    expect(kernel.endsWith('~')).toBe(false);
    const guessed = columnText(
      view({ cwd: { value: 'C:\\projects\\api', source: 'inferred', note: 'from the command line' } }),
      'where',
    );
    expect(guessed.endsWith('~')).toBe(true);
  });

  it('falls back to a mark rather than an empty cell', () => {
    const row = view({ cwd: { value: null, source: 'unavailable', note: 'refused' } });
    expect(columnText(row, 'where')).toBe('·');
  });

  it('cycles the modes and comes back round', () => {
    expect(nextColumnMode('what')).toBe('where');
    expect(nextColumnMode('where')).toBe('command');
    expect(nextColumnMode('command')).toBe('what');
  });
});

describe('renderRow', () => {
  const plain = createPalette(false);

  it('never draws wider than it was given, so nothing wraps and shifts the screen', () => {
    const long = view({ commandLine: exact('node ' + 'x'.repeat(400)) });
    for (const mode of ['what', 'where', 'command'] as const) {
      expect(renderRow(long, 100, false, plain, mode).length).toBeLessThanOrEqual(100);
      expect(renderRow(long, 100, true, plain, mode).length).toBeLessThanOrEqual(100);
    }
  });

  /** A long path is recognisable from its tail, not its head. */
  it('keeps the end of a path rather than the start', () => {
    const deep = view({ cwd: exact('C:\\Users\\dev\\a\\b\\c\\d\\e\\f\\g\\shop-web') });
    expect(renderRow(deep, 70, false, plain, 'where')).toContain('shop-web');
  });
});

describe('PANE_HEIGHT', () => {
  it('is a constant, because a pane that resizes with its contents moves the list under the cursor', () => {
    expect(PANE_HEIGHT).toBeGreaterThan(2);
    expect(Number.isInteger(PANE_HEIGHT)).toBe(true);
  });
});

describe('paneHeightFor', () => {
  it('gives the pane its full height when the terminal can afford it', () => {
    expect(paneHeightFor(24)).toBe(PANE_HEIGHT);
    expect(paneHeightFor(60)).toBe(PANE_HEIGHT);
  });

  /**
   * The frame is cut to the terminal height at the very end, so a pane bigger
   * than the screen does not overflow, it takes the footer and the bottom of
   * the list with it. Everything has to be given away before that point.
   */
  it('always leaves a header, a footer and a list to put the cursor on', () => {
    for (let termRows = 5; termRows <= 60; termRows += 1) {
      const pane = paneHeightFor(termRows);
      const list = Math.max(MIN_LIST_ROWS, termRows - 2 - pane);
      expect(1 + list + pane + 1).toBeLessThanOrEqual(Math.max(termRows, 1 + MIN_LIST_ROWS + 1));
      expect(list).toBeGreaterThanOrEqual(MIN_LIST_ROWS);
    }
  });

  it('drops the pane rather than leave a stub of it on a small screen', () => {
    expect(paneHeightFor(7)).toBe(0);
    expect(paneHeightFor(8)).toBe(3);
  });

  /** A pane never grows past the height it asked for, however tall the terminal. */
  it('never exceeds PANE_HEIGHT', () => {
    expect(paneHeightFor(500)).toBe(PANE_HEIGHT);
  });
});

describe('clampVisible', () => {
  /**
   * The one place every line is trimmed. Rows were clamped by their builder
   * but the pane, header and footer were not, so a long command line produced
   * a pane line wider than the terminal, the terminal wrapped it, and the
   * frame grew taller than the screen. Everything above scrolled away, which
   * read as the cursor starting mid screen and the pane jumping.
   */
  it('cuts a plain line to the width it was given', () => {
    expect(clampVisible('x'.repeat(200), 40)).toHaveLength(40);
    expect(clampVisible('short', 40)).toBe('short');
  });

  it('counts what is visible, not the bytes of the escape sequences', () => {
    const coloured = '\x1b[31m' + 'x'.repeat(50) + '\x1b[0m';
    const cut = clampVisible(coloured, 10);
    expect(cut.replace(/\x1b\[[0-9;]*m/g, '')).toHaveLength(10);
  });

  it('closes the colour it opened, so nothing bleeds into the next line', () => {
    expect(clampVisible('\x1b[7m' + 'x'.repeat(50), 5).endsWith('\x1b[0m')).toBe(true);
  });

  it('never severs an escape sequence and leaks its bytes onto the screen', () => {
    const cut = clampVisible('\x1b[31mabc\x1b[0mdef', 4);
    expect(cut).not.toMatch(/\x1b\[[0-9;]*$/);
  });

  it('returns nothing for a width of zero rather than throwing', () => {
    expect(clampVisible('anything', 0)).toBe('');
  });
});

describe('clampVisible and control characters', () => {
  /**
   * A tab measures as one character and draws as up to eight columns, so a
   * command line containing one slipped past every width calculation, wrapped,
   * and grew the frame past the screen. A newline was worse: it turned one row
   * into two. Both are replaced so that one character is one column, which is
   * what the rest of the layout assumes.
   */
  it('turns a tab into a single column instead of eight', () => {
    const cut = clampVisible('a\tb', 10);
    expect(cut).toBe('a b');
    expect(cut).not.toContain('\t');
  });

  it('never lets a newline through, which would make one row into two', () => {
    expect(clampVisible('a\nb\r\nc', 20)).not.toMatch(/[\r\n]/);
  });

  it('still counts a replaced control character towards the width', () => {
    expect(clampVisible('\t'.repeat(50), 12)).toHaveLength(12);
  });
});

describe('withVersion', () => {
  const plain = createPalette(false);

  it('puts the stamp at the right edge', () => {
    const line = withVersion('keys', '0.1.0', 40, plain);
    expect(line.trimEnd().endsWith('v0.1.0')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(40);
  });

  it('drops the stamp rather than pushing the keys off a narrow screen', () => {
    expect(withVersion('a'.repeat(38), '0.1.0', 40, plain)).toBe('a'.repeat(38));
  });

  it('leaves the footer alone when there is no version to show', () => {
    expect(withVersion('keys', null, 40, plain)).toBe('keys');
  });
});
