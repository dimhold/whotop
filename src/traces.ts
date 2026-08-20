/**
 * Identifying a process by the traces it leaves on disk.
 *
 * Some programs say nothing about where they run. `claude.exe --resume`
 * carries exactly one absolute path, its own install directory, so the command
 * line cannot answer "which project is this session". The file system can:
 * the session writes a scratch directory named after its project within
 * seconds of starting, so a process start time and a directory creation time
 * that agree to the second are the same session.
 *
 * The idea is older than any one tool, which is why the sources live in a
 * table rather than in code. A rule says where to look, how to read the names
 * it finds, and how to turn them into a project path. Adding a tool is a row
 * here plus a fixture in the test.
 *
 * Everything that decides is pure over injected input: the disk is reached
 * only through {@link TraceIo}, so the matching, the tie breaking and the name
 * decoding are all testable against fixtures.
 *
 * The answer is always `inferred` and never `exact`. Two directories created
 * at the same second cannot be told apart, and this is a tool people kill
 * processes from, so an unresolvable case reports nothing rather than the more
 * likely of two projects.
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

import { unavailable, inferred } from './types.js';
import type { Field, RawProcess } from './types.js';

/**
 * How far a directory creation may sit from a process start and still be
 * called the same session.
 *
 * A heuristic, not a measurement. It comes from a working diagnostic script
 * and it survived a check on a live machine: seven concurrent Claude Code
 * sessions each matched their directory within 2.6 seconds, and the nearest
 * directory belonging to a different project was 36.8 seconds away. The window
 * is wide enough for a cold start on a loaded machine and narrow enough that
 * an unrelated session started a minute later is not a candidate.
 */
export const TRACE_WINDOW_MS = 45_000;

/**
 * How close a second candidate may come to the best one before the answer is
 * refused as ambiguous.
 *
 * Also a heuristic. Two sessions launched within two seconds of each other
 * cannot be separated by their timestamps at all, and naming the wrong project
 * confidently is worse here than naming none: the row it decorates has a kill
 * key next to it.
 */
export const TRACE_TIE_MS = 2_000;

/** Ceiling on directory entries read in one scan, so a long history stays cheap. */
export const TRACE_SCAN_LIMIT = 4_000;

/** Ceiling on directories listed while decoding one name. */
export const TRACE_DECODE_LIMIT = 64;

export const TRACE_CAPABILITY_NOTE =
  'Some processes are identified by the dated directory they create at startup rather than by their command line. That match is a time correlation within 45s, so it is reported as inferred, and it is refused when two candidates from different projects fall inside the window.';

/** Directories a rule can look in, resolved when the scan runs. */
export interface TraceEnv {
  readonly tmpdir: string;
  readonly home: string;
}

/** What a rule read out of one entry name. */
export interface TraceNames {
  /** The encoded project path, e.g. `D--work-projects-shop-web`. */
  readonly slug: string;
  /** Whatever identifies the single run, printed for the human. */
  readonly session: string | null;
}

/**
 * One source of traces.
 *
 * `roots` says where to look, `read` says how to understand the names found
 * there, and `depth` says how many directory levels down the dated entry sits.
 */
export interface TraceRule {
  readonly id: string;
  /** Named in every note, so a person can go and look at the directory. */
  readonly tool: string;
  /** Executable names as the process table reports them, lower case. */
  readonly processNames: readonly string[];
  roots(env: TraceEnv): readonly string[];
  /** Levels below the root. The last level carries the creation time. */
  readonly depth: number;
  readonly entryKind: 'dir' | 'file';
  /** Rejecting an entry is a `null` return, which is how noise is skipped. */
  read(segments: readonly string[]): TraceNames | null;
}

export interface TraceEntry {
  readonly ruleId: string;
  readonly tool: string;
  /** Full path of the dated entry, quoted in the note as the evidence. */
  readonly path: string;
  readonly createdAt: Date;
  readonly names: TraceNames;
}

/** Why a rule produced nothing, phrased for a human. */
export interface TraceProblem {
  readonly ruleId: string;
  readonly note: string;
}

export interface SlugResolution {
  readonly path: string | null;
  /** Why the name could not be turned into a path, when it could not. */
  readonly note: string | null;
}

/**
 * The result of one scan, plus the way to turn a winning name into a path.
 *
 * Decoding is deferred because it costs directory listings and only the
 * winner needs it. Ambiguity is settled on the encoded name, which is enough:
 * different names are different projects.
 */
export interface TraceSource {
  readonly entries: readonly TraceEntry[];
  readonly problems: readonly TraceProblem[];
  resolve(entry: TraceEntry): SlugResolution;
}

