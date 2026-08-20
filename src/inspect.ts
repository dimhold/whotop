/**
 * Turns a raw collector result into the snapshot the CLI renders: ports joined
 * to their owners, roles classified, orphans detected, project names resolved.
 *
 * Everything here is pure apart from the optional project resolver and the
 * trace source, both of which are injected, so the whole join can be tested
 * against fixtures without a live process table.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classify } from './classify.js';
import { createCollector } from './collectors/index.js';
import { matchTrace, scanTracesForProcesses, traceIsInformative, TRACE_CAPABILITY_NOTE } from './traces.js';
import { exact, inferred, unavailable } from './types.js';
import type { TraceSource } from './traces.js';
import type {
  CollectResult,
  Collector,
  CollectorCapabilities,
  Field,
  PlatformId,
  PortBinding,
  ProcessView,
  RawProcess,
  Snapshot,
} from './types.js';

export type ProjectResolver = (cwd: string) => Field<string>;

export interface BuildOptions {
  readonly platform: PlatformId;
  readonly capabilities: CollectorCapabilities;
  readonly now?: Date;
  readonly resolveProject?: ProjectResolver;
  /** Traces already read off the disk. Absent means the question was not asked. */
  readonly traces?: TraceSource | null;
}

/** Index ports by owning pid, sorted so the listening ones come first. */
export function indexPortsByPid(ports: readonly PortBinding[]): Map<number, PortBinding[]> {
  const index = new Map<number, PortBinding[]>();
  for (const port of ports) {
    if (port.pid === null) continue;
    const list = index.get(port.pid);
    if (list) list.push(port);
    else index.set(port.pid, [port]);
  }
  for (const list of index.values()) {
    list.sort(
      (a, b) =>
        Number(b.state === 'listen') - Number(a.state === 'listen') ||
        a.port - b.port ||
        a.protocol.localeCompare(b.protocol),
    );
  }
  return index;
}

/**
 * A process is an orphan when its parent is gone.
 *
 * Two platform truths make this less obvious than it sounds. On Unix the
 * kernel reparents an orphan to pid 1, so ppid 1 is the signal. On Windows the
 * parent pid field keeps pointing at a number that the system is free to hand
 * to somebody else, so a parent that started after its child is a recycled
 * pid rather than a real parent.
 */
export function detectOrphan(
  process: RawProcess,
  byPid: ReadonlyMap<number, RawProcess>,
  platform: PlatformId,
): Field<boolean> {
  if (process.ppid === null) return unavailable('the parent pid was not reported');
  if (process.pid === 1) return exact(false);

  const parent = byPid.get(process.ppid);
  if (!parent) {
    return exact(true);
  }
  if (
    parent.startedAt !== null &&
    process.startedAt !== null &&
    parent.startedAt.getTime() > process.startedAt.getTime()
  ) {
    return inferred(
      true,
      `pid ${process.ppid} now belongs to a process that started later, so the real parent is gone`,
    );
  }
  if (platform !== 'win32' && process.ppid === 1) {
    return exact(true);
  }
  return exact(false);
}

const PROJECT_SEARCH_DEPTH = 4;

/** Nearest package.json name above the working directory. */
export const resolveProjectFromDisk: ProjectResolver = (cwd: string): Field<string> => {
  let dir = cwd;
  for (let depth = 0; depth < PROJECT_SEARCH_DEPTH; depth += 1) {
    const candidate = join(dir, 'package.json');
    try {
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown };
        if (typeof parsed.name === 'string' && parsed.name !== '') {
          return depth === 0
            ? exact(parsed.name)
            : inferred(parsed.name, `from package.json ${depth} level(s) above the working directory`);
        }
      }
    } catch {
      // Unreadable or malformed package.json: keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return unavailable('no package.json above the working directory');
};

export function buildSnapshot(result: CollectResult, options: BuildOptions): Snapshot {
  const now = options.now ?? new Date();
  const resolveProject = options.resolveProject ?? resolveProjectFromDisk;
  const portsByPid = indexPortsByPid(result.ports);
  const byPid = new Map(result.processes.map((p) => [p.pid, p]));

  const processes: ProcessView[] = result.processes.map((process) => {
    const ports = portsByPid.get(process.pid) ?? [];
    // Traces are a last resort, not a preference: they only speak where the
    // platform disclosed nothing, so a directory the OS actually reported is
    // never overwritten by a time correlation.
    let cwd = process.cwd;
    if (options.traces && cwd.value === null) {
      const outcome = matchTrace(process, options.traces);
      if (traceIsInformative(outcome)) cwd = outcome.field;
    }
    const classification = classify({
      name: process.name,
      exePath: process.exePath,
      commandLine: process.commandLine.value,
      cwd: cwd.value,
      ports,
    });
    const project =
      cwd.value !== null
        ? resolveProject(cwd.value)
        : unavailable<string>('the working directory is unknown, so the project cannot be resolved');

    return {
      ...process,
      cwd,
      classification,
      ports,
      orphan: detectOrphan(process, byPid, options.platform),
      ageMs: process.startedAt === null ? null : now.getTime() - process.startedAt.getTime(),
      project,
    };
  });

  const unowned = result.ports.filter((p) => p.pid === null).length;
  const warnings = [...result.warnings];
  if (unowned > 0) {
    warnings.push(`${unowned} socket(s) were reported without an owning process.`);
  }

  // Say under --explain that some rows were named by a directory rather than
  // by the process table, because that is a different kind of evidence.
  const capabilities = options.traces
    ? { ...options.capabilities, notes: [...options.capabilities.notes, TRACE_CAPABILITY_NOTE] }
    : options.capabilities;

  return {
    platform: options.platform,
    capturedAt: now,
    capabilities,
    processes,
    warnings,
  };
}

export interface InspectOptions {
  readonly collector?: Collector;
  readonly now?: Date;
  readonly resolveProject?: ProjectResolver;
  /** Pass a source to control the scan, or `null` to keep whotop off the disk. */
  readonly traces?: TraceSource | null;
}

/** Collect from the running machine and build a snapshot. */
export async function inspect(options: InspectOptions = {}): Promise<Snapshot> {
  const collector = options.collector ?? createCollector();
  const result = await collector.collect();
  // Undefined means "look if it is worth looking", which is decided by the
  // process table: no process a rule speaks for, no directory listing.
  const traces = options.traces === undefined ? scanTracesForProcesses(result.processes) : options.traces;
  return buildSnapshot(result, {
    platform: collector.platform,
    capabilities: collector.capabilities,
    traces,
    ...(options.now ? { now: options.now } : {}),
    ...(options.resolveProject ? { resolveProject: options.resolveProject } : {}),
  });
}
