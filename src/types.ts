/**
 * Core data model.
 *
 * A guiding rule for the whole tool: every datum that an operating system may
 * refuse to hand over is wrapped in {@link Field}, so the renderer can say
 * "unavailable, and here is why" instead of printing a confident guess.
 */

export type PlatformId = 'win32' | 'linux' | 'darwin';

/** Where a value came from, and therefore how much it can be trusted. */
export type FieldSource =
  /** Read straight from the kernel or an OS API. */
  | 'exact'
  /** Derived from something else we could read (usually the command line). */
  | 'inferred'
  /** The OS has it but would not give it to us. `note` says why. */
  | 'unavailable';

export interface Field<T> {
  readonly value: T | null;
  readonly source: FieldSource;
  /** Short human sentence: why it is inferred, or why it is missing. */
  readonly note?: string;
}

export const exact = <T>(value: T): Field<T> => ({ value, source: 'exact' });
export const inferred = <T>(value: T, note: string): Field<T> => ({ value, source: 'inferred', note });
export const unavailable = <T>(note: string): Field<T> => ({ value: null, source: 'unavailable', note });

export type Protocol = 'tcp' | 'udp';

export interface PortBinding {
  readonly protocol: Protocol;
  /** Local address as the OS reported it: `0.0.0.0`, `::`, `127.0.0.1`, ... */
  readonly address: string;
  readonly port: number;
  /** Normalised lower-case state. Listening sockets are `listen`. */
  readonly state: string;
  /** Owning process, when the OS disclosed it. */
  readonly pid: number | null;
}

/** One process, as the platform collector saw it. Nothing derived yet. */
export interface RawProcess {
  readonly pid: number;
  readonly ppid: number | null;
  /** Executable name, e.g. `node.exe`, `node`, `python3.12`. */
  readonly name: string;
  readonly exePath: string | null;
  readonly commandLine: Field<string>;
  readonly cwd: Field<string>;
  readonly startedAt: Date | null;
  readonly user: string | null;
  /**
   * Names the operating system's own service registry gives this pid.
   *
   * Deliberately a plain array and not a {@link Field}: the registry is
   * readable without privileges, so an empty list means "this process is not a
   * service", which is an answer rather than a refusal. When the registry
   * itself could not be read the collector says so in `warnings` and every
   * process comes back with an empty list, which is the honest degradation.
   *
   * A single pid can host several services. svchost.exe routinely hosts four.
   */
  readonly services: readonly string[];
}

export type Role =
  | 'agent-session'
  | 'mcp-server'
  | 'browser-automation'
  | 'dev-server'
  | 'test-runner'
  | 'watcher'
  | 'build'
  | 'language-server'
  | 'package-manager'
  | 'database'
  | 'container'
  | 'tunnel'
  | 'editor'
  | 'repl'
  | 'runtime'
  | 'unknown';

export interface RoleMatch {
  readonly ruleId: string;
  readonly role: Role;
  /** 0..1. Higher wins when several rules fire. */
  readonly confidence: number;
  /** The evidence, phrased for a human: what in the command line matched. */
  readonly reason: string;
}

export interface Classification {
  readonly role: Role;
  readonly confidence: number;
  readonly reason: string;
  /** Every rule that fired, strongest first. */
  readonly matches: readonly RoleMatch[];
  /** Short label for the row: `vite dev`, `pytest`, `chrome-devtools-mcp`. */
  readonly label: string | null;
}

/** A process after ports, classification and lineage have been folded in. */
export interface ProcessView extends RawProcess {
  readonly classification: Classification;
  readonly ports: readonly PortBinding[];
  readonly orphan: Field<boolean>;
  readonly ageMs: number | null;
  /** `name` from the nearest package.json above the working directory. */
  readonly project: Field<string>;
}

export interface CollectorCapabilities {
  readonly commandLine: 'full' | 'partial' | 'none';
  readonly cwd: 'full' | 'partial' | 'none';
  readonly ports: 'full' | 'partial' | 'none';
  readonly user: 'full' | 'partial' | 'none';
  /** One line per limitation, printed under `--explain`. */
  readonly notes: readonly string[];
}

export interface CollectResult {
  readonly processes: readonly RawProcess[];
  readonly ports: readonly PortBinding[];
  /** Non-fatal problems: a missing helper binary, a partial read, a denial. */
  readonly warnings: readonly string[];
}

export interface Collector {
  readonly platform: PlatformId;
  readonly capabilities: CollectorCapabilities;
  collect(): Promise<CollectResult>;
}

export interface Snapshot {
  readonly platform: PlatformId;
  readonly capturedAt: Date;
  readonly capabilities: CollectorCapabilities;
  readonly processes: readonly ProcessView[];
  readonly warnings: readonly string[];
}
