import { isMissingBinary, run } from './exec.js';
import { parseLsofCwd, parseLsofPorts, parsePs } from './parse/darwin.js';
import { exact, unavailable } from '../types.js';
import type { CollectResult, Collector, CollectorCapabilities, PortBinding, RawProcess } from '../types.js';
import { baseName } from '../cmdline.js';

const CAPABILITIES: CollectorCapabilities = {
  commandLine: 'full',
  cwd: 'partial',
  ports: 'full',
  user: 'full',
  notes: [
    'The process table comes from `ps -axwwo pid=,ppid=,user=,lstart=,command=`.',
    'Working directories come from `lsof -a -d cwd`. Without root, macOS discloses them only for your own processes.',
    'Ports come from `lsof -nP -iTCP -sTCP:LISTEN` and `lsof -nP -iUDP`, both of which report the owning pid.',
    'macOS has no /proc, so every value here is what the two helpers agreed to give.',
  ],
};

const CWD_DENIED = 'macOS discloses the working directory of another user\'s process only to root';

export class DarwinCollector implements Collector {
  readonly platform = 'darwin' as const;
  readonly capabilities = CAPABILITIES;

  async collect(): Promise<CollectResult> {
    const warnings: string[] = [];

    const ps = await run('ps', ['-axwwo', 'pid=,ppid=,user=,lstart=,command='], { timeoutMs: 20_000 });
    if (!ps.ok && ps.stdout.trim() === '') {
      throw new Error(`\`ps\` failed: ${ps.stderr.trim() || ps.error?.message || 'no output'}`);
    }
    const rows = parsePs(ps.stdout);

    const cwdByPid = await this.readCwds(warnings);
    const ports = await this.readPorts(warnings);

    const processes: RawProcess[] = rows.map((row) => {
      const cwd = cwdByPid.get(row.pid);
      const command = row.command.trim();
      return {
        pid: row.pid,
        ppid: row.ppid > 0 ? row.ppid : null,
        name: baseName((command.split(' ')[0] ?? '').trim()) || String(row.pid),
        exePath: command.split(' ')[0] ?? null,
        commandLine: command === '' ? unavailable('`ps` returned an empty command') : exact(command),
        cwd: cwd ? exact(cwd) : unavailable(CWD_DENIED),
        startedAt: row.startedAt,
        user: row.user || null,
        // macOS keeps this information in launchd and `launchctl list` exposes
        // it. Left empty rather than guessed: there is no macOS machine to
        // verify against yet, and an unverified name printed with confidence is
        // exactly the failure this tool exists to avoid.
        services: [],
      };
    });

    return { processes, ports, warnings };
  }

  private async readCwds(warnings: string[]): Promise<Map<number, string>> {
    const lsof = await run('lsof', ['-a', '-d', 'cwd', '-Fpn'], { timeoutMs: 20_000 });
    if (isMissingBinary(lsof)) {
      warnings.push('`lsof` is not installed, so no working directories could be read.');
      return new Map();
    }
    // lsof exits non-zero when it could not open some processes, and still
    // prints everything it did read, so stdout is used either way.
    if (lsof.stdout.trim() === '') {
      warnings.push('`lsof` returned no working directories. Run as root to see processes owned by other users.');
      return new Map();
    }
    return parseLsofCwd(lsof.stdout);
  }

  private async readPorts(warnings: string[]): Promise<PortBinding[]> {
    const tcp = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeoutMs: 20_000 });
    if (isMissingBinary(tcp)) {
      warnings.push('`lsof` is not installed, so ports could not be mapped to processes.');
      return [];
    }
    const bindings = parseLsofPorts(tcp.stdout, 'tcp');
    const udp = await run('lsof', ['-nP', '-iUDP', '-Fpn'], { timeoutMs: 20_000 });
    if (udp.stdout.trim() !== '') bindings.push(...parseLsofPorts(udp.stdout, 'udp'));
    return bindings;
  }
}
