/**
 * Programmatic entry point.
 *
 * `inspect()` gives the same snapshot the CLI renders, so whotop can be a
 * library inside a script that decides what to do about the processes it finds.
 */

export { inspect, buildSnapshot, detectOrphan, indexPortsByPid, resolveProjectFromDisk } from './inspect.js';
export type { BuildOptions, InspectOptions, ProjectResolver } from './inspect.js';

export { classify, RULES, ALL_ROLES, INTERESTING_ROLES } from './classify.js';
export type { ClassifyInput } from './classify.js';

export {
  TRACE_RULES,
  TRACE_WINDOW_MS,
  TRACE_TIE_MS,
  encodePathSegment,
  matchTrace,
  resolveSlugPath,
  rulesForProcess,
  scanTraces,
  scanTracesForProcesses,
  splitSlugRoot,
  traceIsInformative,
  traceJoin,
} from './traces.js';
export type {
  SlugResolution,
  TraceEntry,
  TraceEnv,
  TraceIo,
  TraceNames,
  TraceOutcome,
  TraceProblem,
  TraceRule,
  TraceSource,
} from './traces.js';

export { filterProcesses, holdersOfPort, sortProcesses, isDefaultVisible } from './filter.js';
export type { FilterOptions, SortKey } from './filter.js';

export { createCollector, UnsupportedPlatformError, WindowsCollector, LinuxCollector, DarwinCollector } from './collectors/index.js';

export { parseCommand, tokenize, normalizeForMatch } from './cmdline.js';
export type { CommandFacts } from './cmdline.js';

export { killProcesses, describeTarget, signalNote } from './kill.js';
export type { KillDeps, KillOutcome, KillSignal } from './kill.js';

export type {
  Classification,
  CollectorCapabilities,
  CollectResult,
  Collector,
  Field,
  FieldSource,
  PlatformId,
  PortBinding,
  ProcessView,
  Protocol,
  RawProcess,
  Role,
  RoleMatch,
  Snapshot,
} from './types.js';
