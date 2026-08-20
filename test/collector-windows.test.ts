/**
 * Which shell the Windows collector starts, and what it says when none will.
 *
 * The PowerShell script is a constant and what it returns is covered by the
 * parser's fixtures. What was never covered is the part around it: two shells
 * tried in a particular order for a particular reason, one round trip rather
 * than three, and the difference between "PowerShell is not here" and
 * "PowerShell ran and said nothing" — which are different problems and need to
 * read as different problems.
 *
 * The shell is injected. These run on any platform, which is the point: the
 * fallback logic is the piece a Linux contributor is most likely to break and
 * least able to try.
 */
import { describe, expect, it, vi } from 'vitest';
import { WindowsCollector } from '../src/collectors/windows.js';
import type { RunResult } from '../src/collectors/exec.js';

const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: '', error: null });

const missing = (): RunResult => ({
  ok: false,
  code: null,
  stdout: '',
  stderr: '',
  error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
});

const failed = (stderr: string): RunResult => ({
  ok: false,
  code: 1,
  stdout: '',
  stderr,
  error: new Error('exited 1'),
});

/** The smallest payload the parser accepts. */
const PAYLOAD = JSON.stringify({
  processes: [
    {
      pid: 9120,
      ppid: 6104,
      name: 'node.exe',
      exe: 'C:\\Program Files\\nodejs\\node.exe',
      cmd: 'node vite.js dev --port 4310',
      start: '2026-08-20T09:00:00.000Z',
    },
  ],
  ports: [{ addr: '::', port: 4310, state: 'Listen', pid: 9120, proto: 'tcp' }],
  services: [{ pid: 5684, name: 'WireGuardTunnel$Poland-2', label: 'WireGuard Tunnel' }],
  warnings: [],
});

describe('WindowsCollector', () => {
  it('says which platform it speaks for, and what it can see', () => {
    const collector = new WindowsCollector();
    expect(collector.platform).toBe('win32');
    expect(collector.capabilities.cwd).toBe('none');
    expect(collector.capabilities.ports).toBe('full');
  });

  /**
   * One round trip, not three. Two spawns would be two snapshots, and a port
   * that moved between them would be reported against the wrong process, which
   * is the mistake the whole tool exists to prevent.
   */
  it('asks once and gets everything back together', async () => {
    const exec = vi.fn(async (_command: string, _args: readonly string[]) => ok(PAYLOAD));
    const result = await new WindowsCollector(exec).collect();

    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.processes).toHaveLength(1);
    expect(result.ports).toHaveLength(1);
    expect(result.processes[0]?.services).toEqual([]);
  });

  it('starts Windows PowerShell first, since that is the one always installed', async () => {
    const exec = vi.fn(async (_command: string, _args: readonly string[]) => ok(PAYLOAD));
    await new WindowsCollector(exec).collect();

    expect(exec.mock.calls[0]?.[0]).toBe('powershell.exe');
  });

  /** The script goes over as base64 UTF-16, which is what -EncodedCommand takes. */
  it('hands the script over encoded, so no quoting can mangle it', async () => {
    const exec = vi.fn(async (_command: string, _args: readonly string[]) => ok(PAYLOAD));
    await new WindowsCollector(exec).collect();

    const args = exec.mock.calls[0]?.[1] as string[];
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
    expect(args).toContain('-EncodedCommand');

    const encoded = args[args.indexOf('-EncodedCommand') + 1] as string;
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(decoded).toContain('Get-CimInstance Win32_Process');
    expect(decoded).toContain('Get-NetTCPConnection');
    expect(decoded).toContain('Win32_Service');
  });

  /**
   * No part of a process name, path or command line reaches a command line.
   * The script is a constant, which is what makes the encoding safe rather
   * than merely convenient.
   */
  it('sends the same script every time, whatever the machine holds', async () => {
    const exec = vi.fn(async (_command: string, _args: readonly string[]) => ok(PAYLOAD));
    const collector = new WindowsCollector(exec);
    await collector.collect();
    await collector.collect();

    expect(exec.mock.calls[0]?.[1]).toEqual(exec.mock.calls[1]?.[1]);
  });

  describe('when powershell.exe is not there', () => {
    it('falls back to pwsh, which is the one somebody installed', async () => {
      const exec = vi.fn(async (command: string, _args: readonly string[]) => (command === 'powershell.exe' ? missing() : ok(PAYLOAD)));
      const result = await new WindowsCollector(exec).collect();

      expect(exec.mock.calls.map((call) => call[0])).toEqual(['powershell.exe', 'pwsh.exe']);
      expect(result.processes).toHaveLength(1);
    });

    it('gives up only when neither will start, and names both', async () => {
      const exec = vi.fn(async () => missing());
      await expect(new WindowsCollector(exec).collect()).rejects.toThrow(/powershell\.exe nor pwsh\.exe/);
    });

    /**
     * A shell that started and failed is a different problem from one that is
     * not installed, and trying the other shell would only hide it.
     */
    it('does not try the other shell when the first one ran and failed', async () => {
      const exec = vi.fn(async () => failed('Get-CimInstance : Access is denied'));
      const collector = new WindowsCollector(exec);

      await expect(collector.collect()).rejects.toThrow(/Access is denied/);
      expect(exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('when PowerShell answers with nothing', () => {
    it('says what it was told rather than fail on the empty string', async () => {
      const exec = vi.fn(async () => ({ ...ok(''), stderr: 'The term is not recognized' }));
      await expect(new WindowsCollector(exec).collect()).rejects.toThrow(/returned nothing.*not recognized/s);
    });

    it('has something to say even when there was no stderr either', async () => {
      const exec = vi.fn(async () => ok('   \n  '));
      await expect(new WindowsCollector(exec).collect()).rejects.toThrow(/returned nothing/);
    });
  });

  /**
   * Warnings come back from inside the script: a Get-NetTCPConnection that is
   * unavailable is reported as a limit rather than left as a silently empty
   * port table.
   */
  it('carries the warnings the script itself raised through to the report', async () => {
    const payload = JSON.stringify({
      processes: [],
      ports: [],
      services: [],
      warnings: ['Get-NetUDPEndpoint is unavailable, UDP ports were not read.'],
    });
    const result = await new WindowsCollector(async () => ok(payload)).collect();

    expect(result.warnings).toContain('Get-NetUDPEndpoint is unavailable, UDP ports were not read.');
  });

  it('joins service names onto the processes running them', async () => {
    const payload = JSON.stringify({
      processes: [{ pid: 5684, ppid: 800, name: 'svchost.exe', exe: null, cmd: null, start: null }],
      ports: [],
      services: [{ pid: 5684, name: 'WireGuardTunnel$Poland-2', label: 'WireGuard Tunnel' }],
      warnings: [],
    });
    const result = await new WindowsCollector(async () => ok(payload)).collect();

    expect(result.processes[0]?.services.join(' ')).toContain('WireGuardTunnel');
  });
});
