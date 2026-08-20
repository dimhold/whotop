import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../src/inspect.js';
import {
  encodePathSegment,
  matchTrace,
  resolveSlugPath,
  rulesForProcess,
  scanTraces,
  scanTracesForProcesses,
  splitSlugRoot,
  TRACE_RULES,
  TRACE_TIE_MS,
  TRACE_WINDOW_MS,
} from '../src/traces.js';
import { unavailable } from '../src/types.js';
import type { TraceIo, TraceSource } from '../src/traces.js';
import type { CollectorCapabilities, RawProcess } from '../src/types.js';

const SOCIAL = '85fa958f-1e1a-4a3f-9c0e-2b6b4a1d77aa';
const BLOG = 'e0e6d003-2b1c-4f7a-8d3e-11aa22bb33cc';

/**
 * A fake disk.
 *
 * The whole point of putting the file system behind {@link TraceIo} is that
 * the matching, the tie breaking and the name decoding can be exercised on
 * every machine and not only on the one that produced the directories.
 */
interface Tree {
  readonly dirs: Record<string, readonly string[]>;
  readonly files?: Record<string, readonly string[]>;
  readonly created?: Record<string, string>;
}

function fakeIo(tree: Tree, calls?: { children: number }): TraceIo {
  return {
    children(dir, kind) {
      if (calls) calls.children += 1;
      const table = kind === 'dir' ? tree.dirs : (tree.files ?? {});
      const hit = table[dir];
      if (hit) return hit;
      // A directory that is not in the tree is one that could not be read,
      // which is exactly what a missing or forbidden directory looks like.
      return kind === 'dir' && dir in (tree.files ?? {}) ? [] : null;
    },
    createdAt(path) {
      const stamp = tree.created?.[path];
      return stamp ? new Date(stamp) : null;
    },
  };
}

const TEMP = 'D:\\Temp';
const ROOT = 'D:\\Temp\\claude';

/** A machine with two Claude Code sessions and one unrelated browser profile. */
function machine(created: Record<string, string>): Tree {
  return {
    dirs: {
      [ROOT]: ['D--work-projects-shop-web', 'D--work-projects-example-dev', 'chrome-shot-profile'],
      [`${ROOT}\\D--work-projects-shop-web`]: [SOCIAL, 'notes'],
      [`${ROOT}\\D--work-projects-example-dev`]: [BLOG],
      [`${ROOT}\\chrome-shot-profile`]: ['Crashpad'],
      'D:\\': ['work', 'Temp'],
      'D:\\work': ['projects', 'whotop'],
      'D:\\work\\projects': ['shop-web', 'example.dev'],
      'D:\\work\\projects\\shop-web': [],
      'D:\\work\\projects\\example.dev': [],
    },
    created,
  };
}

function source(created: Record<string, string>, calls?: { children: number }): TraceSource {
  return scanTraces({ env: { tmpdir: TEMP, home: 'C:\\Users\\dev' }, io: fakeIo(machine(created), calls) });
}

const claude = (startedAt: string | null): Pick<RawProcess, 'name' | 'startedAt'> => ({
  name: 'claude.exe',
  startedAt: startedAt === null ? null : new Date(startedAt),
});

describe('the trace rule table', () => {
  it('claims the executables it knows and nothing else', () => {
    expect(rulesForProcess('claude.exe').map((r) => r.id)).toEqual(['claude-code-session']);
    expect(rulesForProcess('CLAUDE.EXE')).toHaveLength(1);
    expect(rulesForProcess('node.exe')).toHaveLength(0);
  });

  it('describes every source as data, so a new tool is a row and not a branch', () => {
    for (const rule of TRACE_RULES) {
      expect(rule.roots({ tmpdir: TEMP, home: 'C:\\Users\\dev' }).length).toBeGreaterThan(0);
      expect(rule.depth).toBeGreaterThan(0);
    }
  });
});