/** The only way this module touches the disk. */
export interface TraceIo {
  /** Child names of one kind, or null when the directory could not be read. */
  children(dir: string, kind: 'dir' | 'file'): readonly string[] | null;
  /** Creation time of an entry, or null when it could not be read. */
  createdAt(path: string): Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The table.
 *
 * Only sources that were seen working on a real machine belong here. A rule
 * that was reasoned about but never observed would produce confident rows out
 * of nothing, which is the failure this whole module is written against.
 */
export const TRACE_RULES: readonly TraceRule[] = [
  {
    id: 'claude-code-session',
    tool: 'Claude Code',
    processNames: ['claude.exe', 'claude'],
    // <temp>/claude/<encoded project path>/<session uuid>/, written in the
    // first seconds of a session and left behind when it ends.
    roots: (env) => [traceJoin(env.tmpdir, 'claude')],
    depth: 2,
    entryKind: 'dir',
    read: (segments) => {
      const [slug, session] = segments;
      // The same root holds browser profiles and skill caches from other
      // tooling. A session is a uuid, so anything else is not one.
      if (!slug || !session || !UUID.test(session)) return null;
      return { slug, session };
    },
  },
];

/** Rules that can speak for this executable, if any. */
export function rulesForProcess(name: string, rules: readonly TraceRule[] = TRACE_RULES): TraceRule[] {
  const lower = name.toLowerCase();
  return rules.filter((rule) => rule.processNames.includes(lower));
}

/**
 * The encoding these directory names use: every character that is not a
 * letter or a digit becomes a dash.
 *
 * It is lossy in one direction only. `D:\work\projects\example.dev` and
 * `D:\work\projects\example-dev` and `D:\work\projects\example\dev` all encode to
 * `D--work-projects-example-dev`, so a name can never be decoded by string surgery
 * alone. It is decoded by looking at what is actually on the disk.
 */
export function encodePathSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '-');
}

interface SlugRoot {
  readonly path: string;
  readonly rest: string;
}

/** Split the drive or the leading slash off an encoded path. */
export function splitSlugRoot(slug: string): SlugRoot | null {
  const drive = /^([A-Za-z])--/.exec(slug);
  // `D--work` came from `D:\work`: the two dashes are the colon and the slash.
  if (drive?.[1]) return { path: `${drive[1]}:\\`, rest: slug.slice(3) };
  if (slug.startsWith('-')) return { path: '/', rest: slug.slice(1) };
  return null;
}

/**
 * Join using whichever separator the base already uses.
 *
 * A Windows path decoded from a name has to keep looking like a Windows path
 * even when the scan runs somewhere else, so the host separator is the wrong
 * thing to ask.
 */
export function traceJoin(base: string, name: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return base.endsWith(sep) ? base + name : base + sep + name;
}

/**
 * Turn an encoded name back into the directory it came from, by walking the
 * disk and asking which real directory names encode to what we hold.
 *
 * Guessing where the separators were would be wrong about as often as it was
 * right: a dash in the name is indistinguishable from a slash or a dot. The
 * disk knows, so the walk asks it, one listing per level.
 */
export function resolveSlugPath(slug: string, io: TraceIo, limit = TRACE_DECODE_LIMIT): SlugResolution {
  const root = splitSlugRoot(slug);
  if (!root) return { path: null, note: `the directory name ${slug} does not start with a drive or a root` };
  if (root.rest === '') return { path: root.path, note: null };

  let listings = 0;
  const found: string[] = [];
  const walk = (dir: string, rest: string): void => {
    // Two answers already means the question cannot be settled, and more
    // listings will not change that.
    if (found.length > 1 || listings >= limit) return;
    listings += 1;
    const children = io.children(dir, 'dir');
    if (!children) return;
    const target = rest.toLowerCase();
    for (const child of children) {
      const encoded = encodePathSegment(child).toLowerCase();
      if (encoded === '' || !target.startsWith(encoded)) continue;
      const tail = target.slice(encoded.length);
      if (tail === '') {
        found.push(traceJoin(dir, child));
        continue;
      }
      // The boundary has to be a dash, otherwise `work` would match `worktree`.
      if (!tail.startsWith('-')) continue;
      walk(traceJoin(dir, child), rest.slice(encoded.length + 1));
    }
  };
  walk(root.path, root.rest);

  if (found.length === 1 && found[0]) return { path: found[0], note: null };
  if (found.length > 1) {
    return {
      path: null,
      note: `more than one directory on this machine encodes to ${slug} (${found.slice(0, 2).join(', ')}), so which one it names cannot be told`,
    };
  }
  return { path: null, note: `no directory on this machine encodes to ${slug}; it was probably renamed or deleted` };
}

