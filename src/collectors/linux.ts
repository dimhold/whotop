import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { isMissingBinary, run } from './exec.js';
import {
  bindSocketsToPids,
  parseBootTimeSeconds,
  parseProcCgroup,
  parseProcCmdline,
  parseProcNetTable,
  parseProcStat,
  parseSs,
  socketInodeFromLink,
  startTimeFromTicks,
} from './parse/linux.js';
import type { ProcNetSocket } from './parse/linux.js';
import { exact, unavailable } from '../types.js';
import type {
  CollectResult,
  Collector,
  CollectorCapabilities,
  Field,
  PortBinding,
  RawProcess,
} from '../types.js';

const CAPABILITIES: CollectorCapabilities = {
  commandLine: 'full',
  cwd: 'partial',
  ports: 'full',
  user: 'full',
  notes: [
    'Everything about a process comes from /proc: cmdline, stat and the cwd symlink.',
    'The working directory of a process owned by another user is readable only as root, and shows as unavailable otherwise.',
    'Ports come from `ss -tulnp` when it is installed, otherwise from /proc/net/* joined to owners through the socket inodes under /proc/<pid>/fd.',
    'Start times assume USER_HZ is 100, which is the value on mainstream kernels.',
  ],
};

async function readUserMap(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const passwd = await readFile('/etc/passwd', 'utf8');
    for (const line of passwd.split('\n')) {
      const parts = line.split(':');
      const name = parts[0];
      const uid = Number.parseInt(parts[2] ?? '', 10);
      if (name && Number.isFinite(uid)) map.set(uid, name);
    }
  } catch {
    // No /etc/passwd (a minimal container, for instance). Uids stay numeric.
  }
  return map;
}

async function readCwd(pid: number): Promise<Field<string>> {
  try {
    return exact(await readlink(`/proc/${pid}/cwd`));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return unavailable('the working directory of another user\'s process is readable only as root');
    }
    return unavailable('the process exited while whotop was reading it');
  }
}

async function readPorts(warnings: string[]): Promise<PortBinding[]> {
  const ss = await run('ss', ['-tulnpH'], { timeoutMs: 10_000 });
  if (ss.ok && ss.stdout.trim() !== '') {
    const bindings = parseSs(ss.stdout);
    if (bindings.some((b) => b.pid !== null)) return bindings;
    warnings.push('`ss` did not report socket owners, which usually means it needs root. Ports are listed without a pid.');
    return bindings;
  }
  if (!isMissingBinary(ss) && ss.stderr.trim() !== '') {
    warnings.push(`\`ss\` failed (${ss.stderr.trim().split('\n')[0]}); falling back to /proc/net.`);
  }
  return readPortsFromProc(warnings);
}

async function readPortsFromProc(warnings: string[]): Promise<PortBinding[]> {
  const tables: Array<[string, 'tcp' | 'udp']> = [
    ['/proc/net/tcp', 'tcp'],
    ['/proc/net/tcp6', 'tcp'],
    ['/proc/net/udp', 'udp'],
    ['/proc/net/udp6', 'udp'],
  ];
  const sockets: ProcNetSocket[] = [];
  for (const [path, protocol] of tables) {
    try {
      sockets.push(...parseProcNetTable(await readFile(path, 'utf8'), protocol));
    } catch {
      // Some kernels are built without IPv6; a missing table is not an error.
    }
  }
  if (sockets.length === 0) return [];

  const inodeToPid = new Map<number, number>();
  let denied = 0;
  let entries: string[] = [];
  try {
    entries = await readdir('/proc');
  } catch {
    return bindSocketsToPids(sockets, inodeToPid);
  }
  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    if (!Number.isFinite(pid)) continue;
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      denied += 1;
      continue;
    }
    for (const fd of fds) {
      try {
        const inode = socketInodeFromLink(await readlink(`/proc/${pid}/fd/${fd}`));
        if (inode !== null && !inodeToPid.has(inode)) inodeToPid.set(inode, pid);
      } catch {
        // The descriptor closed underneath us.
      }
    }
  }
  if (denied > 0) {
    warnings.push(
      `Could not read the open descriptors of ${denied} processes, so some ports have no owner. Install \`ss\` or run as root for the full mapping.`,
    );
  }
  return bindSocketsToPids(sockets, inodeToPid);
}

export class LinuxCollector implements Collector {
  readonly platform = 'linux' as const;
  readonly capabilities = CAPABILITIES;

  async collect(): Promise<CollectResult> {
    const warnings: string[] = [];
    const users = await readUserMap();

    let bootSeconds: number | null = null;
    try {
      bootSeconds = parseBootTimeSeconds(await readFile('/proc/stat', 'utf8'));
    } catch {
      warnings.push('/proc/stat was not readable, so process ages are unavailable.');
    }

    const entries = await readdir('/proc');
    const processes: RawProcess[] = [];

    for (const entry of entries) {
      const pid = Number.parseInt(entry, 10);
      if (!Number.isFinite(pid) || String(pid) !== entry) continue;

      let statContent: string;
      try {
        statContent = await readFile(`/proc/${pid}/stat`, 'utf8');
      } catch {
        continue; // Exited between readdir and read.
      }
      const stats = parseProcStat(statContent);
      if (!stats) continue;

      let cmdline: Field<string>;
      try {
        const argv = parseProcCmdline(await readFile(`/proc/${pid}/cmdline`, 'utf8'));
        cmdline =
          argv.length > 0
            ? exact(argv.join(' '))
            : unavailable('a kernel thread has no command line of its own');
      } catch {
        cmdline = unavailable('the command line could not be read');
      }

      let exePath: string | null = null;
      try {
        exePath = await readlink(`/proc/${pid}/exe`);
      } catch {
        exePath = null;
      }

      let user: string | null = null;
      try {
        const info = await stat(`/proc/${pid}`);
        user = users.get(info.uid) ?? String(info.uid);
      } catch {
        user = null;
      }

      let services: string[] = [];
      try {
        services = parseProcCgroup(await readFile(`/proc/${pid}/cgroup`, 'utf8'));
      } catch {
        services = []; // The process exited, or this kernel exposes no cgroup file.
      }

      processes.push({
        pid,
        ppid: stats.ppid > 0 ? stats.ppid : null,
        name: stats.comm,
        exePath,
        commandLine: cmdline,
        cwd: await readCwd(pid),
        startedAt: bootSeconds === null ? null : startTimeFromTicks(bootSeconds, stats.startTicks),
        user,
        services,
      });
    }

    const ports = await readPorts(warnings);
    return { processes, ports, warnings };
  }
}
