#!/usr/bin/env node
/**
 * whotop command line.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ALL_ROLES } from './classify.js';
import { createPalette, detectColorSupport } from './color.js';
import { filterProcesses, holdersOfPort } from './filter.js';
import type { SortKey } from './filter.js';
import { inspect } from './inspect.js';
import { askYesNo, describeTarget, killProcesses, signalNote } from './kill.js';
import { runTui } from './tui.js';
import type { KillSignal } from './kill.js';
import {
  renderCapabilities,
  renderDetail,
  renderHeader,
  renderProcesses,
  renderWarnings,
} from './render.js';
import type { ProcessView, Role, Snapshot } from './types.js';

const SORT_KEYS: readonly SortKey[] = ['role', 'pid', 'age', 'port', 'name'];

function version(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `whotop - what is this process, and which port is it holding

Usage
  whotop                          interactive screen: scroll, search, kill
  whotop ls [query] [options]     one-shot listing, for scripts and pipes
  whotop port <number>            show what holds a port
  whotop kill --port <number>     kill the holder of a port, after confirming
  whotop kill --pid <number>      kill a process by pid

Selection
  -a, --all             every process, not just the developer relevant ones
  -f, --filter <text>   substring of the command line, directory, project or name
  -r, --role <role>     filter by role, repeatable or comma separated
      --pid <number>    filter by pid, repeatable
      --port <number>   filter by port, repeatable
  -l, --listening       only processes holding a listening socket
  -o, --orphans         only processes whose parent is gone

Output
  -s, --sort <key>      ${SORT_KEYS.join(' | ')}   (default: role)
      --compact         one line per process
  -w, --wide            wrap the full command line instead of truncating it
  -x, --explain         show the rule behind each role, and platform limits
      --json            machine readable snapshot
      --no-color        disable ANSI colour (NO_COLOR is honoured too)

Killing
      --signal <name>   term | kill | int      (default: term)
  -y, --yes             skip the confirmation prompt

Other
  -h, --help            this text
  -V, --version         print the version

Roles
  ${ALL_ROLES.join(', ')}

Exit codes
  0 success   1 nothing matched or the kill failed   2 bad usage   3 collection failed
`;

interface Parsed {
  readonly command: 'ls' | 'top' | 'port' | 'kill' | 'help' | 'version';
  readonly query: string | null;
  readonly roles: Role[];
  readonly pids: number[];
  readonly ports: number[];
  readonly all: boolean;
  readonly listening: boolean;
  readonly orphans: boolean;
  readonly sort: SortKey;
  readonly compact: boolean;
  readonly wide: boolean;
  readonly explain: boolean;
  readonly json: boolean;
  readonly color: boolean | null;
  readonly signal: KillSignal;
  readonly yes: boolean;
}

class UsageError extends Error {}

function toNumbers(values: readonly string[] | undefined, flag: string): number[] {
  const out: number[] = [];
  for (const value of values ?? []) {
    for (const part of value.split(',')) {
      const parsed = Number.parseInt(part.trim(), 10);
      if (!Number.isFinite(parsed)) throw new UsageError(`${flag} expects a number, got "${part}"`);
      out.push(parsed);
    }
  }
  return out;
}

function toSignal(name: string | undefined): KillSignal {
  switch ((name ?? 'term').toLowerCase()) {
    case 'term':
    case 'sigterm':
      return 'SIGTERM';
    case 'kill':
    case 'sigkill':
      return 'SIGKILL';
    case 'int':
    case 'sigint':
      return 'SIGINT';
    default:
      throw new UsageError(`unknown signal "${name}". Use term, kill or int.`);
  }
}

export function parseCliArgs(rawArgv: readonly string[]): Parsed {
  // `--no-color` is handled here because parseArgs only learned about negated
  // booleans in newer Node versions than whotop supports.
  let colorOverride: boolean | null = null;
  const argv = rawArgv.filter((arg) => {
    if (arg === '--no-color') {
      colorOverride = false;
      return false;
    }
    if (arg === '--color') {
      colorOverride = true;
      return false;
    }
    return true;
  });

  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      all: { type: 'boolean', short: 'a' },
      filter: { type: 'string', short: 'f' },
      role: { type: 'string', short: 'r', multiple: true },
      pid: { type: 'string', multiple: true },
      port: { type: 'string', multiple: true },
      listening: { type: 'boolean', short: 'l' },
      orphans: { type: 'boolean', short: 'o' },
      sort: { type: 'string', short: 's' },
      compact: { type: 'boolean' },
      wide: { type: 'boolean', short: 'w' },
      explain: { type: 'boolean', short: 'x' },
      json: { type: 'boolean' },
      signal: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
    },
  });

  if (values.help) return { ...defaults(), command: 'help' };
  if (values.version) return { ...defaults(), command: 'version' };

  const [head, ...rest] = positionals;
  /**
   * Bare `whotop` opens the interactive screen, because that is what a person
   * typing the name alone wants to do: look, then act. The rule is the plain
   * one, no arguments at all, so that anything scripted keeps the old
   * behaviour and never blocks on a terminal that is not there. `whotop ls`
   * asks for the one-shot listing on purpose.
   */
  let command: Parsed['command'] = rawArgv.length === 0 ? 'top' : 'ls';
  let query: string | null = null;
  const ports = toNumbers(values.port, '--port');
  const pids = toNumbers(values.pid, '--pid');

  if (head === 'top') {
    command = 'top';
  } else if (head === 'port') {
    command = 'port';
    const target = rest[0];
    if (target === undefined) throw new UsageError('`whotop port` needs a port number');
    const parsed = Number.parseInt(target, 10);
    if (!Number.isFinite(parsed)) throw new UsageError(`"${target}" is not a port number`);
    ports.push(parsed);
  } else if (head === 'kill') {
    command = 'kill';
    const target = rest[0];
    if (target !== undefined) {
      const parsed = Number.parseInt(target, 10);
      if (!Number.isFinite(parsed)) throw new UsageError(`"${target}" is not a pid`);
      pids.push(parsed);
    }
    if (ports.length === 0 && pids.length === 0) {
      throw new UsageError('`whotop kill` needs --port <number> or --pid <number>');
    }
  } else if (head === 'ls' || head === 'list') {
    query = rest.join(' ') || null;
  } else if (head !== undefined) {
    query = positionals.join(' ');
  }

  if (values.filter) query = query ? `${query} ${values.filter}` : values.filter;

  const roles: Role[] = [];
  for (const value of values.role ?? []) {
    for (const part of value.split(',')) {
      const role = part.trim() as Role;
      if (!ALL_ROLES.includes(role)) {
        throw new UsageError(`unknown role "${part.trim()}". Known roles: ${ALL_ROLES.join(', ')}`);
      }
      roles.push(role);
    }
  }

  const sort = (values.sort ?? 'role') as SortKey;
  if (!SORT_KEYS.includes(sort)) throw new UsageError(`unknown sort key "${sort}"`);

  return {
    command,
    query,
    roles,
    pids,
    ports,
    all: Boolean(values.all),
    listening: Boolean(values.listening),
    orphans: Boolean(values.orphans),
    sort,
    compact: Boolean(values.compact),
    wide: Boolean(values.wide),
    explain: Boolean(values.explain),
    json: Boolean(values.json),
    color: colorOverride,
    signal: toSignal(values.signal),
    yes: Boolean(values.yes),
  };
}

