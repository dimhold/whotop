/**
 * The surface `import { ... } from 'whotop'` gets.
 *
 * `src/index.ts` is a list of re-exports and nothing else, which is exactly
 * the kind of file that is never opened and never noticed when something falls
 * out of it. Deleting a name here is a breaking change for anybody using
 * whotop as a library, and there is no compiler error to warn about it: the
 * package still builds, still passes every other test, and the import fails
 * only on somebody else's machine.
 *
 * So the surface is written down. A new export means a line added here, which
 * is a deliberate act; a removed one means a line failing, which is a
 * deliberate decision rather than an accident.
 */
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
// Not from the package: the Field constructors are internal, which is worth
// noticing, since every uncertain value a consumer builds is a Field.
import { exact } from '../src/types.js';

/** Everything the package promises, in the order index.ts declares it. */
const PROMISED = [
  // The snapshot, and the pieces that build one.
  'inspect',
  'buildSnapshot',
  'detectOrphan',
  'indexPortsByPid',
  'resolveProjectFromDisk',

  // Classification.
  'classify',
  'RULES',
  'ALL_ROLES',
  'INTERESTING_ROLES',

  // Naming a process by what it left on disk.
  'TRACE_RULES',
  'TRACE_WINDOW_MS',
  'TRACE_TIE_MS',
  'encodePathSegment',
  'matchTrace',
  'resolveSlugPath',
  'rulesForProcess',
  'scanTraces',
  'scanTracesForProcesses',
  'splitSlugRoot',
  'traceIsInformative',
  'traceJoin',

  // Selecting and ordering.
  'filterProcesses',
  'holdersOfPort',
  'sortProcesses',
  'isDefaultVisible',

  // Reading the machine.
  'createCollector',
  'UnsupportedPlatformError',
  'WindowsCollector',
  'LinuxCollector',
  'DarwinCollector',

  // Command lines.
  'parseCommand',
  'tokenize',
  'normalizeForMatch',

  // Killing.
  'killProcesses',
  'describeTarget',
  'signalNote',
] as const;

describe('the public API', () => {
  it('exports everything it promises', () => {
    const missing = PROMISED.filter((name) => !(name in api));
    expect(missing).toEqual([]);
  });

  it('exports nothing it has not promised', () => {
    const extra = Object.keys(api).filter((name) => !(PROMISED as readonly string[]).includes(name));
    expect(extra).toEqual([]);
  });

  it('exports each of them as something callable or usable', () => {
    for (const name of PROMISED) {
      expect(api[name], name).toBeDefined();
    }
  });

  /**
   * The reason the library exists: a script can get the same snapshot the CLI
   * renders and decide for itself what to do about it. If this composition
   * stops working, the package is a CLI that happens to ship type definitions.
   */
  it('composes into a snapshot without a terminal anywhere near it', () => {
    const collector = api.createCollector('linux');
    const snapshot = api.buildSnapshot(
      {
        processes: [
          {
            pid: 4310,
            ppid: 1,
            name: 'node',
            exePath: '/usr/bin/node',
            commandLine: exact('node vite.js dev --port 4310'),
            cwd: exact('/home/dev/projects/shop-web'),
            startedAt: new Date('2026-08-20T09:00:00.000Z'),
            user: 'dev',
            services: [],
          },
        ],
        ports: [{ protocol: 'tcp', address: '::', port: 4310, state: 'listen', pid: 4310 }],
        warnings: [],
      },
      {
        platform: 'linux',
        capabilities: collector.capabilities,
        now: new Date('2026-08-20T12:00:00.000Z'),
        resolveProject: () => exact('shop-web'),
        traces: null,
      },
    );

    const [view] = snapshot.processes;
    expect(view?.classification.role).toBe('dev-server');
    expect(view?.ports[0]?.port).toBe(4310);
    expect(view?.orphan.value).toBe(true);
    expect(api.holdersOfPort(snapshot.processes, 4310).map((p) => p.pid)).toEqual([4310]);
    expect(api.isDefaultVisible(view!)).toBe(true);
  });
});

describe('createCollector', () => {
  it('picks the collector for each platform it supports', () => {
    expect(api.createCollector('win32')).toBeInstanceOf(api.WindowsCollector);
    expect(api.createCollector('linux')).toBeInstanceOf(api.LinuxCollector);
    expect(api.createCollector('darwin')).toBeInstanceOf(api.DarwinCollector);
  });

  it('names its own platform', () => {
    expect(api.createCollector('win32').platform).toBe('win32');
    expect(api.createCollector('linux').platform).toBe('linux');
    expect(api.createCollector('darwin').platform).toBe('darwin');
  });

  /**
   * Everything except process and port enumeration is platform independent, so
   * the error says that: a new collector is the only piece missing, rather than
   * whotop being unable to work there in principle.
   */
  it('refuses a platform it has no collector for, and says what is missing', () => {
    expect(() => api.createCollector('aix' as NodeJS.Platform)).toThrow(api.UnsupportedPlatformError);
    try {
      api.createCollector('sunos' as NodeJS.Platform);
    } catch (error) {
      expect((error as Error).message).toContain('sunos');
      expect((error as Error).message).toContain('win32, linux, darwin');
      expect((error as api.UnsupportedPlatformError).received).toBe('sunos');
    }
  });
});

describe('what each collector says it can and cannot see', () => {
  /**
   * These are a promise printed under --explain, and getting one wrong is the
   * same failure as an inferred value presented as read: it tells somebody the
   * blank field is their problem when it is the platform's.
   */
  it('admits that Windows cannot give a working directory', () => {
    const caps = api.createCollector('win32').capabilities;
    expect(caps.cwd).toBe('none');
    expect(caps.ports).toBe('full');
    expect(caps.notes.join(' ')).toContain('Win32_Process');
  });

  it('says Linux can give one, from /proc', () => {
    const caps = api.createCollector('linux').capabilities;
    expect(caps.cwd).not.toBe('none');
    expect(caps.notes.join(' ')).toContain('/proc');
  });

  it('says macOS needs lsof for it', () => {
    const caps = api.createCollector('darwin').capabilities;
    expect(caps.notes.join(' ')).toContain('lsof');
  });

  it('always has something to say about every field', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const caps = api.createCollector(platform).capabilities;
      for (const field of [caps.commandLine, caps.cwd, caps.ports, caps.user]) {
        expect(['full', 'partial', 'none']).toContain(field);
      }
      expect(caps.notes.length).toBeGreaterThan(0);
    }
  });
});
