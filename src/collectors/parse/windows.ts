/**
 * Parsers for the Windows collector.
 *
 * The collector runs one PowerShell script that emits a single JSON document
 * (see `collectors/windows.ts`). Parsing lives here, apart from the process
 * spawn, so the tests can feed it captured output instead of a live machine.
 */

import { unwrapShell } from '../../cmdline.js';
import { exact, inferred, unavailable } from '../../types.js';
import type { CollectResult, Field, PortBinding, Protocol, RawProcess } from '../../types.js';

export interface WindowsProcessRow {
  pid: number;
  ppid: number | null;
  name: string | null;
  exe: string | null;
  cmd: string | null;
  /** ISO 8601, from Win32_Process.CreationDate. */
  start: string | null;
}

export interface WindowsPortRow {
  addr: string | null;
  port: number;
  state: string | null;
  pid: number | null;
  proto: string | null;
}

export interface WindowsServiceRow {
  pid: number;
  /** Service key, e.g. `Dnscache`. */
  name: string | null;
  /** Friendly name, e.g. `DNS Client`. */
  label: string | null;
}

export interface WindowsPayload {
  processes?: WindowsProcessRow[] | null;
  ports?: WindowsPortRow[] | null;
  services?: WindowsServiceRow[] | null;
  warnings?: string[] | null;
}

/**
 * pid to service names, from Win32_Service.
 *
 * Worth having because it needs no elevation and it names processes that
 * Win32_Process refuses to describe. Measured on one 433 process machine:
 * of 29 processes that withheld a command line, 17 were services, including a
 * WireGuard tunnel and CloudflareWARP. Those rows used to read `unknown`.
 *
 * One pid can host several services, so the map holds a list. The service key
 * is preferred over the display name because it is what the rest of the system
 * calls the thing, and it is what a person types to stop it.
 */
export function buildServiceIndex(rows: readonly WindowsServiceRow[]): Map<number, string[]> {
  const index = new Map<number, string[]>();
  for (const row of rows) {
    if (typeof row?.pid !== 'number' || !Number.isFinite(row.pid) || row.pid <= 0) continue;
    const name = (row.name ?? row.label ?? '').trim();
    if (name === '') continue;
    const list = index.get(row.pid);
    if (list) list.push(name);
    else index.set(row.pid, [name]);
  }
  for (const list of index.values()) list.sort();
  return index;
}

const CMDLINE_DENIED =
  'Win32_Process withheld the command line for this process. It belongs to another user or runs elevated; try an elevated shell.';

/**
 * Windows does not expose another process's working directory through WMI at
 * all. Reading it would mean walking the PEB with ReadProcessMemory, which
 * needs matching bitness and debug rights and breaks on protected processes.
 * whotop does not pretend: it infers a directory from the command line when
 * the command line contains an absolute path, and labels it as inferred.
 */
export const WINDOWS_CWD_NOTE =
  'Windows does not expose the working directory of another process; this is inferred from the command line';

/**
 * The same sentence must not serve both outcomes. Reusing WINDOWS_CWD_NOTE as
 * the unavailable reason printed "this is inferred from the command line" on
 * rows that show no directory at all, which claims an inference that never
 * happened. Found 2026-08-19 on a real run: 164 of 433 processes read that way.
 */
export const WINDOWS_CWD_NO_CMDLINE =
  'Windows does not expose the working directory of another process, and its command line is not readable either, so there is nothing to infer from';

export const WINDOWS_CWD_NO_PATH =
  'Windows does not expose the working directory of another process, and its command line carries no absolute path to infer one from';

export const WINDOWS_CWD_ONLY_EXE =
  'Windows does not expose the working directory of another process, and the only absolute path in its command line is the executable itself, which says nothing about where it runs';

/** Directory of the first token, which is the program being run. */
function executableDirectory(source: string): string | null {
  const quoted = /^\s*"([^"]+)"/.exec(source);
  const first = quoted?.[1] ?? source.trim().split(/\s+/)[0];
  if (!first || !/^[a-z]:[\\/]/i.test(first)) return null;
  const cut = Math.max(first.lastIndexOf('\\'), first.lastIndexOf('/'));
  return cut > 2 ? first.slice(0, cut).replace(/[\\/]+$/, '').toLowerCase() : null;
}