describe('scanTraces', () => {
  const scan = source({
    [`${ROOT}\\D--work-projects-shop-web\\${SOCIAL}`]: '2026-08-18T18:48:21.000Z',
    [`${ROOT}\\D--work-projects-example-dev\\${BLOG}`]: '2026-08-18T18:49:02.100Z',
  });

  it('reads the dated directories under the root', () => {
    expect(scan.entries.map((e) => e.names.slug).sort()).toEqual(['D--work-projects-example-dev', 'D--work-projects-shop-web']);
  });

  it('skips entries the rule refuses to read, which is how unrelated directories drop out', () => {
    // `notes` is not a session id and `chrome-shot-profile` is another tool's
    // scratch directory that happens to share the root.
    expect(scan.entries.some((e) => e.path.includes('notes'))).toBe(false);
    expect(scan.entries.some((e) => e.path.includes('chrome-shot-profile'))).toBe(false);
  });

  it('drops an entry with no creation time instead of guessing one', () => {
    const partial = source({ [`${ROOT}\\D--work-projects-shop-web\\${SOCIAL}`]: '2026-08-18T18:48:21.000Z' });
    expect(partial.entries).toHaveLength(1);
  });

  it('reports a missing root as a problem, not as a throw', () => {
    const empty = scanTraces({
      env: { tmpdir: 'E:\\nowhere', home: 'C:\\Users\\dev' },
      io: fakeIo({ dirs: {} }),
    });
    expect(empty.entries).toHaveLength(0);
    expect(empty.problems[0]?.note).toMatch(/could be read under E:\\nowhere\\claude/);
  });

  it('stays off the disk when no process in the table could be explained by a rule', () => {
    const calls = { children: 0 };
    const result = scanTracesForProcesses([{ name: 'node.exe' }, { name: 'chrome.exe' }], {
      env: { tmpdir: TEMP, home: 'C:\\Users\\dev' },
      io: fakeIo(machine({}), calls),
    });
    expect(result).toBeNull();
    expect(calls.children).toBe(0);
  });
});

