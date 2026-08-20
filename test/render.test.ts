import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/color.js';
import { createPalette } from '../src/color.js';
import {
  renderCapabilities,
  renderDetail,
  renderHeader,
  renderProcesses,
  renderWarnings,
} from '../src/render.js';
import { exact, inferred, unavailable } from '../src/types.js';
import type { PortBinding, ProcessView, Snapshot } from '../src/types.js';

/** Colour off, so the assertions read the plain text the layout produces. */
const palette = createPalette(false);
const width = 120;

const listen = (port: number): PortBinding => ({
  protocol: 'tcp',
  address: '::',
  port,
  state: 'listen',
  pid: 9120,
});

const view = (over: Partial<ProcessView> = {}): ProcessView => ({
  pid: 9120,
  ppid: 6104,
  name: 'node.exe',
  exePath: 'C:\\Program Files\\nodejs\\node.exe',
  commandLine: exact('"node" "C:\\Users\\dev\\projects\\shop-web\\node_modules\\vite\\bin\\vite.js" dev --port 4310'),
  cwd: exact('C:\\Users\\dev\\projects\\shop-web'),
  startedAt: new Date('2026-08-14T09:02:11.450Z'),
  user: null,
  services: [],
  classification: {
    role: 'dev-server',
    confidence: 0.78,
    reason: 'known dev server in the command line (vite)',
    matches: [{ ruleId: 'dev-server-tool', role: 'dev-server', confidence: 0.78, reason: 'vite' }],
    label: 'vite',
  },
  ports: [listen(4310)],
  orphan: exact(false),
  ageMs: 3 * 3_600_000,
  project: exact('shop-web'),
  ...over,
});

describe('renderProcesses', () => {
  it('puts pid, role, label, port and age on the head line', () => {
    const [head] = renderProcesses([view()], { palette, width, compact: true });
    expect(head).toContain('9120');
    expect(head).toContain('dev-server');
    expect(head).toContain('vite');
    expect(head).toContain('4310');
    expect(head).toContain('3h');
  });

  it('flags an orphan on the head line', () => {
    const [head] = renderProcesses([view({ orphan: exact(true) })], { palette, width, compact: true });
    expect(head).toContain('orphan');
  });

  it('flags a withheld command line and prints its note instead of a cmd', () => {
    const lines = renderProcesses(
      [
        view({
          commandLine: unavailable<string>('Win32_Process withheld the command line for this process.'),
        }),
      ],
      { palette, width },
    );
    const text = lines.join('\n');
    expect(text).toContain('no cmdline');
    expect(text).toContain('withheld the command line');
  });

  it('compact mode prints one line per process and no detail', () => {
    const lines = renderProcesses([view()], { palette, width, compact: true });
    expect(lines).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('cwd');
  });

  it('shows the working directory, the project tag and the command by default', () => {
    const text = renderProcesses([view()], { palette, width }).join('\n');
    expect(text).toContain('cwd C:\\Users\\dev\\projects\\shop-web');
    expect(text).toContain('[shop-web]');
    expect(text).toContain('cmd ');
    expect(text).toContain('vite.js');
  });

  it('marks an inferred working directory', () => {
    const text = renderProcesses(
      [view({ cwd: inferred('C:\\Users\\dev\\projects\\shop-web', 'inferred from the command line') })],
      { palette, width },
    ).join('\n');
    expect(text).toContain('(inferred)');
  });

  it('unwraps a shell command into a separate run line', () => {
    const text = renderProcesses(
      [
        view({
          commandLine: exact('C:\\Windows\\system32\\cmd.exe /d /s /c "npx ^"chrome-devtools-mcp^""'),
        }),
      ],
      { palette, width, wide: true },
    ).join('\n');
    expect(text).toContain('run ');
    expect(text).toContain('npx "chrome-devtools-mcp"');
  });

  it('explain mode adds the rule reason and the orphan note', () => {
    const text = renderProcesses(
      [
        view({
          orphan: inferred(true, 'pid 6104 now belongs to a process that started later'),
        }),
      ],
      { palette, width, explain: true },
    ).join('\n');
    expect(text).toContain('why known dev server');
    expect(text).toContain('[dev-server-tool]');
    expect(text).toContain('orp ');
    expect(text).toContain('started later');
  });
});

describe('renderDetail', () => {
  it('lays out every field a human needs before killing the process', () => {
    const text = renderDetail(view({ orphan: exact(true) }), { palette, width, wide: true }).join('\n');
    expect(text).toContain('9120');
    expect(text).toContain('dev-server vite');
    expect(text).toContain('name');
    expect(text).toContain('started');
    expect(text).toContain('parent');
    expect(text).toContain('orphan');
    expect(text).toContain('cwd');
    expect(text).toContain('project');
    expect(text).toContain('ports');
    expect(text).toContain('4310');
    expect(text).toContain('why');
    expect(text).toContain('cmd');
  });

  it('prints the note when the command line was withheld', () => {
    const text = renderDetail(view({ commandLine: unavailable<string>('withheld by the OS') }), {
      palette,
      width,
    }).join('\n');
    expect(text).toContain('withheld by the OS');
  });
});

describe('renderHeader', () => {
  it('summarises how many of how many processes are shown', () => {
    const snapshot = {
      platform: 'win32',
      capturedAt: new Date('2026-08-16T13:45:07.000Z'),
      capabilities: { commandLine: 'partial', cwd: 'none', ports: 'full', user: 'none', notes: [] },
      processes: [view(), view({ pid: 1 })],
      warnings: [],
    } satisfies Snapshot;
    const header = stripAnsi(renderHeader(snapshot, 1, palette));
    expect(header).toContain('whotop');
    expect(header).toContain('win32');
    expect(header).toContain('1');
    expect(header).toContain('of 2 processes');
  });
});

describe('renderWarnings', () => {
  it('prefixes each warning with a marker', () => {
    const lines = renderWarnings(['2 of 14 processes did not disclose a command line.'], palette, width);
    expect(lines.join('\n')).toContain('! ');
    expect(lines.join('\n')).toContain('did not disclose');
  });
});

describe('renderCapabilities', () => {
  it('grades what the platform will tell whotop and lists the caveats', () => {
    const snapshot = {
      platform: 'win32',
      capturedAt: new Date(),
      capabilities: {
        commandLine: 'partial',
        cwd: 'none',
        ports: 'full',
        user: 'none',
        notes: ['Windows does not expose the working directory of another process.'],
      },
      processes: [],
      warnings: [],
    } satisfies Snapshot;
    const text = renderCapabilities(snapshot, palette, width).join('\n');
    expect(text).toContain('command line  partial');
    expect(text).toContain('working dir   none');
    expect(text).toContain('ports         full');
    expect(text).toContain('does not expose the working directory');
  });
});
