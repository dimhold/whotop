/**
 * Parsers for the Linux collector: /proc entries, `ss` output, and the
 * /proc/net/tcp fallback used when `ss` is not installed.
 */

import type { PortBinding, Protocol } from '../../types.js';

/**
 * The kernel reports process start time in clock ticks. USER_HZ has been 100
 * on every mainstream Linux build for a long time and there is no way to read
 * sysconf(_SC_CLK_TCK) from Node without a native addon, so whotop assumes
 * 100 and says so in the platform notes.
 */
export const USER_HZ = 100;

export interface ProcStat {
  readonly pid: number;
  readonly comm: string;
  readonly state: string;
  readonly ppid: number;
  /** Field 22: start time in clock ticks after boot. */
  readonly startTicks: number;
}

/**
 * /proc/<pid>/stat. The second field is the executable name in parentheses and
 * it may itself contain spaces and parentheses, so the split has to happen
 * after the LAST closing paren.
 */
export function parseProcStat(content: string): ProcStat | null {
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) return null;

  const pid = Number.parseInt(content.slice(0, open).trim(), 10);
  const comm = content.slice(open + 1, close);
  const rest = content.slice(close + 2).trim().split(/\s+/);
  if (!Number.isFinite(pid) || rest.length < 20) return null;

  const state = rest[0] ?? '';
  const ppid = Number.parseInt(rest[1] ?? '', 10);
  // rest[0] is field 3, so field 22 is rest[19].
  const startTicks = Number.parseInt(rest[19] ?? '', 10);

  return {
    pid,
    comm,
    state,
    ppid: Number.isFinite(ppid) ? ppid : 0,
    startTicks: Number.isFinite(startTicks) ? startTicks : 0,
  };
}

/** /proc/<pid>/cmdline is NUL separated, usually with a trailing NUL. */
export function parseProcCmdline(content: string): string[] {
  const parts = content.split('\0').filter((part) => part.length > 0);
  return parts;
}

/** btime line of /proc/stat: seconds since the epoch at boot. */
export function parseBootTimeSeconds(procStatContent: string): number | null {
  const match = /^btime\s+(\d+)$/m.exec(procStatContent);
  if (!match) return null;
  const value = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(value) ? value : null;
}

export function startTimeFromTicks(bootTimeSeconds: number, startTicks: number): Date {
  return new Date((bootTimeSeconds + startTicks / USER_HZ) * 1000);
}

const SS_STATES: Record<string, string> = {
  LISTEN: 'listen',
  UNCONN: 'listen',
  ESTAB: 'established',
  'TIME-WAIT': 'time-wait',
  'CLOSE-WAIT': 'close-wait',
  'SYN-SENT': 'syn-sent',
};

/** Split `1.2.3.4:80`, `[::]:80`, `*:80` into address and port. */
export function splitAddressPort(text: string): { address: string; port: number } | null {
  const cut = text.lastIndexOf(':');
  if (cut === -1) return null;
  let address = text.slice(0, cut);
  const portText = text.slice(cut + 1);
  const port = Number.parseInt(portText, 10);
  if (!Number.isFinite(port)) return null;
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  if (address === '*') address = '0.0.0.0';
  return { address, port };
}

/**
 * `ss -tulnp` output. The process column looks like
 * `users:(("node",pid=1234,fd=20),("node",pid=1235,fd=21))`
 * and is absent entirely when ss runs without the privileges to see owners.
 */
export function parseSs(output: string): PortBinding[] {
  const bindings: PortBinding[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (/^Netid\b/i.test(line) || /^State\b/i.test(line)) continue;

    const columns = line.split(/\s+/);
    if (columns.length < 5) continue;

    const netid = (columns[0] ?? '').toLowerCase();
    const protocol: Protocol = netid === 'udp' ? 'udp' : 'tcp';
    if (netid !== 'tcp' && netid !== 'udp') continue;

    const state = SS_STATES[(columns[1] ?? '').toUpperCase()] ?? (columns[1] ?? '').toLowerCase();
    const local = splitAddressPort(columns[4] ?? '');
    if (!local) continue;

    const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number.parseInt(m[1] ?? '', 10));
    if (pids.length === 0) {
      bindings.push({ protocol, address: local.address, port: local.port, state, pid: null });
      continue;
    }
    for (const pid of pids) {
      bindings.push({ protocol, address: local.address, port: local.port, state, pid });
    }
  }
  return bindings;
}

export interface ProcNetSocket {
  readonly protocol: Protocol;
  readonly address: string;
  readonly port: number;
  readonly state: string;
  readonly inode: number;
}

