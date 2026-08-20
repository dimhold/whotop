import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWindowsPayload } from '../src/collectors/parse/windows.js';
import { buildSnapshot, detectOrphan, indexPortsByPid } from '../src/inspect.js';
import { unavailable } from '../src/types.js';
import type { Collector, RawProcess, Snapshot } from '../src/types.js';
import { inspect } from '../src/inspect.js';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/windows-collect.json', import.meta.url)), 'utf8');

const CAPABILITIES = {
  commandLine: 'partial',
  cwd: 'none',
  ports: 'full',
  user: 'none',
  notes: [],
} as const;

function snapshot(): Snapshot {
  return buildSnapshot(parseWindowsPayload(fixture), {
    platform: 'win32',
    capabilities: CAPABILITIES,
    now: new Date('2026-08-16T00:00:00.000Z'),
    // The fixture points at directories that do not exist here, so the project
    // resolver is stubbed rather than hitting the disk.
    resolveProject: () => unavailable<string>('stubbed in tests'),
  });
}

describe('indexPortsByPid', () => {
  it('groups ports under their owner and puts the listeners first', () => {
    const index = indexPortsByPid([
      { protocol: 'tcp', address: '::', port: 9000, state: 'established', pid: 5 },
      { protocol: 'tcp', address: '::', port: 4310, state: 'listen', pid: 5 },
      { protocol: 'tcp', address: '::', port: 80, state: 'listen', pid: 6 },
    ]);
    expect(index.get(5)?.map((p) => p.port)).toEqual([4310, 9000]);
    expect(index.get(6)).toHaveLength(1);
  });

  it('drops sockets with no owner rather than attributing them to pid 0', () => {
    const index = indexPortsByPid([{ protocol: 'udp', address: '::', port: 5353, state: 'listen', pid: null }]);
    expect(index.size).toBe(0);
  });
});

describe('detectOrphan', () => {
  const make = (pid: number, ppid: number | null, startedAt: Date | null): RawProcess => ({
    pid,
    ppid,
    name: 'node',
    exePath: null,
    commandLine: unavailable<string>('n/a'),
    cwd: unavailable<string>('n/a'),
    startedAt,
    user: null,
    services: [],
  });

  it('calls a process an orphan when the parent is not in the table', () => {
    const child = make(100, 900, new Date('2026-08-14T00:00:00Z'));
    const field = detectOrphan(child, new Map([[100, child]]), 'win32');
    expect(field.value).toBe(true);
  });

  it('treats a parent that started later as a recycled pid, not a parent', () => {
    const child = make(100, 200, new Date('2026-08-13T00:00:00Z'));
    const impostor = make(200, 1, new Date('2026-08-15T00:00:00Z'));
    const field = detectOrphan(child, new Map([[200, impostor]]), 'win32');
    expect(field.value).toBe(true);
    expect(field.source).toBe('inferred');
    expect(field.note).toMatch(/recycled|started later/);
  });

  it('treats reparenting to init as an orphan on unix', () => {
    const child = make(100, 1, new Date('2026-08-13T00:00:00Z'));
    const init = make(1, null, new Date('2026-08-01T00:00:00Z'));
    expect(detectOrphan(child, new Map([[1, init]]), 'linux').value).toBe(true);
  });

  it('does not call a live parent chain an orphan', () => {
    const parent = make(50, 1, new Date('2026-08-12T00:00:00Z'));
    const child = make(100, 50, new Date('2026-08-13T00:00:00Z'));
    expect(detectOrphan(child, new Map([[50, parent]]), 'win32').value).toBe(false);
  });

  it('says unknown when the platform gave no parent pid', () => {
    const child = make(100, null, null);
    const field = detectOrphan(child, new Map(), 'linux');
    expect(field.value).toBeNull();
    expect(field.source).toBe('unavailable');
  });
});

describe('buildSnapshot', () => {
  const snap = snapshot();
  const byPid = new Map(snap.processes.map((p) => [p.pid, p]));

  it('attaches the ports a process holds', () => {
    expect(byPid.get(9120)?.ports.map((p) => p.port)).toEqual([4310, 4310]);
  });

  it('classifies the dev server that holds the port', () => {
    expect(byPid.get(9120)?.classification.role).toBe('dev-server');
  });

  it('finds the orphaned dev server whose parent pid was recycled', () => {
    const orphan = byPid.get(9412);
    expect(orphan?.orphan.value).toBe(true);
    expect(orphan?.ports.map((p) => p.port)).toEqual([4311]);
  });

  it('separates the automation Chrome processes from the ordinary one', () => {
    expect(byPid.get(9800)?.classification.role).toBe('browser-automation');
    expect(byPid.get(9801)?.classification.role).toBe('browser-automation');
    expect(byPid.get(9802)?.classification.role).toBe('unknown');
  });

  it('computes an age from the start time', () => {
    expect(byPid.get(9120)?.ageMs).toBe(
      new Date('2026-08-16T00:00:00.000Z').getTime() - new Date('2026-08-14T09:02:11.450Z').getTime(),
    );
  });

  it('carries the collector warnings through untouched, and adds the unowned sockets', () => {
    expect(snap.warnings.join(' ')).toMatch(/did not disclose a command line/);
    expect(snap.warnings.join(' ')).toMatch(/1 socket\(s\) were reported without an owning process/);
  });
});

describe('inspect', () => {
  it('uses the collector it is given, so it can run anywhere', async () => {
    const collector: Collector = {
      platform: 'win32',
      capabilities: CAPABILITIES,
      collect: async () => parseWindowsPayload(fixture),
    };
    const snap = await inspect({ collector, resolveProject: () => unavailable<string>('stubbed') });
    expect(snap.platform).toBe('win32');
    expect(snap.processes.length).toBe(14);
  });
});
