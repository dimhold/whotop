/**
 * The interactive screen: scroll, search, kill.
 *
 * Split in two on purpose. Everything above `runTui` is pure and takes no
 * terminal, so the tests exercise the parts that decide what happens, the way
 * the collectors keep parsing apart from spawning. `runTui` is the thin part
 * that owns stdin, the alternate screen and the redraw loop.
 *
 * Two rules shape the whole file.
 *
 * The selection follows a pid, never a row number. A refresh reorders the list
 * whenever a process exits or a port moves, and a cursor anchored to row 7
 * would quietly come to rest on a different process than the one the person
 * was looking at. Killing that one is the exact mistake this tool was written
 * to prevent, so it must not be reintroduced by its own screen.
 *
 * The terminal is always restored. Raw mode, the alternate screen and a hidden
 * cursor are three global changes to somebody's shell, and a crash that leaves
 * them set hands back a session that appears broken.
 */

import type { ProcessView, Snapshot } from './types.js';
import { filterProcesses, sortProcesses } from './filter.js';
import type { SortKey } from './filter.js';
import { formatAge, formatPorts, renderDetail } from './render.js';
import { killProcesses, signalNote } from './kill.js';
import type { KillSignal } from './kill.js';
import { createPalette, padEndVisible, supportsUnicode, visibleLength } from './color.js';
import { renderSplash, SPINNER_INTERVAL_MS } from './splash.js';
import type { Palette } from './color.js';

export interface TuiState {
  /** Pid the cursor sits on. Null before the first snapshot arrives. */
  readonly selected: number | null;
  /** Index of the first visible row. */
  readonly offset: number;
  readonly search: string;
  readonly searching: boolean;
  readonly showAll: boolean;
  readonly sort: SortKey;
  /** Pid awaiting a yes or no, or null when no question is open. */
  readonly confirming: number | null;
  /** Transient line under the list: the result of the last action. */
  readonly message: string | null;
  readonly detail: boolean;
  /** Which middle column the list shows. */
  readonly columns: ColumnMode;
  /** True once escape has been pressed once and the quit question is open. */
  readonly quitting: boolean;
  /** Full screen detail, entered from the pane when it has more to show. */
  readonly expanded: boolean;
}

/**
 * What the wide middle column shows. One list cannot answer every question at
 * once: sometimes you are looking for a tool, sometimes for the directory it
 * runs in, sometimes for the exact command. Cycled with `c`.
 */
export type ColumnMode = 'what' | 'where' | 'command';

export const COLUMN_MODES: readonly ColumnMode[] = ['what', 'where', 'command'];

export const nextColumnMode = (mode: ColumnMode): ColumnMode =>
  COLUMN_MODES[(COLUMN_MODES.indexOf(mode) + 1) % COLUMN_MODES.length] as ColumnMode;

export const initialState = (showAll: boolean, sort: SortKey): TuiState => ({
  selected: null,
  offset: 0,
  search: '',
  searching: false,
  showAll,
  sort,
  confirming: null,
  message: null,
  // The pane under the list is on from the start: needing a keypress to see
  // what the cursor is on defeats the point of a cursor.
  detail: true,
  columns: 'what',
  quitting: false,
  expanded: false,
});

/**
 * Height of the pane, counting its rule. Fixed on purpose: a pane that grew
 * with the selected process pushed the list off the screen, and a layout that
 * moves under the cursor is worse than one that shows less.
 *
 * Twelve is the rule, ten lines of detail and the overflow marker. A typical
 * process has more to say than that — role, name, start, parent, orphan, cwd,
 * project, ports, the rule that named it, and the command line, which wraps —
 * so the number is chosen for how much of that a reader gets without pressing
 * d, not for how much the widest process needs.
 */
export const PANE_HEIGHT = 12;

/** Rows of list kept back from the pane, whatever the terminal costs. */
export const MIN_LIST_ROWS = 3;

