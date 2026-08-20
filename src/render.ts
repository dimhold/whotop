/**
 * Terminal rendering. The layout answers, in order, the four questions the
 * tool exists for: which process, what is it, which ports, and where was it
 * started from.
 */

import { parseCommand } from './cmdline.js';
import { padEndVisible, padStartVisible, visibleLength } from './color.js';
import type { ColorName, Palette } from './color.js';
import type { Field, PortBinding, ProcessView, Role, Snapshot } from './types.js';

export interface RenderOptions {
  readonly palette: Palette;
  readonly width: number;
  /** One line per process, command line truncated. */
  readonly compact?: boolean;
  /** Never truncate the command line, wrap it instead. */
  readonly wide?: boolean;
  /** Print the rule that produced each role. */
  readonly explain?: boolean;
}

const ROLE_COLORS: Record<Role, ColorName> = {
  'agent-session': 'brightMagenta',
  'mcp-server': 'brightCyan',
  'browser-automation': 'magenta',
  'dev-server': 'brightGreen',
  'test-runner': 'brightYellow',
  watcher: 'yellow',
  build: 'blue',
  'language-server': 'cyan',
  'package-manager': 'blue',
  database: 'brightBlue',
  container: 'blue',
  tunnel: 'magenta',
  editor: 'gray',
  repl: 'gray',
  runtime: 'gray',
  unknown: 'gray',
};

