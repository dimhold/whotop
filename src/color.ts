/**
 * Tiny ANSI helper. whotop ships with zero runtime dependencies, so that
 * `npx whotop` is one download and no supply chain to audit.
 */

const ESC = '\u001B';

const CODES = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  italic: `${ESC}[3m`,
  underline: `${ESC}[4m`,
  // Reverse video. The interactive screen marks the selected row with it
  // rather than a colour, so the cursor stays visible on any theme.
  inverse: `${ESC}[7m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
  brightRed: `${ESC}[91m`,
  brightGreen: `${ESC}[92m`,
  brightYellow: `${ESC}[93m`,
  brightBlue: `${ESC}[94m`,
  brightMagenta: `${ESC}[95m`,
  brightCyan: `${ESC}[96m`,
  white: `${ESC}[97m`,
} as const;

export type ColorName = Exclude<keyof typeof CODES, 'reset'>;

export interface Palette {
  (name: ColorName, text: string): string;
  readonly enabled: boolean;
}

/**
 * Honours NO_COLOR (https://no-color.org), then FORCE_COLOR, then TTY
 * detection, in that order.
 */
export function detectColorSupport(
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0';
  if (env.TERM === 'dumb') return false;
  return isTty;
}

export function createPalette(enabled: boolean): Palette {
  const paint = (name: ColorName, text: string): string =>
    enabled ? `${CODES[name]}${text}${CODES.reset}` : text;
  return Object.defineProperty(paint, 'enabled', { value: enabled, enumerable: true }) as Palette;
}

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Visible length, ignoring ANSI escapes, so columns line up when colour is on. */
export function visibleLength(text: string): number {
  return text.replace(ANSI_RE, '').length;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function padEndVisible(text: string, width: number): string {
  const pad = width - visibleLength(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

export function padStartVisible(text: string, width: number): string {
  const pad = width - visibleLength(text);
  return pad > 0 ? ' '.repeat(pad) + text : text;
}

/**
 * Whether the terminal can be trusted with glyphs outside the legacy code
 * pages. Braille and block elements are what the splash spinner and wordmark
 * are drawn with, and the old Windows console draws both as boxes.
 *
 * The check is by terminal rather than by platform because the platform is not
 * the thing that decides: Windows Terminal, VS Code and the JetBrains console
 * all render them, and each announces itself in the environment. Anything on
 * Windows that announces nothing is assumed to be conhost, which does not.
 */
export function supportsUnicode(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  if (platform !== 'win32') {
    // The bare Linux virtual console is the one Unix terminal that cannot.
    return env.TERM !== 'linux' && env.TERM !== 'dumb';
  }
  return Boolean(
    env.WT_SESSION ||
      env.TERM_PROGRAM ||
      env.ConEmuTask ||
      env.WSLENV ||
      env.TERMINAL_EMULATOR ||
      env.TERM === 'xterm-256color',
  );
}