/**
 * The pane the terminal can actually afford.
 *
 * Fixed height means fixed against its contents, not fixed against the
 * screen: a twelve line pane in a fifteen line terminal leaves no list to put
 * a cursor on, and the frame is cut to the terminal height at the end, so the
 * pane and the footer would be the parts that vanish. Under a pane of three
 * it is not worth a third of a small screen, and the list takes it all.
 */
export function paneHeightFor(termRows: number): number {
  const room = termRows - 2 - MIN_LIST_ROWS;
  return room < 3 ? 0 : Math.min(PANE_HEIGHT, room);
}

/**
 * Rows to draw, after the show-all toggle, the search box and the sort.
 *
 * Search deliberately looks at the same fields the `--filter` flag does plus
 * the service names, because on Windows a service name is often the only thing
 * a process discloses, and a search that could not find `WireGuardTunnel`
 * would be useless on exactly the rows that need finding.
 */
export function visibleRows(snapshot: Snapshot, state: TuiState): ProcessView[] {
  const base = filterProcesses(snapshot.processes, { all: state.showAll });
  const needle = state.search.trim().toLowerCase();
  const matched = needle === '' ? base : base.filter((view) => matchesSearch(view, needle));
  return sortProcesses(matched, state.sort);
}

/** True when any field a person would type shows the needle. */
export function matchesSearch(view: ProcessView, needle: string): boolean {
  if (needle === '') return true;
  const haystack = [
    String(view.pid),
    view.name,
    view.classification.label ?? '',
    view.classification.role,
    view.project.value ?? '',
    view.cwd.value ?? '',
    view.commandLine.value ?? '',
    ...view.services,
    ...view.ports.map((port) => String(port.port)),
  ];
  return haystack.some((field) => field.toLowerCase().includes(needle));
}

/**
 * Where the cursor lands once the list has changed under it.
 *
 * Keeps the pid when it is still there. When it is gone, holds the position in
 * the list instead of jumping to the top, so a process exiting three rows above
 * does not throw the cursor across the screen.
 */
export function anchorSelection(
  rows: readonly ProcessView[],
  previous: number | null,
  previousIndex: number,
): number | null {
  if (rows.length === 0) return null;
  if (previous !== null && rows.some((row) => row.pid === previous)) return previous;
  const index = Math.min(Math.max(previousIndex, 0), rows.length - 1);
  return rows[index]?.pid ?? null;
}

export const indexOfPid = (rows: readonly ProcessView[], pid: number | null): number =>
  pid === null ? 0 : Math.max(0, rows.findIndex((row) => row.pid === pid));

/** Move the cursor by `delta` rows and return the pid it lands on. */
export function moveSelection(rows: readonly ProcessView[], pid: number | null, delta: number): number | null {
  if (rows.length === 0) return null;
  const next = Math.min(Math.max(indexOfPid(rows, pid) + delta, 0), rows.length - 1);
  return rows[next]?.pid ?? null;
}

/**
 * Scroll offset that keeps the cursor on screen, moving as little as possible.
 * A viewport that recentres on every keypress makes the list feel like it is
 * sliding out from under the reader.
 */
export function windowOffset(index: number, height: number, offset: number, total: number): number {
  if (height <= 0 || total <= 0) return 0;
  const maxOffset = Math.max(0, total - height);
  let next = Math.min(offset, maxOffset);
  if (index < next) next = index;
  else if (index >= next + height) next = index - height + 1;
  return Math.min(Math.max(next, 0), maxOffset);
}

/**
 * The middle column, per mode. `where` and `command` fall back to what is
 * actually known rather than printing an empty cell, and say when the value is
 * only inferred, because a directory guessed from a command line is a weaker
 * claim than one the kernel handed over.
 */