const WINDOWS_ABS_PATH = /(?:^|[\s"'=])([a-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]*)/gi;

/**
 * Best effort working directory for Windows: the deepest directory that
 * appears as an absolute path in the command line, ignoring the runtime under
 * Program Files and anything inside node_modules, which is a package location
 * rather than a project.
 */
export function inferWindowsCwd(commandLine: string | null): Field<string> {
  if (!commandLine) return unavailable<string>(WINDOWS_CWD_NO_CMDLINE);

  // Anything spawned through cmd.exe hides its real command behind caret
  // escapes, and a path read out of those would come back mangled.
  const wrapper = unwrapShell(commandLine);
  const source = wrapper ? wrapper.inner : commandLine;

  const candidates: string[] = [];
  for (const match of source.matchAll(WINDOWS_ABS_PATH)) {
    const raw = match[1];
    if (!raw) continue;
    const cleaned = raw.replace(/[",]+$/, '');
    const dir = /[\\/]$/.test(cleaned) ? cleaned : cleaned.slice(0, Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/')));
    if (dir.length <= 3) continue;
    const lower = dir.toLowerCase();
    if (lower.includes('\\node_modules')) {
      const cut = lower.indexOf('\\node_modules');
      candidates.push(dir.slice(0, cut));
      continue;
    }
    if (lower.startsWith('c:\\windows')) continue;
    if (lower.startsWith('c:\\program files')) continue;
    candidates.push(dir.replace(/[\\/]+$/, ''));
  }

  /**
   * The directory a program lives in is not the directory it runs in.
   *
   * `C:\Users\me\.local\bin\claude.exe --resume` mentions exactly one absolute
   * path, its own, and reporting that as an inferred working directory made
   * five agent sessions look as though they were all working inside their
   * install folder. Nothing was false in the strict sense, the field was
   * marked inferred, and it was still useless and misleading.
   *
   * There is no honest substitute on Windows: the real value needs the PEB,
   * and the children of these sessions were checked and carry only tool
   * invocations, never the project. Saying nothing beats filling the column
   * with the install path.
   */
  const exeDir = executableDirectory(source);
  const useful = exeDir === null ? candidates : candidates.filter((dir) => dir.toLowerCase() !== exeDir);

  if (useful.length === 0) {
    return unavailable<string>(candidates.length === 0 ? WINDOWS_CWD_NO_PATH : WINDOWS_CWD_ONLY_EXE);
  }
  // The longest path is the most specific thing the command line mentions.
  const best = useful.reduce((a, b) => (b.length > a.length ? b : a));
  return inferred(best, WINDOWS_CWD_NOTE);
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseWindowsProcesses(
  rows: readonly WindowsProcessRow[],
  services: ReadonlyMap<number, string[]> = new Map(),
): RawProcess[] {
  const out: RawProcess[] = [];
  for (const row of rows) {
    if (typeof row?.pid !== 'number' || !Number.isFinite(row.pid)) continue;
    const cmd = row.cmd && row.cmd.trim() !== '' ? row.cmd : null;
    out.push({
      pid: row.pid,
      ppid: typeof row.ppid === 'number' && row.ppid > 0 ? row.ppid : null,
      name: row.name ?? String(row.pid),
      exePath: row.exe ?? null,
      commandLine: cmd ? exact(cmd) : unavailable(CMDLINE_DENIED),
      cwd: inferWindowsCwd(cmd),
      startedAt: parseDate(row.start),
      user: null,
      services: services.get(row.pid) ?? [],
    });
  }
  return out;
}

/** Get-NetTCPConnection reports states as words; normalise to lower case. */
export function normalizeWindowsState(state: string | null): string {
  if (!state) return 'unknown';
  const lower = state.toLowerCase();
  if (lower === 'listen' || lower === 'listening') return 'listen';
  if (lower === 'bound') return 'bound';
  return lower;
}

export function parseWindowsPorts(rows: readonly WindowsPortRow[]): PortBinding[] {
  const out: PortBinding[] = [];
  for (const row of rows) {
    if (typeof row?.port !== 'number' || !Number.isFinite(row.port)) continue;
    const proto: Protocol = row.proto === 'udp' ? 'udp' : 'tcp';
    out.push({
      protocol: proto,
      address: row.addr ?? '::',
      port: row.port,
      state: proto === 'udp' ? 'listen' : normalizeWindowsState(row.state),
      pid: typeof row.pid === 'number' && row.pid > 0 ? row.pid : null,
    });
  }
  return out;
}

/** Parse the whole JSON document the PowerShell helper prints. */
export function parseWindowsPayload(json: string): CollectResult {
  let payload: WindowsPayload;
  try {
    payload = JSON.parse(json) as WindowsPayload;
  } catch (error) {
    throw new Error(`could not parse the PowerShell output as JSON: ${(error as Error).message}`);
  }
  const processes = parseWindowsProcesses(payload.processes ?? [], buildServiceIndex(payload.services ?? []));
  const ports = parseWindowsPorts(payload.ports ?? []);
  const warnings = [...(payload.warnings ?? [])];

  const mute = processes.filter((p) => p.commandLine.source === 'unavailable');
  if (mute.length > 0) {
    // Say how many of the mute ones the service registry still named, because
    // "164 processes are unknown" and "164 withheld a command line, 100 of them
    // are named services" are very different sentences to read.
    const named = mute.filter((p) => p.services.length > 0).length;
    const rescued = named > 0 ? ` The service registry names ${named} of them anyway.` : '';
    warnings.push(
      `${mute.length} of ${processes.length} processes did not disclose a command line. Those belong to another user or run elevated; an elevated shell sees more.${rescued}`,
    );
  }
  return { processes, ports, warnings };
}