function defaults(): Parsed {
  return {
    command: 'ls',
    query: null,
    roles: [],
    pids: [],
    ports: [],
    all: false,
    listening: false,
    orphans: false,
    sort: 'role',
    compact: false,
    wide: false,
    explain: false,
    json: false,
    color: null,
    signal: 'SIGTERM',
    yes: false,
  };
}

function toJson(snapshot: Snapshot, shown: readonly ProcessView[]): string {
  return JSON.stringify(
    {
      platform: snapshot.platform,
      capturedAt: snapshot.capturedAt.toISOString(),
      capabilities: snapshot.capabilities,
      warnings: snapshot.warnings,
      processes: shown.map((view) => ({
        pid: view.pid,
        ppid: view.ppid,
        name: view.name,
        user: view.user,
        role: view.classification.role,
        label: view.classification.label,
        confidence: view.classification.confidence,
        reason: view.classification.reason,
        rules: view.classification.matches.map((m) => m.ruleId),
        commandLine: view.commandLine,
        cwd: view.cwd,
        project: view.project,
        startedAt: view.startedAt?.toISOString() ?? null,
        ageMs: view.ageMs,
        orphan: view.orphan,
        ports: view.ports,
      })),
    },
    null,
    2,
  );
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: Parsed;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`whotop: ${(error as Error).message}\n\nRun \`whotop --help\`.\n`);
    return 2;
  }

  if (options.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.command === 'version') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  /**
   * `whotop | grep vite` has no arguments and no terminal, and it used to
   * print a listing. Opening a screen there, or refusing to run at all, would
   * break every pipe that already exists, so an implicit interactive mode
   * quietly steps aside. Typing `whotop top` into a pipe still says no,
   * because that asked for something the pipe cannot give.
   */
  const implicitTop = options.command === 'top' && argv.length === 0;
  if (implicitTop && !process.stdin.isTTY) {
    options = { ...options, command: 'ls' };
  }

  if (options.command === 'top') {
    try {
      await runTui({ collect: () => inspect(), signal: options.signal, version: version() });
      return 0;
    } catch (error) {
      process.stderr.write(`whotop: ${(error as Error).message}\n`);
      return 3;
    }
  }

  const colorEnabled = options.color ?? detectColorSupport();
  const palette = createPalette(options.json ? false : colorEnabled);
  const width = Math.max(60, Math.min(process.stdout.columns ?? 120, 200));

  let snapshot: Snapshot;
  try {
    snapshot = await inspect();
  } catch (error) {
    process.stderr.write(`whotop could not read the process table: ${(error as Error).message}\n`);
    return 3;
  }

  const selected =
    options.command === 'port' && options.ports.length === 1
      ? holdersOfPort(snapshot.processes, options.ports[0]!)
      : filterProcesses(snapshot.processes, {
          query: options.query,
          roles: options.roles,
          pids: options.pids,
          ports: options.ports,
          all: options.all,
          orphansOnly: options.orphans,
          listeningOnly: options.listening,
          sort: options.sort,
        });

  if (options.json) {
    process.stdout.write(`${toJson(snapshot, selected)}\n`);
    return selected.length > 0 ? 0 : 1;
  }

  const out: string[] = [];

  if (options.command === 'kill') {
    return runKill(snapshot, selected, options, palette, width);
  }

  if (options.command === 'port') {
    const port = options.ports[0]!;
    if (selected.length === 0) {
      process.stdout.write(`${palette('yellow', `nothing holds port ${port}`)}\n`);
      const note = snapshot.capabilities.ports === 'full' ? '' : ' (this platform reports ports only partially)';
      if (note) process.stdout.write(`${palette('gray', note.trim())}\n`);
      return 1;
    }
    for (const view of selected) {
      out.push(...renderDetail(view, { palette, width, wide: true }));
      out.push('');
    }
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  }

  out.push(renderHeader(snapshot, selected.length, palette));
  out.push('');
  if (selected.length === 0) {
    out.push(palette('gray', 'nothing matched. Try --all, or a different filter.'));
  } else {
    out.push(
      ...renderProcesses(selected, {
        palette,
        width,
        compact: options.compact,
        wide: options.wide,
        explain: options.explain,
      }),
    );
  }

  if (snapshot.warnings.length > 0) {
    out.push('');
    out.push(...renderWarnings(snapshot.warnings, palette, width));
  }
  if (options.explain) {
    out.push('');
    out.push(...renderCapabilities(snapshot, palette, width));
  }

  process.stdout.write(`${out.join('\n')}\n`);
  return selected.length > 0 ? 0 : 1;
}