export function columnText(view: ProcessView, mode: ColumnMode): string {
  switch (mode) {
    case 'where': {
      const cwd = view.cwd.value;
      if (!cwd) return view.cwd.note ? '·' : '';
      return view.cwd.source === 'inferred' ? `${cwd} ~` : cwd;
    }
    case 'command':
      return view.commandLine.value ?? '·';
    case 'what':
    default: {
      const label = view.classification.label ?? view.name;
      // Service names are the only identity many Windows rows have, so they
      // sit beside the label rather than out of sight in the pane.
      const services = view.services.length > 0 ? ` [${view.services.join(', ')}]` : '';
      const project = view.project.value ? `  ${view.project.value}` : '';
      return `${label}${services}${project}`;
    }
  }
}

/** One row of the list. Kept pure so the tests can read what a person sees. */
export function renderRow(
  view: ProcessView,
  width: number,
  selected: boolean,
  palette: Palette,
  mode: ColumnMode = 'what',
): string {
  const pid = String(view.pid).padStart(6);
  const role = padEndVisible(view.classification.role, 18);
  const ports = formatPorts(view.ports);
  const age = formatAge(view.ageMs).padStart(8);
  const right = `${ports.padStart(14)}${age}`;
  // Four spaces in the format, not three: one leading, three between columns.
  // Subtracting three made every row exactly one character too wide, which is
  // how the list came to wrap and drift up the screen.
  const room = Math.max(8, width - visibleLength(pid) - visibleLength(role) - visibleLength(right) - 4);
  // A long path is more useful from its tail than its head, so `where` and
  // `command` drop the front rather than the end.
  const text = columnText(view, mode);
  const trimmed = mode === 'what' ? truncateVisible(text, room) : truncateStart(text, room);
  // A marker in the first column, not only reverse video. Colour is off when
  // the output is not a terminal, off under NO_COLOR, and hard to see on some
  // themes, and a cursor you cannot find is the same as no cursor at all.
  const line = `${selected ? '›' : ' '}${pid} ${role} ${padEndVisible(trimmed, room)} ${right}`;
  return selected ? palette('inverse', padEndVisible(line, width)) : line;
}

/**
 * Cut a line to a visible width without breaking the escape sequences in it.
 *
 * Every line the screen writes goes through here, at the single place they are
 * all written, rather than being trimmed by whoever built them. Two bugs came
 * from trusting the builders: the rows were clamped but the pane, the header
 * and the footer were not, so a process with a long command line produced a
 * pane line wider than the terminal, the terminal wrapped it, and eight pane
 * lines became ten. Everything above scrolled off the top, which read as the
 * cursor starting somewhere in the middle and the pane jumping about.
 *
 * A naive slice cannot do this. Escape sequences take no visible width, so
 * cutting by string index either truncates far too early on a coloured line or
 * severs a sequence and leaks its bytes onto the screen.
 */
export function clampVisible(line: string, width: number): string {
  if (width <= 0) return '';
  let visible = 0;
  let coloured = false;
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const match = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
      if (match) {
        out += match[0];
        coloured = true;
        i += match[0].length;
        continue;
      }
    }
    if (visible >= width) break;
    const ch = line[i] as string;
    // A control character counts as one when measured and draws as something
    // else entirely: a tab can open eight columns, a newline ends the line and
    // makes one row into two. Either way the frame grows past the screen and
    // the top scrolls away. Replaced with a space so that one character is one
    // column, which is the assumption every width calculation here rests on.
    out += ch < ' ' || ch === '\x7f' ? ' ' : ch;
    visible += 1;
    i += 1;
  }
  return coloured ? `${out}\x1b[0m` : out;
}

/** Keep the tail. `…\projects\shop-web` reads better than `C:\Users\dev\pro…`. */
function truncateStart(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return text.slice(Math.max(0, text.length - width));
  return '…' + text.slice(text.length - (width - 1));
}

function truncateVisible(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return text.slice(0, Math.max(0, width));
  return text.slice(0, width - 1) + '…';
}

const COLUMN_LABEL: Record<ColumnMode, string> = {
  what: 'what',
  where: 'where',
  command: 'command',
};