export function formatAge(ageMs: number | null): string {
  if (ageMs === null) return '?';
  if (ageMs < 0) return '0s';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatPorts(ports: readonly PortBinding[]): string {
  const listening = ports.filter((p) => p.state === 'listen');
  if (listening.length === 0) return '';
  const unique = [...new Set(listening.map((p) => p.port))].sort((a, b) => a - b);
  const shown = unique.slice(0, 4).join(' ');
  return unique.length > 4 ? `${shown} +${unique.length - 4}` : shown;
}

function fieldSuffix(field: Field<unknown>, palette: Palette): string {
  if (field.source === 'inferred') return ' ' + palette('dim', '(inferred)');
  return '';
}

/** Wrap text to `width`, indenting every line after the first by `indent`. */
export function wrap(text: string, width: number, indent: number): string[] {
  if (width <= indent + 8) return [text];
  const lines: string[] = [];
  let remaining = text;
  let limit = width;
  while (visibleLength(remaining) > limit) {
    let cut = remaining.lastIndexOf(' ', limit);
    if (cut <= indent) cut = limit;
    lines.push(remaining.slice(0, cut));
    remaining = ' '.repeat(indent) + remaining.slice(cut).trimStart();
    limit = width;
  }
  lines.push(remaining);
  return lines;
}

function truncate(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return text.slice(0, Math.max(0, width));
  return text.slice(0, width - 1) + '…';
}

interface Columns {
  readonly pid: number;
  readonly role: number;
  readonly label: number;
  readonly ports: number;
  readonly age: number;
}

function measure(processes: readonly ProcessView[]): Columns {
  const max = (values: number[]): number => values.reduce((a, b) => Math.max(a, b), 0);
  return {
    pid: Math.max(3, max(processes.map((p) => String(p.pid).length))),
    role: Math.max(4, max(processes.map((p) => p.classification.role.length))),
    label: Math.min(28, Math.max(4, max(processes.map((p) => (p.classification.label ?? '').length)))),
    ports: Math.max(5, max(processes.map((p) => formatPorts(p.ports).length))),
    age: Math.max(3, max(processes.map((p) => formatAge(p.ageMs).length))),
  };
}

function flagsOf(view: ProcessView, palette: Palette): string {
  const flags: string[] = [];
  if (view.orphan.value === true) flags.push(palette('brightRed', 'orphan'));
  if (view.commandLine.source === 'unavailable') flags.push(palette('gray', 'no cmdline'));
  return flags.join(' ');
}

function headLine(view: ProcessView, columns: Columns, palette: Palette): string {
  const role = view.classification.role;
  return [
    palette('bold', padStartVisible(String(view.pid), columns.pid)),
    padEndVisible(palette(ROLE_COLORS[role], role), columns.role),
    padEndVisible(palette('white', truncate(view.classification.label ?? '', columns.label)), columns.label),
    padStartVisible(palette('brightGreen', formatPorts(view.ports)), columns.ports),
    padStartVisible(palette('dim', formatAge(view.ageMs)), columns.age),
    flagsOf(view, palette),
  ]
    .join('  ')
    .trimEnd();
}

export function renderProcesses(processes: readonly ProcessView[], options: RenderOptions): string[] {
  if (processes.length === 0) return [];
  const { palette, width } = options;
  const columns = measure(processes);
  const lines: string[] = [];

  for (const view of processes) {
    lines.push(headLine(view, columns, palette));
    if (options.compact) continue;

    const indent = columns.pid + 2;
    const pad = ' '.repeat(indent);

    const cwd = view.cwd.value;
    if (cwd) {
      const project = view.project.value ? palette('dim', `  [${view.project.value}]`) : '';
      lines.push(`${pad}${palette('dim', 'cwd')} ${palette('cyan', cwd)}${fieldSuffix(view.cwd, palette)}${project}`);
    } else if (view.cwd.note) {
      lines.push(`${pad}${palette('dim', 'cwd')} ${palette('gray', view.cwd.note)}`);
    }

    const cmd = view.commandLine.value;
    if (cmd) {
      const body = `${pad}${palette('dim', 'cmd')} ${cmd}`;
      if (options.wide) lines.push(...wrap(body, width, indent + 4));
      else lines.push(truncate(body, width));

      // A command spawned through a shell hides the real one inside quoting.
      const facts = parseCommand(cmd);
      if (facts.shell !== null && facts.effective !== cmd) {
        const run = `${pad}${palette('dim', 'run')} ${palette('white', facts.effective)}`;
        if (options.wide) lines.push(...wrap(run, width, indent + 4));
        else lines.push(truncate(run, width));
      }
    } else if (view.commandLine.note) {
      lines.push(`${pad}${palette('dim', 'cmd')} ${palette('gray', view.commandLine.note)}`);
    }

    if (options.explain) {
      lines.push(
        `${pad}${palette('dim', 'why')} ${palette('gray', view.classification.reason)}` +
          palette('dim', ` [${view.classification.matches[0]?.ruleId ?? 'none'}]`),
      );
      if (view.orphan.value === true && view.orphan.note) {
        lines.push(`${pad}${palette('dim', 'orp')} ${palette('gray', view.orphan.note)}`);
      }
      // A directory that was inferred is a claim, so under --explain it has to
      // name what it was inferred from. The row above only shows the path.
      if (view.cwd.value !== null && view.cwd.source === 'inferred' && view.cwd.note) {
        lines.push(...wrap(`${pad}${palette('dim', 'via')} ${palette('gray', view.cwd.note)}`, width, indent + 4));
      }
    }
  }
  return lines;
}

/** The long form used by `whotop port N` and `whotop kill`. */
export function renderDetail(view: ProcessView, options: RenderOptions): string[] {
  const { palette, width } = options;
  const lines: string[] = [];
  const label = view.classification.label ? ` ${view.classification.label}` : '';
  lines.push(
    `${palette('bold', String(view.pid))}  ${palette(ROLE_COLORS[view.classification.role], view.classification.role)}${palette('white', label)}`,
  );

  const row = (key: string, value: string): void => {
    lines.push(`  ${palette('dim', padEndVisible(key, 9))} ${value}`);
  };

  row('name', view.name);
  row('started', view.startedAt ? `${view.startedAt.toISOString()}  ${palette('dim', `(${formatAge(view.ageMs)} ago)`)}` : palette('gray', 'unknown'));
  row('parent', view.ppid === null ? palette('gray', 'unknown') : String(view.ppid));
  if (view.orphan.value === true) {
    row('orphan', palette('brightRed', 'yes') + (view.orphan.note ? ` ${palette('gray', view.orphan.note)}` : ''));
  }
  if (view.user) row('user', view.user);
  row(
    'cwd',
    view.cwd.value
      ? palette('cyan', view.cwd.value) + fieldSuffix(view.cwd, palette)
      : palette('gray', view.cwd.note ?? 'unavailable'),
  );
  if (view.project.value) row('project', view.project.value);

  if (view.ports.length > 0) {
    const rendered = view.ports
      .map((p) => `${p.protocol}/${p.address}:${palette('brightGreen', String(p.port))} ${palette('dim', p.state)}`)
      .join('\n' + ' '.repeat(12));
    row('ports', rendered);
  }

  row('why', palette('gray', view.classification.reason));
  const cmd = view.commandLine.value ?? palette('gray', view.commandLine.note ?? 'unavailable');
  lines.push(`  ${palette('dim', 'cmd')}`);
  lines.push(...wrap(`    ${cmd}`, width, 4));
  return lines;
}

export function renderHeader(snapshot: Snapshot, shown: number, palette: Palette): string {
  const total = snapshot.processes.length;
  return [
    palette('bold', 'whotop'),
    palette('dim', snapshot.platform),
    `${palette('white', String(shown))}${palette('dim', ` of ${total} processes`)}`,
    palette('dim', snapshot.capturedAt.toTimeString().slice(0, 8)),
  ].join('  ');
}

export function renderWarnings(warnings: readonly string[], palette: Palette, width: number): string[] {
  const lines: string[] = [];
  for (const warning of warnings) {
    lines.push(...wrap(`${palette('yellow', '!')} ${palette('gray', warning)}`, width, 2));
  }
  return lines;
}

export function renderCapabilities(snapshot: Snapshot, palette: Palette, width: number): string[] {
  const caps = snapshot.capabilities;
  const lines: string[] = [palette('bold', `what ${snapshot.platform} will and will not tell whotop`)];
  const mark = (level: 'full' | 'partial' | 'none'): string =>
    level === 'full' ? palette('green', 'full') : level === 'partial' ? palette('yellow', 'partial') : palette('red', 'none');
  lines.push(`  command line  ${mark(caps.commandLine)}`);
  lines.push(`  working dir   ${mark(caps.cwd)}`);
  lines.push(`  ports         ${mark(caps.ports)}`);
  lines.push(`  user          ${mark(caps.user)}`);
  for (const note of caps.notes) {
    lines.push(...wrap(`  ${palette('dim', '-')} ${palette('gray', note)}`, width, 4));
  }
  return lines;
}