async function runKill(
  snapshot: Snapshot,
  selected: readonly ProcessView[],
  options: Parsed,
  palette: ReturnType<typeof createPalette>,
  width: number,
): Promise<number> {
  const targets =
    options.ports.length > 0
      ? options.ports.flatMap((port) => holdersOfPort(snapshot.processes, port))
      : selected;

  const unique = [...new Map(targets.map((t) => [t.pid, t])).values()];

  if (unique.length === 0) {
    const what = options.ports.length > 0 ? `port ${options.ports.join(', ')}` : `pid ${options.pids.join(', ')}`;
    process.stderr.write(`${palette('yellow', `nothing to kill: no process matched ${what}`)}\n`);
    return 1;
  }

  const lines: string[] = [];
  for (const view of unique) {
    lines.push(...renderDetail(view, { palette, width, wide: true }));
    lines.push('');
  }
  process.stderr.write(`${lines.join('\n')}\n`);

  const note = signalNote(process.platform, options.signal);
  if (note) process.stderr.write(`${palette('yellow', '!')} ${palette('gray', note)}\n`);

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        `${palette('red', 'refusing to kill without a confirmation.')} There is no terminal to ask on; pass --yes if you meant it.\n`,
      );
      return 1;
    }
    const question = unique.map((view) => describeTarget(view, options.ports[0])).join('\n  ');
    const ok = await askYesNo(`kill ${unique.length === 1 ? '' : `${unique.length} processes:\n  `}${question}?`);
    if (!ok) {
      process.stderr.write('nothing was killed.\n');
      return 0;
    }
  }

  const outcomes = await killProcesses(unique, options.signal);
  let failures = 0;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      process.stdout.write(`${palette('green', 'signalled')} ${outcome.pid} with ${options.signal}\n`);
    } else {
      failures += 1;
      process.stderr.write(`${palette('red', 'failed')} ${outcome.pid}: ${outcome.error}\n`);
    }
  }
  return failures === 0 ? 0 : 1;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`whotop crashed: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 3;
    },
  );
}