/**
 * Right-align a quiet version stamp on the footer, when the line leaves room.
 * Useful in a bug report and invisible the rest of the time, which is why it
 * is dim and why it is dropped rather than allowed to push the keys off.
 */
export function withVersion(footer: string, version: string | null, width: number, palette: Palette): string {
  if (!version) return footer;
  const stamp = `v${version}`;
  const gap = width - visibleLength(footer) - stamp.length - 1;
  if (gap < 2) return footer;
  return footer + ' '.repeat(gap) + palette('dim', stamp);
}

export function renderFooter(state: TuiState, rows: number, palette: Palette): string {
  // Order matters: the question a keypress is waiting on always wins the line.
  if (state.quitting) {
    return palette('yellow', ' quit whotop?  esc or y to leave   any other key to stay ');
  }
  if (state.confirming !== null) {
    return palette('yellow', ` kill pid ${state.confirming}?  y confirm   n cancel `);
  }
  if (state.searching) {
    return palette('cyan', ` search: ${state.search}_   enter accept   esc clear `);
  }
  if (state.expanded) {
    return palette('gray', ' full view   d or esc back');
  }
  if (state.message) return palette('gray', ` ${state.message}`);
  return palette(
    'gray',
    ` ${rows} rows   ↑↓ move   / search   c column:${COLUMN_LABEL[state.columns]}   x kill   d full   a all   q quit`,
  );
}

/* ------------------------------------------------------------------ *
 * Everything below owns the terminal.
 * ------------------------------------------------------------------ */

export interface TuiDeps {
  readonly collect: () => Promise<Snapshot>;
  readonly out?: NodeJS.WriteStream;
  readonly input?: NodeJS.ReadStream;
  readonly send?: (pid: number, signal: KillSignal) => void;
  /** Milliseconds between background refreshes. */
  readonly refreshMs?: number;
  readonly signal?: KillSignal;
  /** Stamped small in the footer corner, so a screenshot says which build it is. */
  readonly version?: string;
  /** Milliseconds between splash frames. */
  readonly spinnerMs?: number;
  /** Injected so a test can drive the splash without waiting in real time. */
  readonly clock?: () => number;
}

const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
/** Erase to end of line, and to end of screen. */
const EOL = '\x1b[K';
const EOS = '\x1b[J';