const TCP_STATES: Record<string, string> = {
  '01': 'established',
  '02': 'syn-sent',
  '03': 'syn-recv',
  '06': 'time-wait',
  '07': 'close',
  '08': 'close-wait',
  '0A': 'listen',
};

/** /proc/net/tcp writes IPv4 as little-endian hex, IPv6 as four hex words. */
export function decodeHexAddress(hex: string): string {
  if (hex.length === 8) {
    const bytes = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)];
    return bytes.map((b) => Number.parseInt(b, 16)).join('.');
  }
  if (hex.length === 32) {
    const words: string[] = [];
    for (let i = 0; i < 32; i += 8) {
      const group = hex.slice(i, i + 8);
      // Each 32-bit group is little endian within itself.
      const reordered = group.slice(6, 8) + group.slice(4, 6) + group.slice(2, 4) + group.slice(0, 2);
      words.push(reordered.slice(0, 4), reordered.slice(4, 8));
    }
    const full = words.map((w) => w.replace(/^0+(?=.)/, '').toLowerCase()).join(':');
    return full === '0:0:0:0:0:0:0:0' ? '::' : full;
  }
  return hex;
}

/** Parse /proc/net/tcp, tcp6, udp or udp6. */
export function parseProcNetTable(content: string, protocol: Protocol): ProcNetSocket[] {
  const sockets: ProcNetSocket[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('sl')) continue;
    const columns = line.split(/\s+/);
    if (columns.length < 10) continue;

    const local = columns[1] ?? '';
    const [hexAddr, hexPort] = local.split(':');
    if (!hexAddr || !hexPort) continue;

    const port = Number.parseInt(hexPort, 16);
    const inode = Number.parseInt(columns[9] ?? '', 10);
    if (!Number.isFinite(port) || !Number.isFinite(inode)) continue;

    const stCode = (columns[3] ?? '').toUpperCase();
    const state = protocol === 'udp' ? 'listen' : (TCP_STATES[stCode] ?? `state-${stCode.toLowerCase()}`);

    sockets.push({ protocol, address: decodeHexAddress(hexAddr), port, state, inode });
  }
  return sockets;
}

/** `socket:[22506]` is what /proc/<pid>/fd/<n> points at for a socket. */
export function socketInodeFromLink(target: string): number | null {
  const match = /^socket:\[(\d+)\]$/.exec(target.trim());
  if (!match) return null;
  const inode = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(inode) ? inode : null;
}

/** Join sockets to owners using the inode table built from /proc/<pid>/fd. */
export function bindSocketsToPids(
  sockets: readonly ProcNetSocket[],
  inodeToPid: ReadonlyMap<number, number>,
): PortBinding[] {
  return sockets.map((socket) => ({
    protocol: socket.protocol,
    address: socket.address,
    port: socket.port,
    state: socket.state,
    pid: inodeToPid.get(socket.inode) ?? null,
  }));
}

/**
 * Service and container names for a pid, read from /proc/<pid>/cgroup.
 *
 * This is the Linux answer to the same question Win32_Service answers on
 * Windows: what does the system itself call this process. It needs no
 * privileges, it is one small file read, and it works on processes whose
 * command line says nothing useful. Verified on a live server: a process whose
 * comm is plainly `node` reports `0::/system.slice/cron.service`, which names
 * the thing that launched it.
 *
 * Two cgroup layouts appear in the wild and both are handled:
 *   v2   `0::/system.slice/cron.service`
 *   v1   `12:pids:/system.slice/nginx.service`
 *
 * What is deliberately NOT reported as a service:
 *   - `user.slice` session scopes such as `session-10205.scope`. That is a
 *     login shell, not a service, and calling it one would be a wrong name
 *     stated confidently, which is the failure this tool exists to avoid.
 *   - bare `.slice` entries, which are groupings rather than units.
 */
export function parseProcCgroup(content: string): string[] {
  const found = new Set<string>();
  for (const line of content.split('\n')) {
    const path = line.trim().split(':').slice(2).join(':');
    if (!path) continue;
    for (const segment of path.split('/')) {
      if (segment === '') continue;
      const docker = /^(?:docker[-/])([0-9a-f]{12,64})(?:\.scope)?$/.exec(segment);
      const containerId = docker?.[1];
      if (containerId) {
        found.add(`docker:${containerId.slice(0, 12)}`);
        continue;
      }
      if (segment.endsWith('.service')) {
        found.add(segment.slice(0, -'.service'.length));
      }
    }
  }
  return [...found].sort();
}
