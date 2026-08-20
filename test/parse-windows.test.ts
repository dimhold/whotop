import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildServiceIndex,
  inferWindowsCwd,
  normalizeWindowsState,
  parseWindowsPayload,
  parseWindowsPorts,
  parseWindowsProcesses,
} from '../src/collectors/parse/windows.js';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/windows-collect.json', import.meta.url)), 'utf8');

describe('parseWindowsPayload', () => {
  const result = parseWindowsPayload(fixture);

  it('reads every process row', () => {
    expect(result.processes).toHaveLength(14);
    expect(result.processes.map((p) => p.pid)).toContain(9120);
  });

  it('marks a withheld command line as unavailable and explains why', () => {
    const system = result.processes.find((p) => p.pid === 4);
    expect(system?.commandLine.value).toBeNull();
    expect(system?.commandLine.source).toBe('unavailable');
    expect(system?.commandLine.note).toMatch(/elevated/);
  });

  it('warns about how many command lines were withheld instead of hiding it', () => {
    expect(result.warnings.join(' ')).toMatch(/2 of 14 processes did not disclose a command line/);
  });

  it('parses creation dates into real timestamps', () => {
    const vite = result.processes.find((p) => p.pid === 9120);
    expect(vite?.startedAt?.toISOString()).toBe('2026-08-14T09:02:11.450Z');
  });
});

describe('parseWindowsPorts', () => {
  const ports = parseWindowsPayload(fixture).ports;

  it('maps a port to its owning pid', () => {
    const held = ports.filter((p) => p.port === 4310);
    expect(held).toHaveLength(2);
    expect(new Set(held.map((p) => p.pid))).toEqual(new Set([9120]));
  });

  it('normalises connection states', () => {
    expect(normalizeWindowsState('Listen')).toBe('listen');
    expect(normalizeWindowsState('Established')).toBe('established');
    expect(normalizeWindowsState(null)).toBe('unknown');
  });

  it('treats a UDP endpoint as listening, because Windows reports no state for it', () => {
    const udp = ports.find((p) => p.protocol === 'udp');
    expect(udp?.state).toBe('listen');
  });

  it('drops the pid when Windows reports 0, rather than inventing an owner', () => {
    const udp = ports.find((p) => p.protocol === 'udp');
    expect(udp?.pid).toBeNull();
  });

  it('skips malformed rows instead of throwing', () => {
    const bad = parseWindowsPorts([
      { addr: '::', port: Number.NaN, state: 'Listen', pid: 1, proto: 'tcp' },
      { addr: '::', port: 8080, state: 'Listen', pid: 2, proto: 'tcp' },
    ]);
    expect(bad).toHaveLength(1);
  });
});

describe('inferWindowsCwd', () => {
  it('infers a project directory from an absolute path in the command line', () => {
    const field = inferWindowsCwd(
      '"node" "C:\\Users\\dev\\projects\\shop-web\\node_modules\\vite\\bin\\vite.js" dev',
    );
    expect(field.value).toBe('C:\\Users\\dev\\projects\\shop-web');
    expect(field.source).toBe('inferred');
  });

  it('unwraps a cmd.exe command before looking for paths', () => {
    const field = inferWindowsCwd(
      'C:\\Windows\\system32\\cmd.exe /d /s /c "node ^"C:\\Users\\dev\\projects\\api\\server.js^""',
    );
    expect(field.value).toBe('C:\\Users\\dev\\projects\\api');
  });

  it('ignores the runtime under Program Files and the Windows directory', () => {
    const field = inferWindowsCwd('"C:\\Program Files\\nodejs\\node.exe"');
    expect(field.value).toBeNull();
    expect(field.source).toBe('unavailable');
  });

  it('says the value is unavailable rather than guessing when there is no path', () => {
    const field = inferWindowsCwd('node');
    expect(field.source).toBe('unavailable');
    expect(field.note).toMatch(/does not expose the working directory/);
  });

  it('returns unavailable when there is no command line at all', () => {
    expect(inferWindowsCwd(null).source).toBe('unavailable');
  });

  /**
   * An unavailable row must not claim an inference it did not make. One string
   * used to serve both outcomes, so 164 of 433 processes on a real run printed
   * "this is inferred from the command line" beside no directory at all. The
   * older assertion above matched only the shared opening clause, which is
   * true of the misleading wording too, so it never caught this. These check
   * the half that differs.
   */
  it('never says a directory was inferred on a row that shows none', () => {
    for (const cmdline of [null, 'node', '"C:\\Program Files\\nodejs\\node.exe"']) {
      const field = inferWindowsCwd(cmdline);
      expect(field.source).toBe('unavailable');
      expect(field.value).toBeNull();
      expect(field.note).not.toMatch(/this is inferred/);
      expect(field.note).toMatch(/nothing to infer from|no absolute path to infer one from/);
    }
  });

  it('does say the directory was inferred when it produced one', () => {
    const field = inferWindowsCwd('node D:\\work\\api\\server.js');
    expect(field.source).toBe('inferred');
    expect(field.value).toBe('D:\\work\\api');
    expect(field.note).toMatch(/this is inferred from the command line/);
  });
});

describe('parseWindowsProcesses', () => {
  it('ignores rows without a usable pid', () => {
    const parsed = parseWindowsProcesses([
      { pid: Number.NaN, ppid: 1, name: 'x', exe: null, cmd: null, start: null },
      { pid: 10, ppid: 1, name: 'y', exe: null, cmd: 'y', start: null },
    ]);
    expect(parsed.map((p) => p.pid)).toEqual([10]);
  });

  it('drops a ppid of 0, which is the idle process rather than a parent', () => {
    const parsed = parseWindowsProcesses([{ pid: 10, ppid: 0, name: 'y', exe: null, cmd: 'y', start: null }]);
    expect(parsed[0]?.ppid).toBeNull();
  });

  it('throws a readable error when the payload is not JSON', () => {
    expect(() => parseWindowsPayload('not json')).toThrow(/could not parse the PowerShell output/);
  });
});

describe('buildServiceIndex', () => {
  it('keeps every service a single pid hosts', () => {
    const index = buildServiceIndex([
      { pid: 1128, name: 'SamSs', label: 'Security Accounts Manager' },
      { pid: 1128, name: 'EFS', label: 'Encrypting File System' },
      { pid: 1128, name: 'KeyIso', label: 'CNG Key Isolation' },
    ]);
    expect(index.get(1128)).toEqual(['EFS', 'KeyIso', 'SamSs']);
  });

  it('prefers the service key over the display name', () => {
    const index = buildServiceIndex([{ pid: 7, name: 'Dnscache', label: 'DNS Client' }]);
    expect(index.get(7)).toEqual(['Dnscache']);
  });

  it('falls back to the display name when the key is missing', () => {
    const index = buildServiceIndex([{ pid: 7, name: null, label: 'DNS Client' }]);
    expect(index.get(7)).toEqual(['DNS Client']);
  });

  it('drops rows that name nothing or belong to no running process', () => {
    const index = buildServiceIndex([
      { pid: 0, name: 'Stopped', label: 'Stopped' },
      { pid: -1, name: 'Nonsense', label: null },
      { pid: 9, name: '   ', label: '  ' },
    ]);
    expect(index.size).toBe(0);
  });
});