export async function runTui(deps: TuiDeps): Promise<void> {
  const out = deps.out ?? process.stdout;
  const input = deps.input ?? process.stdin;
  const signal: KillSignal = deps.signal ?? 'SIGTERM';
  const palette = createPalette(Boolean(out.isTTY));
  const clock = deps.clock ?? Date.now;

  if (!input.isTTY) {
    throw new Error('the interactive screen needs a terminal; run whotop without a pipe, or use the plain listing');
  }

  const unicode = supportsUnicode();

  let state = initialState(false, 'role');
  let snapshot: Snapshot | null = null;
  let quit = false;
  let restored = false;
  /** True while a collect is in flight, which is a second or two of every four. */
  let refreshing = false;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      input.setRawMode(false);
    } catch {
      /* the terminal went away first */
    }
    input.pause();
    out.write(CURSOR_SHOW + ALT_SCREEN_OFF);
  };

  // Three ways out, all of them must hand the shell back intact.
  process.once('exit', restore);
  process.once('SIGINT', () => {
    restore();
    process.exit(130);
  });
  process.once('uncaughtException', (error) => {
    restore();
    console.error(error);
    process.exit(1);
  });

  const draw = (): void => {
    if (!snapshot) return;
    const termRows = out.rows ?? 24;
    // One column spare. A line filled to the exact terminal width makes many
    // terminals wrap it, and every wrapped line pushes the screen up by one,
    // which is why the list used to drift off the top.
    const width = Math.max(40, (out.columns ?? 100) - 1);

    const rows = visibleRows(snapshot, state);
    const index = indexOfPid(rows, state.selected);
    const lines: string[] = [];
    const captured = snapshot.capturedAt.toLocaleTimeString();
    // The marker is what keeps a refresh from reading as a freeze. A refresh
    // costs a couple of seconds, and pressing r and seeing nothing change for
    // that long is indistinguishable from a key that did nothing at all.
    const pending = refreshing ? palette('gray', unicode ? '  ↻' : '  ...') : '';
    lines.push(
      palette('bold', ` whotop  ${snapshot.platform}  ${rows.length} of ${snapshot.processes.length} processes  ${captured}`) + pending,
    );

    if (state.expanded && rows[index]) {
      // The whole screen, for the processes whose command line does not fit in
      // a pane. Reached from the marker the pane shows when it had to cut.
      const body = Math.max(3, termRows - 2);
      const full = renderDetail(rows[index], { width, palette, wide: true }).slice(0, body);
      lines.push(...full, ...Array.from({ length: body - full.length }, () => ''));
    } else {
      const paneLines = state.detail ? detailPane(width, palette, paneHeightFor(termRows)) : [];
      const listHeight = Math.max(MIN_LIST_ROWS, termRows - 2 - paneLines.length);
      state = { ...state, offset: windowOffset(index, listHeight, state.offset, rows.length) };

      const slice = rows.slice(state.offset, state.offset + listHeight);
      for (const [i, view] of slice.entries()) {
        lines.push(renderRow(view, width, state.offset + i === index, palette, state.columns));
      }
      for (let i = slice.length; i < listHeight; i += 1) lines.push('');
      if (slice.length === 0) lines[1] = palette('gray', '  nothing matches');
      lines.push(...paneLines);
    }

    lines.push(withVersion(renderFooter(state, rows.length, palette), deps.version ?? null, width, palette));

    // Home and overwrite rather than clear and redraw: a full clear makes the
    // screen blink on every keypress, and the point of this screen is that it
    // feels immediate.
    //
    // Clamped to the width and capped to the height right here, so that no
    // amount of arithmetic error anywhere above can make the screen scroll. A
    // frame that is one line too tall or one column too wide loses its top
    // row, and it is not obvious from the code which builder overflowed.
    const frame = lines.slice(0, termRows).map((line) => clampVisible(line, width) + EOL);
    out.write(HOME + frame.join('\n') + EOS);
  };

  /**
   * The pane under the list.
   *
   * Always exactly the height it is given, whatever the selected process has to
   * say. A pane sized to its contents grew when the cursor landed on a process
   * with a long command line, pushed the list off the screen and made the
   * layout jump about under the reader. Fixed height with an honest overflow
   * marker is the better trade: it shows less, and it never moves.
   *
   * Pure formatting over data already collected, so moving the cursor costs a
   * redraw and never a snapshot.
   */
  const detailPane = (width: number, pal: Palette, height: number): string[] => {
    if (height <= 0) return [];
    const rule = pal('gray', ' ' + '─'.repeat(Math.max(0, width - 2)));
    const body = Math.max(1, height - 1);
    const blank = (): string[] => Array.from({ length: body }, () => '');
    if (!snapshot) return [rule, ...blank()];

    const rows = visibleRows(snapshot, state);
    const view = rows[indexOfPid(rows, state.selected)];
    if (!view) return [rule, ...blank()];

    const full = renderDetail(view, { width, palette: pal, wide: false });
    if (full.length <= body) {
      return [rule, ...full, ...Array.from({ length: body - full.length }, () => '')];
    }
    // Keep the last line for the marker, so nothing is silently cut away.
    const shown = full.slice(0, body - 1);
    const hidden = full.length - shown.length;
    return [rule, ...shown, pal('cyan', `  … ${hidden} more lines, press d for the full view`)];
  };

  const refresh = async (): Promise<void> => {
    const previousIndex = snapshot ? indexOfPid(visibleRows(snapshot, state), state.selected) : 0;
    refreshing = true;
    // Drawn before the wait rather than after it, so that pressing r shows
    // the marker at once. Skipped on the first collect, which has the splash.
    if (snapshot) draw();
    try {
      snapshot = await deps.collect();
    } finally {
      refreshing = false;
    }
    const rows = visibleRows(snapshot, state);
    state = { ...state, selected: anchorSelection(rows, state.selected, previousIndex) };
    draw();
  };

  const doKill = async (pid: number): Promise<void> => {
    if (!snapshot) return;
    const target = snapshot.processes.find((view) => view.pid === pid);
    if (!target) {
      state = { ...state, message: `pid ${pid} is gone already`, confirming: null };
      draw();
      return;
    }
    const outcomes = await killProcesses([target], signal, deps.send ? { send: deps.send } : {});
    const outcome = outcomes[0];
    const note = signalNote(process.platform, signal);
    state = {
      ...state,
      confirming: null,
      message: outcome?.ok
        ? `sent ${signal} to pid ${pid}${note ? '. ' + note : ''}`
        : `could not kill pid ${pid}: ${outcome?.error ?? 'unknown reason'}`,
    };
    await refresh();
  };

  const onKey = async (key: string): Promise<void> => {
    if (!snapshot) return;
    const rows = visibleRows(snapshot, state);
    const height = Math.max(4, (out.rows ?? 24) - 4);

    /**
     * Escape asks before it leaves, and escape again answers. A single key
     * that quits is the wrong shape for a screen that can kill things: the
     * same finger reaching for it clears a search and closes the full view.
     */
    if (state.quitting) {
      if (key === '\x1b' || key === 'y' || key === 'Y' || key === 'q') {
        quit = true;
        return;
      }
      state = { ...state, quitting: false };
      draw();
      return;
    }

    if (state.confirming !== null) {
      if (key === 'y' || key === 'Y') await doKill(state.confirming);
      else state = { ...state, confirming: null, message: 'cancelled' };
      draw();
      return;
    }

    if (state.searching) {
      if (key === '\r' || key === '\n') state = { ...state, searching: false };
      else if (key === '\x1b') state = { ...state, searching: false, search: '' };
      else if (key === '\x7f' || key === '\b') state = { ...state, search: state.search.slice(0, -1) };
      else if (key >= ' ' && key <= '~') state = { ...state, search: state.search + key };
      const next = visibleRows(snapshot, state);
      state = { ...state, selected: anchorSelection(next, state.selected, 0), message: null };
      draw();
      return;
    }

    switch (key) {
      case 'q':
      case '\x03':
        quit = true;
        return;
      case '\x1b[A':
      case 'k':
        state = { ...state, selected: moveSelection(rows, state.selected, -1), message: null };
        break;
      case '\x1b[B':
      case 'j':
        state = { ...state, selected: moveSelection(rows, state.selected, 1), message: null };
        break;
      case '\x1b[5~':
        state = { ...state, selected: moveSelection(rows, state.selected, -height) };
        break;
      case '\x1b[6~':
        state = { ...state, selected: moveSelection(rows, state.selected, height) };
        break;
      case 'g':
      case '\x1b[H':
        state = { ...state, selected: rows[0]?.pid ?? null };
        break;
      case 'G':
      case '\x1b[F':
        state = { ...state, selected: rows[rows.length - 1]?.pid ?? null };
        break;
      case '/':
        state = { ...state, searching: true, search: '', message: null };
        break;
      case 'x':
      case '\x1b[20~': // F9, where htop keeps kill
        if (state.selected !== null) state = { ...state, confirming: state.selected };
        break;
      case 'd':
      case '\r':
        // From the list, d opens the full view the pane's marker points at.
        // From the full view, it goes back.
        state = { ...state, expanded: !state.expanded, message: null };
        break;
      case 'D':
        // Shift hides the pane outright, for anyone who wants more rows.
        state = { ...state, detail: !state.detail, expanded: false, message: null };
        break;
      case 'c':
        state = { ...state, columns: nextColumnMode(state.columns), message: null };
        break;
      case '\x1b':
        // Escape backs out of the full view first, and only asks about
        // leaving when there is nothing left to back out of.
        state = state.expanded
          ? { ...state, expanded: false }
          : state.search !== ''
            ? { ...state, search: '', message: null }
            : { ...state, quitting: true };
        break;
      case 'a':
        state = { ...state, showAll: !state.showAll, message: null };
        break;
      case 'r':
        await refresh();
        return;
      default:
        return;
    }
    draw();
  };

  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  out.write(ALT_SCREEN_ON + CURSOR_HIDE);

  /**
   * The first collect is the long one, and until it returns there is nothing
   * to draw a list from. An empty alternate screen for two seconds reads as a
   * hang, so the splash holds the screen, names the command it is waiting on
   * and counts the seconds. It stops the moment a snapshot exists.
   */
  const startedAt = clock();
  let frame = 0;
  const drawSplash = (): void => {
    if (snapshot) return;
    const width = Math.max(40, (out.columns ?? 100) - 1);
    const height = out.rows ?? 24;
    const lines = renderSplash({
      elapsedMs: clock() - startedAt,
      frame,
      width,
      height,
      platform: process.platform,
      palette,
      unicode,
      version: deps.version ?? null,
    });
    frame += 1;
    out.write(HOME + lines.map((line) => clampVisible(line, width) + EOL).join('\n') + EOS);
  };

  /**
   * Raw mode turns ctrl-c into a byte rather than a signal, and until the key
   * loop below starts there is nothing reading bytes. A splash that says ctrl-c
   * gets you out has to mean it, so it listens for that one key itself.
   *
   * Everything else typed during the wait is kept rather than dropped, and
   * handed to the key loop once there is a list to apply it to. Somebody who
   * types / while the screen loads meant to search.
   */
  const typedDuringLoad: string[] = [];
  const onSplashKey = (chunk: unknown): void => {
    const text = String(chunk);
    if (text.includes('\x03')) {
      restore();
      process.exit(130);
    }
    // Enough for a search word, not enough for a leaned-on key to grow
    // without bound while a slow machine thinks.
    if (typedDuringLoad.length < 64) typedDuringLoad.push(text);
  };
  input.on('data', onSplashKey);

  drawSplash();
  const splash = setInterval(drawSplash, deps.spinnerMs ?? SPINNER_INTERVAL_MS);
  splash.unref?.();
  try {
    await refresh();
  } catch (error) {
    // The alternate screen is thrown away on the way out, and with it any
    // message written while it was up. Hand the terminal back first, so the
    // reason the collect failed is still on the screen afterwards.
    restore();
    throw error;
  } finally {
    clearInterval(splash);
    input.off('data', onSplashKey);
  }

  for (const chunk of typedDuringLoad) {
    for (const key of splitKeys(chunk)) {
      await onKey(key);
      if (quit) break;
    }
    if (quit) break;
  }

  // A q typed during the load has already been answered above, and the key
  // loop below would sit waiting for a keypress that is never coming.
  if (quit) {
    restore();
    return;
  }

  // A refresh on Windows spawns PowerShell and takes a second or more, so it
  // runs on a timer rather than per keystroke, and keys stay answerable while
  // it is in flight.
  const timer = setInterval(() => {
    void refresh().catch(() => undefined);
  }, deps.refreshMs ?? 4000);
  timer.unref?.();

  try {
    for await (const chunk of input) {
      for (const key of splitKeys(String(chunk))) {
        await onKey(key);
        if (quit) break;
      }
      if (quit) break;
    }
  } finally {
    clearInterval(timer);
    restore();
  }
}

/**
 * One read can carry several keypresses, and an arrow arrives as three bytes.
 * Splitting here keeps `onKey` free of terminal trivia.
 */
export function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === '\x1b') {
      const rest = chunk.slice(i);
      const match = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(rest);
      if (match) {
        keys.push(match[0]);
        i += match[0].length;
        continue;
      }
    }
    keys.push(chunk[i] as string);
    i += 1;
  }
  return keys;
}