export type TraceOutcome =
  /** No rule speaks for this executable, so nothing was even looked for. */
  | { readonly kind: 'no-rule' }
  | { readonly kind: 'no-start-time'; readonly field: Field<string> }
  | { readonly kind: 'no-trace'; readonly field: Field<string> }
  | { readonly kind: 'out-of-window'; readonly field: Field<string> }
  | { readonly kind: 'ambiguous'; readonly field: Field<string> }
  | { readonly kind: 'undecodable'; readonly field: Field<string> }
  | { readonly kind: 'matched'; readonly field: Field<string>; readonly entry: TraceEntry; readonly diffMs: number };

/**
 * Whether a trace outcome should replace what the platform said.
 *
 * A match replaces it because it is a better answer. A refusal replaces it
 * when the refusal is a finding: "two sessions started together" and "the
 * nearest one is four minutes off" both say more than the generic platform
 * note. Having looked and found nothing says less, so that leaves the
 * platform note alone.
 */
export type InformativeTrace = Extract<
  TraceOutcome,
  { kind: 'matched' | 'ambiguous' | 'out-of-window' | 'undecodable' }
>;

export function traceIsInformative(outcome: TraceOutcome): outcome is InformativeTrace {
  return (
    outcome.kind === 'matched' ||
    outcome.kind === 'ambiguous' ||
    outcome.kind === 'out-of-window' ||
    outcome.kind === 'undecodable'
  );
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Pure over the source: given entries and a start time, name the project. */
export function matchTrace(
  process: Pick<RawProcess, 'name' | 'startedAt'>,
  source: TraceSource,
  rules: readonly TraceRule[] = TRACE_RULES,
): TraceOutcome {
  const claiming = rulesForProcess(process.name, rules);
  if (claiming.length === 0) return { kind: 'no-rule' };

  const ids = new Set(claiming.map((rule) => rule.id));
  const tool = claiming[0]?.tool ?? 'this tool';
  if (process.startedAt === null) {
    return {
      kind: 'no-start-time',
      field: unavailable<string>(
        `a ${tool} run leaves a dated directory behind, but this process did not report a start time to compare it with`,
      ),
    };
  }

  const candidates = source.entries.filter((entry) => ids.has(entry.ruleId));
  if (candidates.length === 0) {
    const problem = source.problems.find((p) => ids.has(p.ruleId));
    return {
      kind: 'no-trace',
      field: unavailable<string>(problem?.note ?? `no ${tool} directory was found to match this process against`),
    };
  }

  const started = process.startedAt.getTime();
  const scored = candidates
    .map((entry) => ({ entry, diffMs: Math.abs(entry.createdAt.getTime() - started) }))
    .sort((a, b) => a.diffMs - b.diffMs);

  const best = scored[0];
  if (!best) return { kind: 'no-trace', field: unavailable<string>(`no ${tool} directory was found to match this process against`) };
  if (best.diffMs > TRACE_WINDOW_MS) {
    return {
      kind: 'out-of-window',
      field: unavailable<string>(
        `the nearest ${tool} directory was created ${seconds(best.diffMs)} from this process start, outside the ${seconds(TRACE_WINDOW_MS)} window, so it is a different run`,
      ),
    };
  }

  // A rival is only a rival when it names a different project. Two entries for
  // the same project agree on the answer whichever of them is the real one.
  const rivals = scored.filter(
    (row) => row !== best && row.diffMs <= best.diffMs + TRACE_TIE_MS && row.entry.names.slug !== best.entry.names.slug,
  );
  if (rivals.length > 0) {
    const names = [best.entry.names.slug, ...rivals.map((r) => r.entry.names.slug)].slice(0, 3).join(', ');
    return {
      kind: 'ambiguous',
      field: unavailable<string>(
        `${rivals.length + 1} ${tool} directories were created within ${seconds(TRACE_TIE_MS)} of each other around this process start and they name different projects (${names}), so this pid cannot be told apart from them`,
      ),
    };
  }

  const resolved = source.resolve(best.entry);
  if (resolved.path === null) {
    return {
      kind: 'undecodable',
      field: unavailable<string>(
        `this process matches the ${tool} directory ${best.entry.path} to within ${seconds(best.diffMs)}, but ${resolved.note ?? 'its name could not be read as a path'}`,
      ),
    };
  }

  const session = best.entry.names.session;
  const run = session ? ` (${tool} session ${session.slice(0, 8)})` : '';
  return {
    kind: 'matched',
    entry: best.entry,
    diffMs: best.diffMs,
    field: inferred(
      resolved.path,
      `matched to ${best.entry.path}, created ${seconds(best.diffMs)} from this process start${run}; a time correlation inside a ${seconds(TRACE_WINDOW_MS)} window, not a reading of the process`,
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Below this line the disk is actually touched. Everything above is
 * pure over TraceIo, and the tests feed it a fixture tree.
 * ------------------------------------------------------------------ */

interface ScanOptions {
  readonly env: TraceEnv;
  readonly io: TraceIo;
  readonly rules?: readonly TraceRule[];
  readonly limit?: number;
}

/**
 * Walk each rule's roots and collect the dated entries.
 *
 * A missing root, a directory without permissions or one that disappears
 * between two reads all come back as a problem note, never as a throw. This
 * runs on every listing, so it must be impossible for it to take the tool
 * down.
 */
export function scanTraces(options: ScanOptions): TraceSource {
  const rules = options.rules ?? TRACE_RULES;
  const limit = options.limit ?? TRACE_SCAN_LIMIT;
  const entries: TraceEntry[] = [];
  const problems: TraceProblem[] = [];
  let budget = limit;

  for (const rule of rules) {
    const before = entries.length;
    const roots = rule.roots(options.env);
    const unreadable: string[] = [];

    for (const root of roots) {
      const stack: { dir: string; segments: string[] }[] = [{ dir: root, segments: [] }];
      let sawRoot = false;
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node || budget <= 0) break;
        const level = node.segments.length;
        const kind = level === rule.depth - 1 ? rule.entryKind : 'dir';
        const children = options.io.children(node.dir, kind);
        if (children === null) {
          if (level === 0) unreadable.push(root);
          continue;
        }
        if (level === 0) sawRoot = true;
        for (const child of children) {
          if (budget <= 0) break;
          budget -= 1;
          const segments = [...node.segments, child];
          const path = traceJoin(node.dir, child);
          if (segments.length < rule.depth) {
            stack.push({ dir: path, segments });
            continue;
          }
          const names = rule.read(segments);
          if (!names) continue;
          const createdAt = options.io.createdAt(path);
          // No timestamp is no evidence: this entry cannot take part in a
          // time correlation, so it is dropped rather than guessed at.
          if (!createdAt) continue;
          entries.push({ ruleId: rule.id, tool: rule.tool, path, createdAt, names });
        }
      }
      if (!sawRoot && !unreadable.includes(root)) unreadable.push(root);
    }

    if (entries.length === before) {
      problems.push({
        ruleId: rule.id,
        note:
          unreadable.length > 0
            ? `no ${rule.tool} directory could be read under ${unreadable.join(', ')}, so there is nothing to match this process against`
            : `no ${rule.tool} directory under ${roots.join(', ')} names a project, so there is nothing to match this process against`,
      });
    }
  }

  if (budget <= 0) {
    problems.push({
      ruleId: '*',
      note: `the trace scan stopped after ${limit} entries to stay cheap, so a match may be missing`,
    });
  }

  const cache = new Map<string, SlugResolution>();
  return {
    entries,
    problems,
    resolve: (entry) => {
      const hit = cache.get(entry.names.slug);
      if (hit) return hit;
      const resolution = resolveSlugPath(entry.names.slug, options.io);
      cache.set(entry.names.slug, resolution);
      return resolution;
    },
  };
}

/**
 * The real disk, wrapped so that every refusal is a null.
 *
 * A trace scan happens on every listing next to a claude process, so a missing
 * directory, a denied read or a directory that vanishes between two calls has
 * to be an absent answer rather than an exception.
 */
export function nodeTraceIo(): TraceIo {
  return {
    children(dir, kind) {
      try {
        const rows = readdirSync(dir, { withFileTypes: true });
        const want = kind === 'dir';
        return rows.filter((row) => row.isDirectory() === want).map((row) => row.name);
      } catch {
        return null;
      }
    },
    createdAt(path) {
      try {
        // birthtime is real on Windows and on macOS. Where the kernel does not
        // keep one it comes back as the epoch, which no process start will
        // match, so such an entry drops out on its own.
        const stats = statSync(path);
        const time = stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime;
        return Number.isNaN(time.getTime()) ? null : time;
      } catch {
        return null;
      }
    },
  };
}

export function defaultTraceEnv(): TraceEnv {
  return { tmpdir: tmpdir(), home: homedir() };
}

/**
 * Scan only when some process in the table could be explained by a rule.
 *
 * Most listings contain no such process, and a listing that would learn
 * nothing should not touch the disk at all.
 */
export function scanTracesForProcesses(
  processes: readonly Pick<RawProcess, 'name'>[],
  options: { env?: TraceEnv; io?: TraceIo; rules?: readonly TraceRule[] } = {},
): TraceSource | null {
  const rules = options.rules ?? TRACE_RULES;
  const wanted = rules.filter((rule) => processes.some((p) => rulesForProcess(p.name, [rule]).length > 0));
  if (wanted.length === 0) return null;
  return scanTraces({
    env: options.env ?? defaultTraceEnv(),
    io: options.io ?? nodeTraceIo(),
    rules: wanted,
  });
}
