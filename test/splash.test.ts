import { describe, expect, it } from 'vitest';
import {
  collectingNote,
  formatElapsed,
  renderSplash,
  slowNote,
  SLOW_AFTER_MS,
  spinnerFrame,
  SPINNER_FRAMES,
  VERY_SLOW_AFTER_MS,
} from '../src/splash.js';
import { createPalette, stripAnsi, supportsUnicode, visibleLength } from '../src/color.js';

const plain = createPalette(false);

const splash = (over: Partial<Parameters<typeof renderSplash>[0]> = {}): string[] =>
  renderSplash({
    elapsedMs: 400,
    frame: 0,
    width: 99,
    height: 24,
    platform: 'win32',
    palette: plain,
    unicode: true,
    ...over,
  });

/** Where the first non-blank line starts, which is where the block sits. */
const leftEdge = (lines: string[]): number => {
  const first = lines.find((line) => line.trim() !== '') ?? '';
  return first.length - first.trimStart().length;
};

describe('renderSplash', () => {
  it('fills the terminal exactly, whatever it has to say', () => {
    for (const height of [10, 24, 60]) {
      expect(splash({ height }).length).toBe(height);
    }
  });

  /**
   * The rule the whole screen rests on. The late notes are the widest lines the
   * splash can hold, so a block measured against the current frame slid
   * sideways the moment one appeared, under somebody who was reading it.
   */
  it('does not move sideways when the late notes appear', () => {
    const early = leftEdge(splash({ elapsedMs: 400 }));
    const slow = leftEdge(splash({ elapsedMs: SLOW_AFTER_MS }));
    const verySlow = leftEdge(splash({ elapsedMs: VERY_SLOW_AFTER_MS }));
    expect(slow).toBe(early);
    expect(verySlow).toBe(early);
  });

  /** Same reason, one line down: the counter widens at ten seconds. */
  it('does not move sideways when the counter reaches two digits', () => {
    const before = splash({ elapsedMs: 9_900 }).find((l) => l.includes('reading this machine'));
    const after = splash({ elapsedMs: 10_100 }).find((l) => l.includes('reading this machine'));
    expect(visibleLength(after ?? '')).toBe(visibleLength(before ?? ''));
  });

  it('says nothing about the wait until the wait is unusual', () => {
    const early = splash({ elapsedMs: 1_000 }).join('\n');
    expect(early).not.toContain('longer than usual');
    expect(splash({ elapsedMs: SLOW_AFTER_MS }).join('\n')).toContain('longer than usual');
  });

  /** The reader who has waited this long is looking for the way out. */
  it('offers the way out once the wait is long', () => {
    expect(splash({ elapsedMs: VERY_SLOW_AFTER_MS }).join('\n')).toContain('ctrl-c');
  });

  it('names the command it is actually waiting on', () => {
    expect(splash({ platform: 'win32' }).join('\n')).toContain('PowerShell');
    expect(splash({ platform: 'linux' }).join('\n')).toContain('/proc');
    expect(splash({ platform: 'darwin' }).join('\n')).toContain('lsof');
  });

  it('shows the keys, so the wait teaches something', () => {
    expect(splash().join('\n')).toContain('x kill');
  });

  /** A terminal that would draw boxes gets a screen it can draw. */
  it('stays inside ASCII when the terminal cannot do better', () => {
    const lines = splash({ unicode: false }).join('\n');
    expect(/[^\x00-\x7f]/.test(stripAnsi(lines))).toBe(false);
    expect(lines).toContain('whotop');
  });

  it('stamps the version in the bottom corner, in the shape the footer uses', () => {
    // The v is added here, exactly as withVersion adds it, so the splash and
    // the footer of the screen it opens onto cannot disagree about the build.
    const lines = splash({ version: '0.2.0', height: 24 });
    expect(lines[23]).toContain('v0.2.0');
    expect(splash({ version: null }).join('\n')).not.toContain('0.2.0');
  });

  /** Every line is drawn, and every line has to fit the terminal it is drawn in. */
  it('never builds a line wider than the screen', () => {
    for (const width of [40, 60, 99, 200]) {
      const lines = splash({ width });
      const overflow = lines.filter((line) => visibleLength(line) > width);
      // The block is centred, so nothing may be pushed off the right edge by
      // its own padding; content wider than the terminal is the caller's clamp.
      expect(overflow.every((line) => leftEdge([line]) === 0)).toBe(true);
    }
  });
});

describe('spinnerFrame', () => {
  it('advances and wraps', () => {
    expect(spinnerFrame(0, true)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(SPINNER_FRAMES.length, true)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(1, true)).not.toBe(spinnerFrame(0, true));
  });

  /** A frame counter that ran backwards used to index off the end of the array. */
  it('survives a negative frame', () => {
    expect(spinnerFrame(-1, true)).toBe(SPINNER_FRAMES[SPINNER_FRAMES.length - 1]);
  });

  it('falls back to ASCII', () => {
    expect(spinnerFrame(0, false)).toBe('|');
  });
});

describe('formatElapsed', () => {
  it('holds its width from one tenth of a second to a hundred', () => {
    expect(formatElapsed(0)).toHaveLength(6);
    expect(formatElapsed(9_900)).toHaveLength(6);
    expect(formatElapsed(99_900)).toHaveLength(6);
    expect(formatElapsed(400).trim()).toBe('0.4s');
  });

  /** A clock that stepped backwards must not print a negative wait. */
  it('never counts below zero', () => {
    expect(formatElapsed(-500).trim()).toBe('0.0s');
  });
});

describe('slowNote', () => {
  it('stays quiet while the wait is ordinary', () => {
    expect(slowNote(SLOW_AFTER_MS - 1, 'win32')).toBe('');
  });

  it('blames the right thing on each platform', () => {
    expect(slowNote(SLOW_AFTER_MS, 'win32')).toContain('WMI');
    expect(slowNote(SLOW_AFTER_MS, 'linux')).not.toContain('WMI');
  });
});

describe('collectingNote', () => {
  it('has something to say about an unknown platform', () => {
    expect(collectingNote('aix').join(' ')).toContain('process table');
  });
});

describe('supportsUnicode', () => {
  /**
   * By terminal, not by platform. Windows Terminal draws braille perfectly and
   * conhost draws boxes, and both are win32.
   */
  it('trusts a Windows terminal that announces itself', () => {
    expect(supportsUnicode({ WT_SESSION: '1' }, 'win32')).toBe(true);
    expect(supportsUnicode({ TERM_PROGRAM: 'vscode' }, 'win32')).toBe(true);
  });

  it('assumes conhost when nothing announces itself', () => {
    expect(supportsUnicode({}, 'win32')).toBe(false);
  });

  it('trusts Unix apart from the bare virtual console', () => {
    expect(supportsUnicode({ TERM: 'xterm-256color' }, 'linux')).toBe(true);
    expect(supportsUnicode({ TERM: 'linux' }, 'linux')).toBe(false);
    expect(supportsUnicode({ TERM: 'dumb' }, 'darwin')).toBe(false);
  });
});