describe('matchTrace', () => {
  const scan = source({
    [`${ROOT}\\D--work-projects-shop-web\\${SOCIAL}`]: '2026-08-18T18:48:21.000Z',
    [`${ROOT}\\D--work-projects-example-dev\\${BLOG}`]: '2026-08-18T18:49:02.100Z',
  });

  it('names the project whose directory was created next to the process start', () => {
    const outcome = matchTrace(claude('2026-08-18T18:48:22.909Z'), scan);
    expect(outcome.kind).toBe('matched');
    if (outcome.kind !== 'matched') return;
    expect(outcome.field.value).toBe('D:\\work\\projects\\shop-web');
    expect(outcome.field.source).toBe('inferred');
  });

  it('never claims to have read the value, and names the directory it correlated with', () => {
    const outcome = matchTrace(claude('2026-08-18T18:48:22.909Z'), scan);
    expect(outcome.kind === 'matched' && outcome.field.source).not.toBe('exact');
    expect(outcome.kind === 'matched' && outcome.field.note).toMatch(
      new RegExp(`${SOCIAL.slice(0, 8)}.*created 1\\.9s.*not a reading of the process`),
    );
  });

  /**
   * The refusal that matters. Two sessions launched together cannot be told
   * apart by a timestamp, and this is the tool people kill processes from, so
   * a confident wrong project is worse than no project at all.
   */
  it('refuses when two directories from different projects fall inside the tie window', () => {
    const tie = source({
      [`${ROOT}\\D--work-projects-shop-web\\${SOCIAL}`]: '2026-08-18T18:48:21.000Z',
      [`${ROOT}\\D--work-projects-example-dev\\${BLOG}`]: '2026-08-18T18:48:23.500Z',
    });
    const outcome = matchTrace(claude('2026-08-18T18:48:22.909Z'), tie);
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'no-rule') return;
    expect(outcome.field.value).toBeNull();
    expect(outcome.field.source).toBe('unavailable');
    expect(outcome.field.note).toMatch(/D--work-projects-shop-web/);
    expect(outcome.field.note).toMatch(/D--work-projects-example-dev/);
  });

  it('does not call two directories of the same project a tie, because they agree on the answer', () => {
    const twin = scanTraces({
      env: { tmpdir: TEMP, home: 'C:\\Users\\dev' },
      io: fakeIo({
        dirs: {
          [ROOT]: ['D--work-projects-shop-web'],
          [`${ROOT}\\D--work-projects-shop-web`]: [SOCIAL, BLOG],
          'D:\\': ['work'],
          'D:\\work': ['projects'],
          'D:\\work\\projects': ['shop-web'],
          'D:\\work\\projects\\shop-web': [],
        },
        created: {
          [`${ROOT}\\D--work-projects-shop-web\\${SOCIAL}`]: '2026-08-18T18:48:21.000Z',
          [`${ROOT}\\D--work-projects-shop-web\\${BLOG}`]: '2026-08-18T18:48:23.500Z',
        },
      }),
    });
    const outcome = matchTrace(claude('2026-08-18T18:48:22.909Z'), twin);
    expect(outcome.kind).toBe('matched');
  });

  it('refuses when the nearest directory is further away than the window', () => {
    const outcome = matchTrace(claude('2026-08-18T19:30:00.000Z'), scan);
    expect(outcome.kind).toBe('out-of-window');
    if (outcome.kind === 'no-rule') return;
    expect(outcome.field.value).toBeNull();
    expect(outcome.field.note).toMatch(/outside the 45\.0s window/);
  });

  it('says so when there is nothing on disk to match against', () => {
    const empty = scanTraces({ env: { tmpdir: 'E:\\nowhere', home: 'C:\\Users\\dev' }, io: fakeIo({ dirs: {} }) });
    const outcome = matchTrace(claude('2026-08-18T18:48:22.909Z'), empty);
    expect(outcome.kind).toBe('no-trace');
    if (outcome.kind === 'no-rule') return;
    expect(outcome.field.note).toMatch(/nothing to match this process against/);
  });

  it('says so when the process reported no start time, since the whole method is a time comparison', () => {
    const outcome = matchTrace(claude(null), scan);
    expect(outcome.kind).toBe('no-start-time');
  });

  it('stays silent about processes no rule speaks for', () => {
    expect(matchTrace({ name: 'node.exe', startedAt: new Date() }, scan).kind).toBe('no-rule');
  });

  it('reports the match instead of a path when the name cannot be resolved on this machine', () => {
    const moved = scanTraces({
      env: { tmpdir: TEMP, home: 'C:\\Users\\dev' },
      io: fakeIo({
        dirs: { [ROOT]: ['D--work-gone'], [`${ROOT}\\D--work-gone`]: [SOCIAL], 'D:\\': ['work'], 'D:\\work': [] },
        created: { [`${ROOT}\\D--work-gone\\${SOCIAL}`]: '2026-08-18T18:48:21.000Z' },
      }),
    });
    const outcome = matchTrace(claude('2026-08-18T18:48:22.909Z'), moved);
    expect(outcome.kind).toBe('undecodable');
    if (outcome.kind === 'no-rule') return;
    expect(outcome.field.value).toBeNull();
    expect(outcome.field.note).toMatch(/renamed or deleted/);
  });

  it('keeps the thresholds as named constants, because they are guesses and not measurements', () => {
    expect(TRACE_WINDOW_MS).toBe(45_000);
    expect(TRACE_TIE_MS).toBe(2_000);
  });
});

describe('decoding a directory name back into a path', () => {
  const io = fakeIo(machine({}));

  it('splits the drive off the encoded name', () => {
    expect(splitSlugRoot('D--work')).toEqual({ path: 'D:\\', rest: 'work' });
    expect(splitSlugRoot('-home-dev-app')).toEqual({ path: '/', rest: 'home-dev-app' });
    expect(splitSlugRoot('claude-shared')).toBeNull();
  });

  it('walks nested directories and keeps a dash that belongs to a directory name', () => {
    expect(resolveSlugPath('D--work-projects-shop-web', io).path).toBe('D:\\work\\projects\\shop-web');
  });

  /**
   * The encoding flattens every punctuation character to a dash, so
   * `example.dev` and `example-dev` and `example\by` are the same name. Only the
   * disk can say which one it was, which is why the decoder asks it.
   */
  it('recovers a character the encoding threw away', () => {
    expect(resolveSlugPath('D--work-projects-example-dev', io).path).toBe('D:\\work\\projects\\example.dev');
  });

  it('refuses when two real directories encode to the same name', () => {
    const twins = fakeIo({
      dirs: {
        'D:\\': ['work'],
        'D:\\work': ['a-b', 'a'],
        'D:\\work\\a-b': [],
        'D:\\work\\a': ['b'],
        'D:\\work\\a\\b': [],
      },
    });
    const resolution = resolveSlugPath('D--work-a-b', twins);
    expect(resolution.path).toBeNull();
    expect(resolution.note).toMatch(/more than one directory/);
  });

  it('does not let a prefix stand in for a whole directory name', () => {
    const io2 = fakeIo({ dirs: { 'D:\\': ['worktree'], 'D:\\worktree': [] } });
    expect(resolveSlugPath('D--work', io2).path).toBeNull();
  });

  it('says nothing rather than throwing when the drive is not readable', () => {
    expect(resolveSlugPath('D--work-projects-shop-web', fakeIo({ dirs: {} })).path).toBeNull();
  });

  it('encodes the way the tools do', () => {
    expect(encodePathSegment('shop-web')).toBe('shop-web');
    expect(encodePathSegment('example.dev')).toBe('example-dev');
    expect(encodePathSegment('my app_2')).toBe('my-app-2');
  });
});

