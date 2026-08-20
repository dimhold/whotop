import { parseWindowsPayload, WINDOWS_CWD_NOTE } from './parse/windows.js';
import { failureReason, isMissingBinary, run } from './exec.js';
import type { RunOptions, RunResult } from './exec.js';
import type { CollectResult, Collector, CollectorCapabilities } from '../types.js';

/**
 * One PowerShell round trip returns the process table and the socket table as
 * a single JSON document. Two spawns would be two snapshots, and a port that
 * moved between them would be reported against the wrong process.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$warnings = New-Object System.Collections.ArrayList

try {
  $procs = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate |
    ForEach-Object {
      [pscustomobject]@{
        pid   = [int]$_.ProcessId
        ppid  = [int]$_.ParentProcessId
        name  = $_.Name
        exe   = $_.ExecutablePath
        cmd   = $_.CommandLine
        start = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
      }
    })
} catch {
  $procs = @()
  [void]$warnings.Add("Win32_Process query failed: " + $_.Exception.Message)
}

$ports = New-Object System.Collections.ArrayList
try {
  Get-NetTCPConnection -ErrorAction Stop | ForEach-Object {
    [void]$ports.Add([pscustomobject]@{
      addr  = [string]$_.LocalAddress
      port  = [int]$_.LocalPort
      state = [string]$_.State
      pid   = [int]$_.OwningProcess
      proto = 'tcp'
    })
  }
} catch {
  [void]$warnings.Add("Get-NetTCPConnection is unavailable, TCP ports were not read: " + $_.Exception.Message)
}
try {
  Get-NetUDPEndpoint -ErrorAction Stop | ForEach-Object {
    [void]$ports.Add([pscustomobject]@{
      addr  = [string]$_.LocalAddress
      port  = [int]$_.LocalPort
      state = 'listen'
      pid   = [int]$_.OwningProcess
      proto = 'udp'
    })
  }
} catch {
  [void]$warnings.Add("Get-NetUDPEndpoint is unavailable, UDP ports were not read.")
}

$services = New-Object System.Collections.ArrayList
try {
  Get-CimInstance Win32_Service -Property ProcessId,Name,DisplayName -ErrorAction Stop |
    Where-Object { $_.ProcessId -gt 0 } | ForEach-Object {
      [void]$services.Add([pscustomobject]@{
        pid   = [int]$_.ProcessId
        name  = [string]$_.Name
        label = [string]$_.DisplayName
      })
    }
} catch {
  [void]$warnings.Add("Win32_Service is unavailable, so service names were not read: " + $_.Exception.Message)
}

[pscustomobject]@{
  processes = @($procs)
  ports     = @($ports)
  services  = @($services)
  warnings  = @($warnings)
} | ConvertTo-Json -Depth 4 -Compress
`;

function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const CAPABILITIES: CollectorCapabilities = {
  commandLine: 'partial',
  cwd: 'none',
  ports: 'full',
  user: 'none',
  notes: [
    'Command lines come from Win32_Process. Processes owned by another user or running elevated withhold theirs unless whotop itself runs elevated.',
    WINDOWS_CWD_NOTE + '. Reading the real value would mean walking another process PEB with ReadProcessMemory, which whotop does not do.',
    'Ports come from Get-NetTCPConnection and Get-NetUDPEndpoint, both of which report the owning pid.',
    'Parent pids on Windows are not cleared when the parent dies and pid numbers are reused, so whotop compares start times before calling a process orphaned.',
    'Service names come from Win32_Service, which needs no elevation. This names many processes that withhold their command line: on a 433 process machine 17 of 29 such processes turned out to be services, among them a WireGuard tunnel and CloudflareWARP.',
  ],
};

/** How a shell is started. Injected so the fallbacks can be exercised off Windows. */
export type Runner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

export class WindowsCollector implements Collector {
  readonly platform = 'win32' as const;
  readonly capabilities = CAPABILITIES;

  /**
   * The shell is a constructor argument rather than a direct import so that
   * the part worth testing — which shell is tried, in what order, and what is
   * said when none of them start — can be tested anywhere. The PowerShell
   * script itself is a constant, and what it returns is covered by the
   * parser's fixtures.
   */
  constructor(private readonly exec: Runner = run) {}

  async collect(): Promise<CollectResult> {
    const encoded = encodeCommand(SCRIPT);
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];

    // Windows PowerShell first: it is present on every Windows since 7.
    // pwsh is the cross-platform one, and is only there if somebody
    // installed it, so it is the fallback rather than the preference.
    let result = await this.exec('powershell.exe', args, { timeoutMs: 30_000 });
    if (isMissingBinary(result)) {
      result = await this.exec('pwsh.exe', args, { timeoutMs: 30_000 });
    }
    if (isMissingBinary(result)) {
      throw new Error(
        'neither powershell.exe nor pwsh.exe could be started, so the Windows process table cannot be read',
      );
    }
    const text = result.stdout.trim();
    if (text === '') {
      throw new Error(`PowerShell returned nothing: ${failureReason(result)}`);
    }
    return parseWindowsPayload(text);
  }
}
