/**
 * The screen that stands in for the list until the first snapshot arrives.
 *
 * The wait is real and it is not going away. One PowerShell round trip costs a
 * little over two seconds on a 300 process machine, and splitting it would
 * mean reading the process table and the socket table at two different
 * instants, which is the one thing this tool must not do. So the fix is not to
 * make the wait shorter, it is to make it legible: a blank alternate screen
 * for two seconds reads as a hang, and the reader's next move is ctrl-c.
 *
 * Three rules shape what goes on it.
 *
 * It says what is actually happening, naming the command that is running and
 * why it is one command. A spinner alone says "busy"; this screen says "busy
 * doing X", which is the same promise the rest of whotop makes under
 * `--explain`.
 *
 * It moves, and it counts. A frozen spinner is how you tell a hung process
 * from a slow one, and the elapsed seconds turn "this feels stuck" into a
 * number the reader can judge. Past a threshold the screen says so itself,
 * rather than leaving the reader to guess.
 *
 * It never changes height. Lines are reserved for the notes that appear late,
 * so the layout does not jump under someone who is reading it, the same trade
 * the detail pane makes.
 *
 * Everything here is pure and takes no terminal: it is handed an elapsed time
 * and a frame number and returns lines.
 */

import { padStartVisible, visibleLength } from './color.js';
import type { Palette } from './color.js';

/** Frames of the spinner, and how often they advance. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
/** The same spinner where braille would come out as boxes. */
export const SPINNER_FRAMES_ASCII = ['|', '/', '-', '\\'] as const;
/** 80ms is about the slowest that still reads as motion rather than as ticking. */
export const SPINNER_INTERVAL_MS = 80;

/** Past this the screen admits the wait is unusual. */
export const SLOW_AFTER_MS = 6_000;
/** Past this it says how to get out. */
export const VERY_SLOW_AFTER_MS = 15_000;

const WORDMARK = [
  '█   █ █   █ ▄▀▀▄ ▀█▀ ▄▀▀▄ █▀▀▄',
  '█ █ █ █▀▀▀█ █  █  █  █  █ █▄▄▀',
  '▀▄▀▄▀ █   █ ▀▄▄▀  ▀  ▀▄▄▀ █   ',
];

const TAGLINE = 'what is this process, and which port is it holding?';

const KEYS = '↑↓ move   / search   c column   x kill   d full   q quit';
const KEYS_ASCII = 'up/down move  / search  c column  x kill  d full  q quit';

export interface SplashOptions {
  readonly elapsedMs: number;
  /** Advances once per SPINNER_INTERVAL_MS. Wraps on its own. */
  readonly frame: number;
  readonly width: number;
  readonly height: number;
  readonly platform: string;
  readonly palette: Palette;
  /** False on terminals that would draw boxes instead of glyphs. */
  readonly unicode?: boolean;
  readonly version?: string | null;
}

export function spinnerFrame(frame: number, unicode: boolean): string {
  const frames = unicode ? SPINNER_FRAMES : SPINNER_FRAMES_ASCII;
  const index = ((frame % frames.length) + frames.length) % frames.length;
  return frames[index] as string;
}

/**
 * Fixed width on purpose. A counter that grows from `9.9s` to `10.1s` would
 * widen the line it sits on, and a centred line that widens shifts sideways
 * while somebody is reading it.
 */
export function formatElapsed(ms: number): string {
  return padStartVisible(`${Math.max(0, ms / 1000).toFixed(1)}s`, 6);
}

/**
 * What the machine is being asked, in the words of the thing actually running.
 * Each platform gets its own because the reason for the wait differs: on
 * Windows it is one process spawn and a WMI query, on Linux it is a walk of
 * /proc, and telling somebody the wrong one is worse than telling them nothing.
 */
export function collectingNote(platform: string): readonly string[] {
  if (platform === 'win32') {
    return [
      'asking PowerShell for the process table, the socket table',
      'and the service names in one round trip, so that no port',
      'can move between two of them',
    ];
  }
  if (platform === 'linux') {
    return ['reading /proc, one directory per process, then the socket tables'];
  }
  if (platform === 'darwin') {
    return ['reading the process table with ps, then the socket table with lsof'];
  }
  return ['reading the process table and the socket table'];
}

/** The line that appears only once the wait stops being ordinary. */
export function slowNote(elapsedMs: number, platform: string): string {
  if (elapsedMs >= VERY_SLOW_AFTER_MS) {
    return 'ctrl-c leaves this screen and hands the terminal back';
  }
  if (elapsedMs >= SLOW_AFTER_MS) {
    return platform === 'win32'
      ? 'longer than usual: a busy WMI service can hold the query up'
      : 'longer than usual, still waiting on the process table';
  }
  return '';
}

/**
 * Exactly `height` lines, centred as a block so the left edges of the wordmark
 * and the text below it stay in line with each other rather than each drifting
 * to its own centre.
 */
export function renderSplash(options: SplashOptions): string[] {
  const { width, height, palette } = options;
  const unicode = options.unicode ?? true;

  const spinner = spinnerFrame(options.frame, unicode);
  const elapsed = formatElapsed(options.elapsedMs);
  const note = collectingNote(options.platform);
  const late = slowNote(options.elapsedMs, options.platform);

  // Built plain first, so the block is measured by what is visible and not by
  // the escape sequences that colour it.
  const plain: string[] = [
    ...(unicode ? WORDMARK : ['whotop']),
    '',
    TAGLINE,
    '',
    `${spinner}  reading this machine ${elapsed}`,
    '',
    ...note,
    '',
    // Reserved whether or not there is anything to say yet.
    late,
    '',
    unicode ? KEYS : KEYS_ASCII,
  ];

  // Measured against every line the splash could ever hold, not against the
  // ones this frame happens to have. The late notes are the widest thing on
  // the screen, and sizing the block to the current frame slid it sideways at
  // the second one of them appeared.
  const widest = [
    ...plain,
    slowNote(SLOW_AFTER_MS, options.platform),
    slowNote(VERY_SLOW_AFTER_MS, options.platform),
  ];
  const blockWidth = Math.max(...widest.map(visibleLength));
  const left = ' '.repeat(Math.max(0, Math.floor((width - blockWidth) / 2)));
  // Above the middle rather than on it: a block centred exactly in a tall
  // terminal sits lower than the eye expects it to.
  const top = Math.max(0, Math.floor((height - plain.length) * 0.4));

  const painted = [
    ...(unicode ? WORDMARK : ['whotop']).map((line) => palette('cyan', line)),
    '',
    palette('gray', TAGLINE),
    '',
    `${palette('cyan', spinner)}  ${palette('bold', 'reading this machine')} ${palette('gray', elapsed)}`,
    '',
    ...note.map((line) => palette('gray', line)),
    '',
    late === '' ? '' : palette('yellow', late),
    '',
    palette('gray', unicode ? KEYS : KEYS_ASCII),
  ];

  const lines: string[] = [];
  for (let i = 0; i < top; i += 1) lines.push('');
  for (const line of painted) lines.push(line === '' ? '' : left + line);

  if (options.version) {
    // Bottom right, in the same corner and the same shape the footer stamps
    // it, so a screenshot of the splash says which build it is too.
    while (lines.length < height - 1) lines.push('');
    lines.push(padStartVisible(palette('gray', `v${options.version}`), width - 1));
  }
  while (lines.length < height) lines.push('');
  return lines.slice(0, height);
}