describe('a snapshot built with traces', () => {
  const CAPABILITIES: CollectorCapabilities = {
    commandLine: 'partial',
    cwd: 'none',
    ports: 'full',
    user: 'none',
    notes: [],
  };

  const process = (pid: number, startedAt: string): RawProcess => ({
    pid,
    ppid: null,
    name: 'claude.exe',
    exePath: 'C:\\Users\\dev\\.local\\bin\\claude.exe',
    commandLine: { value: 'C:\\Users\\dev\\.local\\bin\\claude.exe --resume', source: 'exact' },
    cwd: unavailable<string>('the command line carries no absolute path to infer one from'),
    startedAt: new Date(startedAt),
    user: null,
    services: [],
  });

  const build = (traces: TraceSource) =>
    buildSnapshot(
      { processes: [process(15044, '2026-08-18T18:48:22.909Z')], ports: [], warnings: [] },
      {
        platform: 'win32',
        capabilities: CAPABILITIES,
        traces,
        now: new Date('2026-08-18T19:00:00.000Z'),
        resolveProject: () => unavailable<string>('stubbed in tests'),
      },
    );

  it('fills a working directory the platform refused to disclose, and marks it inferred', () => {
    const snapshot = build(
      source({
        [`${ROOT}\\D--work-projects-shop-web\\${SOCIAL}`]: '2026-08-18T18:48:21.000Z',
        [`${ROOT}\\D--work-projects-example-dev\\${BLOG}`]: '2026-08-18T18:49:02.100Z',
      }),
    );
    const view = snapshot.processes[0];
    expect(view?.cwd.value).toBe('D:\\work\\projects\\shop-web');
    expect(view?.cwd.source).toBe('inferred');
  });

  it('leaves the column empty and says why when the two candidates cannot be told apart', () => {
    const snapshot = build(
      source({
        [`${ROOT}\\D--work-projects-shop-web\\${SOCIAL}`]: '2026-08-18T18:48:21.000Z',
        [`${ROOT}\\D--work-projects-example-dev\\${BLOG}`]: '2026-08-18T18:48:23.500Z',
      }),
    );
    const view = snapshot.processes[0];
    expect(view?.cwd.value).toBeNull();
    expect(view?.cwd.note).toMatch(/different projects/);
  });

  it('admits under --explain that some rows were named by a directory and not by the process table', () => {
    const snapshot = build(source({ [`${ROOT}\\D--work-projects-shop-web\\${SOCIAL}`]: '2026-08-18T18:48:21.000Z' }));
    expect(snapshot.capabilities.notes.join(' ')).toMatch(/dated directory they create at startup/);
  });

  it('keeps a directory the platform did disclose, rather than overwriting it with a correlation', () => {
    const disclosed: RawProcess = {
      ...process(15044, '2026-08-18T18:48:22.909Z'),
      cwd: { value: 'D:\\work\\real', source: 'exact' },
    };
    const snapshot = buildSnapshot(
      { processes: [disclosed], ports: [], warnings: [] },
      {
        platform: 'linux',
        capabilities: CAPABILITIES,
        traces: source({ [`${ROOT}\\D--work-projects-shop-web\\${SOCIAL}`]: '2026-08-18T18:48:21.000Z' }),
        resolveProject: () => unavailable<string>('stubbed in tests'),
      },
    );
    expect(snapshot.processes[0]?.cwd.value).toBe('D:\\work\\real');
    expect(snapshot.processes[0]?.cwd.source).toBe('exact');
  });
});
